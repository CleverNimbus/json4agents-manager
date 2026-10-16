/**
 * Switching the data folder, and the doctor that checks it.
 *
 * Switching is all-or-nothing and has to carry the schema along, because without
 * a schema nothing could be validated. The doctor is the read-only counterpart:
 * it has to notice the states that are valid JSON and still wrong, and exit
 * non-zero so it can gate a commit.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

import { readJson, repoDir, tempDir, useDataFolder, webappDir, withDataFolderPointerPreserved, write } from './helpers.js';

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

/** A data folder with a schema and three valid agents. */
async function healthyData(label = 'doctor') {
  const dir = await useDataFolder({ label });
  for (const code of ['AG-001', 'AG-002']) {
    await write(path.join(dir, 'agents', `${code}.json`), { code, name: code, phase: 1 });
  }
  return dir;
}

describe('PUT /api/data-folder', () => {
  it('moves the app to another folder, creating what it needs', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        const target = await tempDir('switch-target');
        const { status, body } = await api.put('/api/data-folder', { dataFolder: target });

        assert.equal(status, 200);
        assert.equal(body.dataDir, target);
        assert.deepEqual((await readJson(path.join(target, 'agents.schema.json'))).title, 'Agents', 'the schema came along');
        assert.ok((await fs.stat(path.join(target, 'agents'))).isDirectory());

        const { body: agents } = await api.get('/api/agents');
        assert.equal(agents.dir, path.join(target, 'agents'), 'every tab now reads the new folder');
      } finally {
        await api.close();
      }
    });
  });

  it('keeps a schema the new folder already has', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        const target = await tempDir('switch-own-schema');
        await write(path.join(target, 'agents.schema.json'), { title: 'Something else', $defs: { agent: {} } });

        await api.put('/api/data-folder', { dataFolder: target });
        assert.equal((await readJson(path.join(target, 'agents.schema.json'))).title, 'Something else');
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

  it('refuses a folder it cannot use and stays where it was', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { startApp } = await import('./helpers.js');
      const api = await startApp();
      try {
        const before = (await api.get('/api/data-folder')).resolved;
        const blocker = await tempDir('blocked');
        await fs.writeFile(path.join(blocker, 'agents'), 'I am a file, not a folder');

        const { status } = await api.put('/api/data-folder', { dataFolder: blocker });
        assert.equal(status, 400);
        assert.equal((await api.get('/api/data-folder')).resolved, before, 'the previous folder is still in use');
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

  it('reports a folder with nothing in it without failing', async () => {
    const dir = await tempDir('empty-doctor');
    const { code } = await doctor(dir);
    assert.equal(code, 1, 'a missing schema is an error');
    assert.match(areas(await findings(dir)).join('\n'), /agents\.schema\.json is missing/);
  });

  it('reports an agent whose code disagrees with its file name', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-777.json'), { code: 'AG-001', name: 'Impostor', phase: 1 });

    const list = await findings(dir);
    assert.ok(areas(list).some((line) => /AG-777\.json/.test(line) && /AG-001/.test(line)));
    assert.equal((await doctor(dir)).code, 1);
  });

  it('reports codes that collide ignoring case', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'ag-001.json'), { code: 'ag-001', name: 'Lower twin', phase: 1 });
    assert.ok(areas(await findings(dir)).some((line) => /collides with AG-001 ignoring case/.test(line)));
  });

  it('reports a broken agent file, naming it', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-004.json'), '{ not json');
    assert.ok(areas(await findings(dir)).some((line) => /^agents: .*JSON/.test(line)));
  });

  it('reports a record that does not match the schema, with the field', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-005.json'), { code: 'AG-005', name: 'Bad', phase: 'one' });
    assert.ok(areas(await findings(dir)).some((line) => /AG-005 does not match the schema/.test(line)));
  });

  it('reports a set valued field that holds a duplicate or is unsorted', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-006.json'), {
      code: 'AG-006',
      name: 'Messy',
      phase: 1,
      result_generated_files: ['b.txt', 'a.txt', 'a.txt'],
    });
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(warnings.some((m) => /result_generated_files contains duplicate entries/.test(m)));
    assert.ok(warnings.some((m) => /result_generated_files is not sorted/.test(m)));
  });

  it('reports an absolute or escaping path in an agent record', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-007.json'), {
      code: 'AG-007',
      name: 'Escaper',
      phase: 1,
      result_generated_files: ['/etc/passwd'],
      source_dependant_files: ['../outside.txt'],
    });
    const errors = areas(await findings(dir));
    assert.ok(errors.some((line) => /AG-007\.result_generated_files holds an absolute path/.test(line)));
    assert.ok(errors.some((line) => /AG-007\.source_dependant_files escapes the git root/.test(line)));
  });

  it('reports a parent that does not exist, as a warning', async () => {
    const dir = await healthyData();
    await write(path.join(dir, 'agents', 'AG-008.json'), { code: 'AG-008', name: 'Orphan', phase: 1, parent: 'NOPE' });
    const warnings = (await findings(dir)).filter((f) => f.level === 'warning').map((f) => f.message);
    assert.ok(warnings.some((m) => /parent "NOPE", which does not exist/.test(m)));
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
    await write(path.join(dir, 'settings.json'), { workspaceFolder: '/tmp' });
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