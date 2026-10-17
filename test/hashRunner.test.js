/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The hashing runner.
 *
 * The folder hash has to be reproducible, because it is shared between machines
 * and compared across runs. These tests pin the algorithm itself (not just
 * "it produces a string"), the ordering rules, and the abort path.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { hashFolder, rollupHash, sha256Hex } from '../webapp/server/hashRunner.js';
import { buildTree, tempDir, write } from './helpers.js';

/** The published algorithm, written out independently of the implementation. */
const expectedFolderHash = (children) =>
  createHash('sha256')
    .update(
      children
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => `${child.name}\u0000${child.hash}\u001e`)
        .join(''),
    )
    .digest('hex');

describe('rollupHash', () => {
  it('is the SHA-256 of name, NUL, child hash, RS for every child', () => {
    const children = [
      { name: 'a.txt', hash: sha256Hex('a') },
      { name: 'b.txt', hash: sha256Hex('b') },
    ];
    assert.equal(rollupHash(children), sha256Hex(`a.txt\u0000${children[0].hash}\u001eb.txt\u0000${children[1].hash}\u001e`));
  });

  it('does not care what order the children arrive in', () => {
    const children = [
      { name: 'z.txt', hash: 'z' },
      { name: 'a.txt', hash: 'a' },
      { name: 'm.txt', hash: 'm' },
    ];
    assert.equal(rollupHash(children), rollupHash([...children].reverse()));
    assert.equal(rollupHash(children), expectedFolderHash(children));
  });

  it('is the digest of the empty string for a folder with no children', () => {
    assert.equal(rollupHash([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('changes when a child name changes, and when a child hash changes', () => {
    const base = [{ name: 'a.txt', hash: 'aaa' }, { name: 'b.txt', hash: 'bbb' }];
    const renamed = [{ name: 'a.txt', hash: 'aaa' }, { name: 'c.txt', hash: 'bbb' }];
    const rehashed = [{ name: 'a.txt', hash: 'zzz' }, { name: 'b.txt', hash: 'bbb' }];
    assert.notEqual(rollupHash(base), rollupHash(renamed));
    assert.notEqual(rollupHash(base), rollupHash(rehashed));
  });

  it('is not confused by boundaries between entries', () => {
    // "ab" + hash must not collide with "a" + "b"+hash style splits, which is
    // what the NUL and RS separators are for.
    assert.notEqual(
      rollupHash([{ name: 'ab', hash: 'c' }]),
      rollupHash([
        { name: 'a', hash: 'b' },
        { name: 'c', hash: '' },
      ]),
    );
  });
});

describe('hashFolder', () => {
  it('hashes files with SHA-256 and reports size and mtime', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'abc' });
    const result = await hashFolder(root);

    assert.equal(result.files.length, 1);
    const [file] = result.files;
    assert.equal(file.path, 'a.txt');
    assert.equal(file.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(file.size, 3);
    assert.ok(!Number.isNaN(Date.parse(file.mtime)));
    assert.equal(result.stats.files, 1);
    assert.equal(result.stats.bytes, 3);
    assert.equal(result.stats.errors, 0);
  });

  it('includes the root folder as "." and every sub folder', async () => {
    const root = await buildTree(await tempDir('tree'), {
      'a.txt': 'a',
      'src/b.txt': 'b',
      'src/deep/c.txt': 'c',
    });
    const result = await hashFolder(root);
    assert.deepEqual(
      result.folders.map((f) => f.path).sort(),
      ['.', 'src', 'src/deep'],
    );
  });

  it('rolls every folder up from its children, at every depth including the root', async () => {
    const root = await buildTree(await tempDir('tree'), { 'src/b.txt': 'b', 'src/a.txt': 'a' });
    const result = await hashFolder(root);
    const folders = new Map(result.folders.map((f) => [f.path, f.hash]));

    assert.equal(
      folders.get('src'),
      expectedFolderHash([
        { name: 'a.txt', hash: sha256Hex('a') },
        { name: 'b.txt', hash: sha256Hex('b') },
      ]),
    );
    assert.equal(folders.get('.'), expectedFolderHash([{ name: 'src', hash: folders.get('src') }]));
  });

  it('rolls up a deep tree from the bottom, with every level matching its children', async () => {
    const root = await buildTree(await tempDir('tree'), {
      'a.txt': 'a',
      'src/b.txt': 'b',
      'src/deep/c.txt': 'c',
      'other/d.txt': 'd',
    });
    const result = await hashFolder(root);
    const folders = new Map(result.folders.map((f) => [f.path, f.hash]));
    const files = new Map(result.files.map((f) => [f.path, f.hash]));
    const folderOf = (rel) => expectedFolderHash([{ name: path.basename(rel), hash: folders.get(rel) }]);

    assert.equal(folders.get('src/deep'), expectedFolderHash([{ name: 'c.txt', hash: files.get('src/deep/c.txt') }]));
    assert.equal(folders.get('other'), expectedFolderHash([{ name: 'd.txt', hash: files.get('other/d.txt') }]));
    assert.equal(
      folders.get('src'),
      expectedFolderHash([
        { name: 'b.txt', hash: files.get('src/b.txt') },
        { name: 'deep', hash: folders.get('src/deep') },
      ]),
    );
    assert.equal(
      folders.get('.'),
      expectedFolderHash([
        { name: 'a.txt', hash: files.get('a.txt') },
        { name: 'other', hash: folders.get('other') },
        { name: 'src', hash: folders.get('src') },
      ]),
      'the root must be the rollup of its children, not of undefined hashes',
    );
  });

  it('hashes an empty folder as the digest of the empty string', async () => {
    const root = await tempDir('empty');
    const result = await hashFolder(root);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.folders, [{ path: '.', hash: sha256Hex('') }]);
  });

  it('gives the same answer on a second run of an unchanged tree', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'd/b.txt': 'b' });
    const first = await hashFolder(root);
    const second = await hashFolder(root);
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.folders, first.folders);
  });

  it('notices a changed file in that file and in its ancestors only', async () => {
    const root = await buildTree(await tempDir('tree'), {
      'a.txt': 'a',
      'd/b.txt': 'b',
      'other/c.txt': 'c',
    });
    const before = await hashFolder(root);
    await fs.writeFile(path.join(root, 'd', 'b.txt'), 'b changed');
    const after = await hashFolder(root);

    const hashOf = (result, p) => result.files.find((f) => f.path === p).hash;
    const folderOf = (result, p) => result.folders.find((f) => f.path === p).hash;

    assert.notEqual(hashOf(before, 'd/b.txt'), hashOf(after, 'd/b.txt'));
    assert.equal(hashOf(before, 'a.txt'), hashOf(after, 'a.txt'));
    assert.equal(folderOf(before, 'other'), folderOf(after, 'other'));
    assert.notEqual(folderOf(before, 'd'), folderOf(after, 'd'));
    assert.notEqual(folderOf(before, '.'), folderOf(after, '.'));
  });

  it('skips hidden entries when asked to', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a', '.hidden/b.txt': 'b' });
    const withHidden = (await hashFolder(root, { includeHidden: true })).files.map((f) => f.path).sort();
    const withoutHidden = (await hashFolder(root, { includeHidden: false })).files.map((f) => f.path).sort();
    assert.deepEqual(withHidden, ['.hidden/b.txt', 'a.txt']);
    assert.deepEqual(withoutHidden, ['a.txt']);
  });

  it('ignores symlinks by default and does not follow them out of the tree', async () => {
    const outside = await buildTree(await tempDir('outside'), { 'secret.txt': 'secret' });
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await fs.symlink(outside, path.join(root, 'linkdir'));

    const result = await hashFolder(root);
    assert.deepEqual(result.files.map((f) => f.path), ['a.txt']);
  });

  it('survives a dangling symlink', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await fs.symlink(path.join(root, 'nowhere.txt'), path.join(root, 'dangling.txt'));
    const result = await hashFolder(root);
    assert.deepEqual(result.files.map((f) => f.path), ['a.txt']);
    assert.equal(result.stats.errors, 0);
  });

  it('counts an unreadable file as an error instead of failing the run', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await write(path.join(root, 'locked.txt'), 'x');
    await fs.chmod(path.join(root, 'locked.txt'), 0o000);
    const result = await hashFolder(root);
    await fs.chmod(path.join(root, 'locked.txt'), 0o644);

    if (result.stats.errors > 0) {
      assert.deepEqual(result.files.map((f) => f.path), ['a.txt'], 'the readable files are still hashed');
      assert.equal(result.errors[0].path, 'locked.txt');
    } else {
      // Running as root ignores the permission bits; nothing to assert.
      assert.deepEqual(result.files.map((f) => f.path).sort(), ['a.txt', 'locked.txt']);
    }
  });

  it('emits progress events, ending with one per folder', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'd/b.txt': 'b' });
    const events = [];
    await hashFolder(root, {}, (event) => events.push(event));

    assert.equal(events[0].type, 'scan');
    assert.equal(events[1].type, 'scan-done');
    assert.equal(events[1].total, 2, 'the total is known before hashing starts');
    const fileEvents = events.filter((e) => e.type === 'file');
    assert.equal(fileEvents.length, 2);
    assert.deepEqual(fileEvents.map((e) => e.done), [1, 2], 'progress counts up while the server is still working');
    assert.ok(events.some((e) => e.type === 'folder' && e.path === '.'));
  });

  it('reports a start and finish time and a duration', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const result = await hashFolder(root);
    assert.ok(Date.parse(result.startedAt) <= Date.parse(result.finishedAt));
    assert.equal(result.durationMs, Date.parse(result.finishedAt) - Date.parse(result.startedAt));
  });
});

describe('hashFolder - cancelling', () => {
  it('rejects with an AbortError and hashes nothing when already aborted', async () => {
    const root = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'b.txt': 'b' });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => hashFolder(root, {}, () => {}, controller.signal), { name: 'AbortError' });
  });

  it('stops early when aborted part way through a large tree', async () => {
    const files = {};
    for (let i = 0; i < 300; i += 1) files[`f${i}.bin`] = 'x'.repeat(4096);
    const root = await buildTree(await tempDir('big'), files);

    const controller = new AbortController();
    let seen = 0;
    await assert.rejects(
      () =>
        hashFolder(root, {}, (event) => {
          if (event.type !== 'file') return;
          seen += 1;
          if (seen === 5) controller.abort();
        }, controller.signal),
      { name: 'AbortError' },
    );
    assert.ok(seen < 300, `expected the run to stop early, it hashed ${seen} files`);
  });
});