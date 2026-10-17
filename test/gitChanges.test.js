/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Link Changes tab backend: what git reports as uncommitted inside the
 * workspace folder.
 *
 * Two things matter here. The parser has to handle git's NUL separated format,
 * including the second field a rename carries. And the listing has to be
 * filtered to files below the workspace folder that really exist - the result is
 * written into an agent record, so a directory or a path outside the workspace
 * must never get in.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, it } from 'node:test';

import { listUncommittedFiles, parsePorcelain } from '../webapp/server/gitChanges.js';
import { updateSettings } from '../webapp/server/settingsStore.js';
import { tempDir, useDataFolder, write } from './helpers.js';

const exec = promisify(execFile);

beforeEach(async () => {
  await useDataFolder();
});

const git = (cwd, ...args) => exec('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd });

describe('parsePorcelain', () => {
  it('reads status code and path', () => {
    const entries = parsePorcelain(' M src/a.js\0?? new.txt\0');
    assert.deepEqual(entries, [
      { code: ' M', path: 'src/a.js' },
      { code: '??', path: 'new.txt' },
    ]);
  });

  it('skips the old path that follows a rename', () => {
    const entries = parsePorcelain('R  new.txt\0old.txt\0 M other.js\0');
    assert.deepEqual(entries, [
      { code: 'R ', path: 'new.txt' },
      { code: ' M', path: 'other.js' },
    ]);
  });

  it('skips the source that follows a copy', () => {
    const entries = parsePorcelain('C  copy.js\0source.js\0');
    assert.deepEqual(entries, [{ code: 'C ', path: 'copy.js' }]);
  });

  it('keeps a path that itself contains a newline', () => {
    const entries = parsePorcelain('?? weird\nname.txt\0');
    assert.equal(entries[0].path, 'weird\nname.txt');
  });

  it('is empty for an empty repository', () => {
    assert.deepEqual(parsePorcelain(''), []);
  });
});

describe('listUncommittedFiles', () => {
  /** A repository with a committed file and the usual kinds of change. */
  async function workspace() {
    const root = await tempDir('workspace');
    await git(root, 'init', '-q', '-b', 'main', '.');
    await write(path.join(root, 'committed.txt'), 'one\n');
    await fs.mkdir(path.join(root, 'packages', 'app'), { recursive: true });
    await write(path.join(root, 'packages', 'app', 'index.js'), 'export default 1;\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'first');

    await write(path.join(root, 'committed.txt'), 'changed\n');
    await write(path.join(root, 'brand-new.txt'), 'new\n');
    await write(path.join(root, 'packages', 'app', 'extra.js'), 'export const x = 2;\n');
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
    await write(path.join(root, '.hidden', 'thing.txt'), 'hidden\n');
    return root;
  }

  it('says it is not configured until both settings are filled in', async () => {
    const root = await tempDir('configured');
    await git(root, 'init', '-q', '-b', 'main', '.');

    assert.deepEqual(await listUncommittedFiles(), { configured: false });

    await updateSettings({ workspaceFolder: root });
    assert.deepEqual(await listUncommittedFiles(), { configured: false }, 'half a pair is not configured');

    await updateSettings({ gitRoot: root });
    assert.equal((await listUncommittedFiles()).configured, true);
  });

  it('lists uncommitted files relative to the git root', async () => {
    const root = await workspace();
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const result = await listUncommittedFiles();
    assert.equal(result.configured, true);
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes('committed.txt'), 'a modified file');
    assert.ok(paths.includes('brand-new.txt'), 'an untracked file');
    assert.ok(paths.includes('packages/app/extra.js'), 'an untracked file in a sub folder');
    assert.ok(!paths.includes('committed.txt'.replace('committed.txt', 'packages/app/index.js')), 'committed files are not listed');
  });

  it('reports a useful status for each file', async () => {
    const root = await workspace();
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const byPath = new Map((await listUncommittedFiles()).files.map((f) => [f.path, f]));
    assert.equal(byPath.get('committed.txt').status, 'modified');
    assert.equal(byPath.get('brand-new.txt').status, 'untracked');
    assert.equal(byPath.get('committed.txt').size, Buffer.byteLength('changed\n'));
  });

  it('leaves out files above the workspace folder', async () => {
    const root = await workspace();
    const inner = path.join(root, 'packages', 'app');
    await updateSettings({ workspaceFolder: inner, gitRoot: root });

    const paths = (await listUncommittedFiles()).files.map((f) => f.path);
    assert.deepEqual(paths, ['packages/app/extra.js'], 'only what is below the workspace folder');
  });

  it('gives each file a path relative to the workspace as well as to the root', async () => {
    const root = await workspace();
    const inner = path.join(root, 'packages', 'app');
    await updateSettings({ workspaceFolder: inner, gitRoot: root });

    const [file] = (await listUncommittedFiles()).files;
    assert.equal(file.path, 'packages/app/extra.js', 'relative to the git root, which is what gets linked');
    assert.equal(file.workspacePath, 'extra.js', 'and relative to the workspace, for display');
  });

  it('leaves out deleted paths, which have nothing to link to', async () => {
    const root = await workspace();
    await fs.rm(path.join(root, 'committed.txt'));
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const result = await listUncommittedFiles();
    assert.ok(!result.files.some((f) => f.path === 'committed.txt'));
    assert.equal(result.hidden, 1, 'and counts it so the tab can say something was skipped');
  });

  it('lists a renamed file under its new name', async () => {
    const root = await workspace();
    await fs.rename(path.join(root, 'committed.txt'), path.join(root, 'renamed.txt'));
    await updateSettings({ workspaceFolder: root, gitRoot: root });

    const paths = (await listUncommittedFiles()).files.map((f) => f.path);
    assert.ok(paths.includes('renamed.txt'), paths.join(', '));
    assert.ok(!paths.includes('committed.txt'));
  });

  it('reports what it skipped when the workspace is inside a repository it cannot run in', async () => {
    const root = await workspace();
    await updateSettings({ workspaceFolder: path.join(root, 'packages', 'app'), gitRoot: root });
    await fs.rm(path.join(root, '.git'), { recursive: true, force: true });

    await assert.rejects(() => listUncommittedFiles(), /git status failed/);
  });
});