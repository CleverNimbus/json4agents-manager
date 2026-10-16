/**
 * Settings and workspace rules.
 *
 * The workspace folder and the git root are configured as a pair, and the pair
 * has rules that the browser only mirrors: the root must really be a git
 * repository, and the workspace folder must sit inside it. A half-filled pair is
 * refused rather than half applied.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, it } from 'node:test';

import { validateWorkspaceSettings } from '../webapp/server/settingsValidation.js';
import { readSettings, updateSettings } from '../webapp/server/settingsStore.js';
import { readState, rememberHashFolder, updateState } from '../webapp/server/stateStore.js';
import { readJson, tempDir, useDataFolder, write } from './helpers.js';

const exec = promisify(execFile);

let dir;
beforeEach(async () => {
  dir = await useDataFolder();
});

/**
 * A folder that really is a git repository.
 *
 * `cwd` is mandatory: without it `git init` would run wherever the test runner
 * happens to be, which once re-initialised the project repository itself.
 */
async function gitRepo(label = 'repo') {
  const root = await tempDir(label);
  await exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
  assert.ok(
    await fs
      .access(path.join(root, '.git'))
      .then(() => true, () => false),
    `git init did not create a repository in ${root}`,
  );
  return root;
}

describe('validateWorkspaceSettings', () => {
  it('accepts nothing configured', async () => {
    assert.deepEqual(await validateWorkspaceSettings({}), { valid: true, errors: [] });
    assert.deepEqual(await validateWorkspaceSettings({ workspaceFolder: '', gitRoot: '' }), {
      valid: true,
      errors: [],
    });
  });

  it('accepts the workspace folder being the git root itself', async () => {
    const root = await gitRepo();
    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: root, gitRoot: root });
    assert.equal(valid, true, JSON.stringify(errors));
  });

  it('accepts the workspace folder being a folder inside the git root', async () => {
    const root = await gitRepo();
    const inner = path.join(root, 'packages', 'app');
    await fs.mkdir(inner, { recursive: true });

    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: inner, gitRoot: root });
    assert.equal(valid, true, JSON.stringify(errors));
  });

  it('refuses a workspace folder outside the git root', async () => {
    const root = await gitRepo();
    const outside = await tempDir('outside');

    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: outside, gitRoot: root });
    assert.equal(valid, false);
    assert.equal(errors[0].field, 'workspaceFolder');
  });

  it('refuses a sibling folder that merely shares a name prefix', async () => {
    const parent = await tempDir('parent');
    const root = path.join(parent, 'project');
    const sibling = path.join(parent, 'project-other');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });

    const { valid } = await validateWorkspaceSettings({ workspaceFolder: sibling, gitRoot: root });
    assert.equal(valid, false, 'a prefix match is not "inside"');
  });

  it('refuses a git root with no .git in it', async () => {
    const plain = await tempDir('plain');
    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: plain, gitRoot: plain });
    assert.equal(valid, false);
    assert.match(errors.map((e) => e.message).join(' '), /no \.git/);
  });

  it('accepts a worktree, where .git is a file rather than a folder', async () => {
    const root = await gitRepo();
    await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
    await write(path.join(root, '.git'), 'gitdir: /somewhere/else\n');

    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: root, gitRoot: root });
    assert.equal(valid, true, JSON.stringify(errors));
  });

  it('refuses a git root that does not exist', async () => {
    const { valid, errors } = await validateWorkspaceSettings({
      workspaceFolder: '/tmp/nope-42',
      gitRoot: '/tmp/nope-42',
    });
    assert.equal(valid, false);
    assert.match(errors.map((e) => e.message).join(' '), /No such folder/);
  });

  it('refuses a git root that is a file', async () => {
    const parent = await tempDir('parent');
    const file = path.join(parent, 'a-file');
    await fs.writeFile(file, 'x');
    const { valid, errors } = await validateWorkspaceSettings({ workspaceFolder: parent, gitRoot: file });
    assert.equal(valid, false);
    assert.match(errors.map((e) => e.message).join(' '), /Not a folder/);
  });

  it('refuses half a pair, naming the field that is missing', async () => {
    const root = await gitRepo();

    const onlyWorkspace = await validateWorkspaceSettings({ workspaceFolder: root, gitRoot: '' });
    assert.equal(onlyWorkspace.valid, false);
    assert.deepEqual(onlyWorkspace.errors.map((e) => e.field), ['gitRoot']);

    const onlyRoot = await validateWorkspaceSettings({ workspaceFolder: '', gitRoot: root });
    assert.equal(onlyRoot.valid, false);
    assert.deepEqual(onlyRoot.errors.map((e) => e.field), ['workspaceFolder']);
  });

  it('ignores whitespace only values', async () => {
    assert.equal((await validateWorkspaceSettings({ workspaceFolder: '  ', gitRoot: '\t' })).valid, true);
  });
});

describe('settings.json', () => {
  it('starts empty and stamps a change time on write', async () => {
    const initial = await readSettings();
    assert.equal(initial.workspaceFolder, '');
    assert.equal(initial.gitRoot, '');
    assert.equal(initial.updatedAt, '');

    const saved = await updateSettings({ workspaceFolder: '/tmp/x', gitRoot: '/tmp/y' });
    assert.equal(saved.updatedAt !== '', true);
    assert.equal((await readSettings()).workspaceFolder, '/tmp/x');
  });

  it('trims what it stores', async () => {
    await updateSettings({ workspaceFolder: '  /tmp/x  ' });
    assert.equal((await readSettings()).workspaceFolder, '/tmp/x');
  });

  it('falls back to the defaults when the file is broken, instead of failing', async () => {
    await write(path.join(dir, 'settings.json'), '{ not json');
    assert.deepEqual(await readSettings(), { workspaceFolder: '', gitRoot: '', updatedAt: '' });
  });

  it('falls back to the defaults when the file holds the wrong shape', async () => {
    await write(path.join(dir, 'settings.json'), { workspaceFolder: { nope: true }, gitRoot: 42 });
    assert.deepEqual(await readSettings(), { workspaceFolder: '', gitRoot: '', updatedAt: '' });
  });

  it('keeps the fields it knows and drops the ones it does not', async () => {
    await write(path.join(dir, 'settings.json'), { gitRoot: '/tmp/y', surprise: 'gone' });
    const settings = await readSettings();
    assert.equal(settings.gitRoot, '/tmp/y');
    assert.equal(settings.surprise, undefined);
  });

  it('is a real file on disk, written atomically', async () => {
    await updateSettings({ workspaceFolder: '/tmp/x' });
    const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    assert.ok(raw.endsWith('}\n'));
    assert.deepEqual(JSON.parse(raw).workspaceFolder, '/tmp/x');
    assert.deepEqual(await readJson(path.join(dir, 'settings.json')).then((v) => Object.keys(v).sort()), [
      'gitRoot',
      'updatedAt',
      'workspaceFolder',
    ]);
  });
});

describe('state.json', () => {
  it('remembers the last hashed folder', async () => {
    assert.equal((await readState()).hashTab.lastFolder, '');
    await rememberHashFolder('/home/you/projects');
    assert.equal((await readState()).hashTab.lastFolder, '/home/you/projects');
  });

  it('does not rewrite the file when the folder has not changed', async () => {
    await rememberHashFolder('/home/you/projects');
    const file = path.join(dir, 'state.json');
    const before = await fs.stat(file);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await rememberHashFolder('/home/you/projects');
    const after = await fs.stat(file);

    assert.equal(after.mtimeMs, before.mtimeMs, 'repeated hashes of the same folder leave no trace');
  });

  it('trims and forgets an empty folder', async () => {
    await rememberHashFolder('  /home/you/projects  ');
    assert.equal((await readState()).hashTab.lastFolder, '/home/you/projects');
    await rememberHashFolder('   ');
    assert.equal((await readState()).hashTab.lastFolder, '');
  });

  it('falls back to the defaults when the file is broken', async () => {
    await write(path.join(dir, 'state.json'), 'nonsense');
    assert.deepEqual(await readState(), { hashTab: { lastFolder: '' } });
  });

  it('ignores a patch of the wrong type', async () => {
    await rememberHashFolder('/home/you/projects');
    await updateState({ hashTab: { lastFolder: 42 } });
    await updateState({ hashTab: 'nope' });
    await updateState(null);
    assert.equal((await readState()).hashTab.lastFolder, '/home/you/projects');
  });
});