/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * changesApi.js — GET /api/changes.
 *
 * The endpoint reports uncommitted git files. It needs workspace settings;
 * without them it returns { configured: false }. When configured, every row
 * carries `consumers` and `producers`: the agent codes whose declared inputs
 * / outputs cover the path, computed with the same folder/file overlap rule
 * the Agent Dependencies tab uses. A broken agent store must not stop the
 * listing, so the roles fall back to empty lists.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { updateSettings } from '../webapp/server/settingsStore.js';
import { agent, startApp, tempDir, useDataFolder, write } from './helpers.js';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd });

let api;

before(async () => {
  api = await startApp();
});

after(async () => {
  await api.close();
});

/** Two committed files that are both modified afterwards. */
async function workspace() {
  const root = await tempDir('changes-workspace');
  await git(root, 'init', '-q', '-b', 'main', '.');
  await write(path.join(root, 'src', 'a.js'), 'export default 1;\n');
  await write(path.join(root, 'notes.md'), 'one\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'first');
  await write(path.join(root, 'src', 'a.js'), 'export default 2;\n');
  await write(path.join(root, 'notes.md'), 'two\n');
  return root;
}

describe('GET /api/changes', () => {
  it('returns { configured: false } when no workspace is set', async () => {
    await useDataFolder({ label: 'changes' });
    const { status, body } = await api.get('/api/changes');
    assert.equal(status, 200);
    assert.equal(body.configured, false, 'without workspace settings the tab explains what to set');
  });

  it('stamps each row with the agents that produce or consume the path', async () => {
    const root = await workspace();
    await useDataFolder({
      label: 'changes',
      agents: [
        agent('AG-001', { result_generated_files: ['src/*'] }),
        agent('AG-002', { source_dependant_files: ['src/a.js'] }),
      ],
    });
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const { status, body } = await api.get('/api/changes');
    assert.equal(status, 200);
    assert.equal(body.configured, true);

    const byPath = new Map(body.files.map((file) => [file.path, file]));
    const js = byPath.get('src/a.js');
    assert.deepEqual(js.producers, ['AG-001'], 'src/* covers src/a.js');
    assert.deepEqual(js.consumers, ['AG-002'], 'src/a.js is an exact input');

    const notes = byPath.get('notes.md');
    assert.deepEqual(notes.producers, [], 'no agent generates notes.md');
    assert.deepEqual(notes.consumers, [], 'no agent reads notes.md');
  });

  it('answers with empty role lists when the agent store cannot be read', async () => {
    const root = await workspace();
    const dir = await useDataFolder({ label: 'changes' });
    await write(path.join(dir, 'agents', 'broken.json'), '{ not json');
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const { status, body } = await api.get('/api/changes');
    assert.equal(status, 200);
    for (const file of body.files) {
      assert.deepEqual(file.consumers, [], 'a broken agent file never stops the listing');
      assert.deepEqual(file.producers, []);
    }
  });
});
