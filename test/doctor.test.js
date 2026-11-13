/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Switching the data folder, and the doctor that checks it.
 *
 * Agents are hand-written markdown in a folder of their own, so switching the
 * data folder only moves app state - the schema ships with the app. The doctor
 * is the read-only counterpart: it has to notice the states that are valid
 * JSON and still wrong, and exit non-zero so it can gate a commit.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

import { agent, agentMd, readJson, repoDir, tempDir, useDataFolder, webappDir, withDataFolderPointerPreserved, write } from './helpers.js';

const exec = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const doctor = async (dataDir, extra = []) => {
  try {
    const { stdout } = await exec(process.execPath, [path.join(webappDir, 'tools', 'doctor.js'), ...extra], {
      cwd: repoDir,
      env: { ...process.env, JSONM_DATA_DIR: dataDir },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
};

const findings = async (dataDir) => JSON.parse((await doctor(dataDir, ['--json'])).stdout).findings;
const areas = (list) => list.filter((f) => f.level === 'error').map((f) => `${f.area}: ${f.message}`);

/** A data folder whose settings point at two valid agent files. */
async function healthyData(label = 'doctor') {
  return useDataFolder({ label, agents: [agent('AG-001'), agent('AG-002')] });
}

describe('PUT /api/data-folder', () => {
  it('moves the app to another folder', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        const target = await tempDir('switch-target');
        const { status, body } = await api.put('/api/data-folder', { dataFolder: target });

        assert.equal(status, 200);
        assert.equal(body.dataDir, target);
        assert.equal((await api.get('/api/data-folder')).resolved, target, 'every tab now reads the new folder');
      } finally {
        await api.close();
      }
    });
  });

  it('goes back to the default with an empty value', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        await api.put('/api/data-folder', { dataFolder: await tempDir('somewhere') });
        const { status, body } = await api.put('/api/data-folder', { dataFolder: '' });
        assert.equal(status, 200);
        assert.equal(body.isDefault, true);
        assert.equal(body.value, '');
      } finally {
        await api.close();
      }
    });
  });

  it('refuses a value that is not a string', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        assert.equal((await api.put('/api/data-folder', { dataFolder: 42 })).status, 400);
      } finally {
        await api.close();
      }
    });
  });
});

describe('npm run doctor', () => {
  it('passes on a healthy data folder and exits 0', async () => {
    const dir = await healthyData();
    const { code, stdout } = await doctor(dir);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /No problems found|0 error\(s\)/);
  });

  it('reports an agents folder that does not exist', async () => {
    const dir = await tempDir('empty-doctor');
    await write(path.join(dir, 'settings.json'), { agentsFolder: path.join(dir, 'agents') });
    const { code } = await doctor(dir);
    assert.equal(code, 1, 'agents that cannot be read are an error');
    assert.match(areas(await findings(dir)).join('\n'), /agents folder does not exist/);
  });

  it('reports codes that collide ignoring case', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'ag-001.md'), agentMd(agent('ag-001')));
    assert.ok(areas(await findings(dir)).some((line) => /collides with AG-001 ignoring case/.test(line)));
  });

  it('reports a broken agent file, naming it', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-004.md'), '---\nexecution_mode: [oops\n---\nbody');
    const list = await findings(dir);
    assert.ok(list.some((f) => f.level === 'error' && f.detail === 'AG-004.md'), areas(list).join('\n'));
  });

  it('reports a record that does not match the schema, with the field', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-005.md'), agentMd(agent('AG-005', { execution_mode: 'sideways' })));
    const list = await findings(dir);
    assert.ok(
      list.some((f) => f.level === 'error' && f.detail === 'AG-005.md' && /does not match the agent schema/.test(f.message) && /execution_mode/.test(f.message)),
      areas(list).join('\n'),
    );
  });

  it('reports a run file that cannot be read', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'hashes', 'runs', 'garbage.json'), '{ not json');
    assert.ok(areas(await findings(dir)).some((line) => /Run file garbage\.json cannot be read/.test(line)));
  });

  it('reports a run holding an absolute path', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'hashes', 'runs', '2026-01-01T00-00-00-000Z_x.json'), {
      id: '2026-01-01T00-00-00-000Z_x',
      root: '/tmp/x',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      stats: { files: 1, bytes: 1, errors: 0, changed: 1, unchanged: 0 },
      files: [{ path: '/etc/shadow', hash: sha256('x') }],
      folders: [],
    });
    assert.ok(areas(await findings(dir)).some((line) => /holds an absolute path/.test(line)));
  });

  it('reports a history that repeats a hash', async () => {
    const dir = await healthyData();
    for (const [id, finishedAt] of [
      ['2026-01-01T00-00-00-000Z_1', '2026-01-01T00:00:00.000Z'],
      ['2026-01-02T00-00-00-000Z_2', '2026-01-02T00:00:00.000Z'],
    ]) {
      await write(path.join(dir, 'hashes', 'runs', `${id}.json`), {
        id,
        root: '/tmp/x',
        startedAt: finishedAt,
        finishedAt,
        durationMs: 1,
        stats: { files: 1, bytes: 1, errors: 0, changed: 1, unchanged: 0 },
        files: [{ path: 'steady.txt', hash: sha256('same') }],
        folders: [],
      });
    }
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(warnings.some((m) => /repeats a hash in its history/.test(m)));
  });

  it('reports a folder hash that does not match its children', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'hashes', 'runs', '2026-01-01T00-00-00-000Z_x.json'), {
      id: '2026-01-01T00-00-00-000Z_x',
      root: '/tmp/x',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      stats: { files: 1, bytes: 1, errors: 0, changed: 2, unchanged: 0 },
      files: [{ path: 'dir/f.txt', hash: sha256('f') }],
      folders: [{ path: 'dir', hash: sha256('not the rollup of f.txt') }],
    });
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(warnings.some((m) => /Folder dir does not match its children/.test(m)));
  });

  it('accepts a folder hash that really is the rollup of its children', async () => {
    const { rollupHash } = await import('../webapp/server/hashRunner.js');
    const dir = await healthyData();
    await write(path.join(dir, 'hashes', 'runs', '2026-01-01T00-00-00-000Z_x.json'), {
      id: '2026-01-01T00-00-00-000Z_x',
      root: '/tmp/x',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      stats: { files: 1, bytes: 1, errors: 0, changed: 2, unchanged: 0 },
      files: [{ path: 'dir/f.txt', hash: sha256('f') }],
      folders: [{ path: 'dir', hash: rollupHash([{ name: 'f.txt', hash: sha256('f') }]) }],
    });
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(!warnings.some((m) => /does not match its children/.test(m)), warnings.join('; '));
  });

  it('points out a leftover legacy hashes.json and the migration backup', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'hashes.json'), { runs: [] });
    await write(path.join(dir, 'hashes.migrated.json'), { runs: [] });

    const notes = (await findings(dir)).map((f) => f.message);
    assert.ok(notes.some((m) => /legacy hashes\.json is still present/.test(m)));
    assert.ok(notes.some((m) => /pre-migration hashes\.json backup is still here/.test(m)));
  });

  it('reports incomplete workspace settings', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'settings.json'), { workspaceFolder: '/tmp', agentsFolder: path.join(dir, 'agents') });
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(warnings.some((m) => /workspace settings are incomplete/.test(m)));
  });

  it('says which folder it looked at, and can be read as JSON', async () => {
    const dir = await healthyData();
    const report = JSON.parse((await doctor(dir, ['--json'])).stdout);
    assert.equal(report.dataDir, dir);
    assert.equal(report.agents, 2);
    assert.ok(Array.isArray(report.findings));
  });
});

after(async () => {
  const pointer = await readJson(dataFolderPointerPath()).catch(() => null);
  assert.equal(pointer, null, 'a test left data-location.json behind');
});

const dataFolderPointerPath = () => path.join(repoDir, 'data-location.json');