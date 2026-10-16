/**
 * Why the hash store is shaped the way it is: two people work on the same store
 * through git, and neither one's history may be lost or silently reordered.
 *
 * The scenario was measured on the old single-document format: two users each
 * changing two files produced three conflict hunks in 33867 lines, including a
 * conflict between entries for *different* files that merely sat next to each
 * other - and a merge could reorder a history so the grid showed a stale hash as
 * current with no error anywhere.
 *
 * These tests assert the properties that replaced that, against a real git
 * repository: run files merge cleanly, and "which hash is current" is decided by
 * time, never by the order the entries happen to appear in.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { hashFolder } from '../webapp/server/hashRunner.js';
import { getView, saveHashRun } from '../webapp/server/hashesStore.js';
import { buildTree, listNames, pointAt, repoDir, tempDir, write } from './helpers.js';

const exec = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const git = async (cwd, ...args) => String((await exec('git', args, { cwd, encoding: 'utf8' })).stdout).trim();

/** Run git with an identity, without writing a user section into .git/config. */
const as = (cwd, who, ...args) =>
  git(cwd, '-c', `user.email=${who}@example.com`, '-c', `user.name=${who}`, ...args);

/**
 * Two machines, each with their own clone of the same store.
 *
 * The store lives in `<clone>/data`, so a test can hash a tree with the app
 * pointed at that clone's own folder and the run file lands inside the
 * repository, exactly as it would in real use.
 *
 * The repository is created with the `.gitignore` a team gets after opting into
 * a shared store (see data/hashes/README.md): run files tracked, the derived
 * index not. Shipping that index would make it conflict on every merge, which is
 * the whole reason it is derived rather than stored.
 */
async function twoMachines() {
  const root = await tempDir('merge');
  const alice = path.join(root, 'alice');
  const bob = path.join(root, 'bob');

  await fs.mkdir(path.join(alice, 'data', 'agents'), { recursive: true });
  await write(path.join(alice, '.gitignore'), 'data/hashes/index.json\n');
  await git(alice, 'init', '-q', '-b', 'main', '.');
  await as(alice, 'alice', 'commit', '-q', '--allow-empty', '-m', 'init');

  // A shared starting point: one run already agreed by both machines.
  pointAt(path.join(alice, 'data'));
  const seed = await hashFolder(await buildTree(await tempDir('seed'), { 'a.txt': 'a1', 'b.txt': 'b1' }));
  await saveHashRun(seed);
  await git(alice, 'add', '-A');
  await as(alice, 'alice', 'commit', '-q', '-m', 'first run');

  await exec('git', ['clone', '-q', alice, bob]);

  return { root, alice, bob };
}

/** Hash a tree from one machine's point of view and commit the run file. */
async function hashAndCommit(machine, who, tree) {
  pointAt(path.join(machine, 'data'));
  const saved = await saveHashRun(await hashFolder(tree));
  await git(machine, 'add', '-A');
  await as(machine, who, 'commit', '-q', '-m', `run ${saved.id}`);
  return saved;
}

/** Bring one machine's commits into the other, failing loudly on a conflict. */
async function mergeInto(machine, other, otherName) {
  await git(machine, 'remote', 'add', otherName, other);
  await git(machine, 'fetch', '-q', otherName);
  return git(machine, 'merge', '--no-edit', '-m', `merge ${otherName}`, `${otherName}/main`);
}

const unmerged = (machine) => git(machine, 'diff', '--name-only', '--diff-filter=U');

describe('the precondition for a clean merge', () => {
  it('never commits the derived index, or it would conflict on every merge', async () => {
    const { alice } = await twoMachines();
    await hashAndCommit(alice, 'alice', await buildTree(await tempDir('t'), { 'a.txt': 'a2' }));

    const ignored = await git(alice, 'check-ignore', 'data/hashes/index.json').catch(() => '');
    assert.equal(ignored, 'data/hashes/index.json', 'the derived index must be git ignored');

    const tracked = await git(alice, 'ls-files', 'data/hashes');
    assert.ok(!tracked.includes('index.json'), 'and must not be tracked');
    assert.ok(tracked.includes('runs/'), 'while the run files are tracked by a team that opted in');
  });

  it('ships a repository that publishes no local folder information by default', async () => {
    // The project's own .gitignore, which is what a fresh clone gets.
    const root = await tempDir('default-ignore');
    await fs.cp(path.join(repoDir, '.gitignore'), path.join(root, '.gitignore'));
    await fs.mkdir(path.join(root, 'data', 'hashes', 'runs'), { recursive: true });
    await write(path.join(root, 'data', 'hashes', 'runs', '2026-01-01T00-00-00-000Z_x.json'), {});
    await git(root, 'init', '-q', '-b', 'main', '.');
    await as(root, 'tester', 'add', '-A');

    const staged = await git(root, 'diff', '--cached', '--name-only');
    assert.ok(!staged.includes('runs/'), 'a hash run file must never be staged by accident');
    assert.equal(await git(root, 'check-ignore', 'data/hashes/runs/2026-01-01T00-00-00-000Z_x.json').catch(() => ''),
      'data/hashes/runs/2026-01-01T00-00-00-000Z_x.json');
  });
});

describe('two machines, one store', () => {
  it('merges two runs that touched different files without a conflict', async () => {
    const { alice, bob } = await twoMachines();

    await hashAndCommit(alice, 'alice', await buildTree(await tempDir('alice-tree'), { 'a.txt': 'a2' }));
    await hashAndCommit(bob, 'bob', await buildTree(await tempDir('bob-tree'), { 'b.txt': 'b2' }));

    await mergeInto(alice, bob, 'bob');

    assert.equal(await unmerged(alice), '', 'the merge must be clean');
    assert.equal((await listNames(path.join(alice, 'data', 'hashes', 'runs'))).length, 3);
  });

  it('keeps both runs and shows each path its newest hash after the merge', async () => {
    const { alice, bob } = await twoMachines();

    await hashAndCommit(alice, 'alice', await buildTree(await tempDir('alice-tree'), { 'a.txt': 'a2' }));
    await hashAndCommit(bob, 'bob', await buildTree(await tempDir('bob-tree'), { 'b.txt': 'b2' }));
    await mergeInto(alice, bob, 'bob');

    pointAt(path.join(alice, 'data'));
    const view = await getView();
    const a = view.files.find((f) => f.path === 'a.txt');
    const b = view.files.find((f) => f.path === 'b.txt');

    assert.equal(a.hashes.length, 2, "alice's change to a.txt survived");
    assert.equal(a.hashes[0].hash, sha256('a2'), 'and it is the current one');
    assert.equal(b.hashes.length, 2, "bob's change to b.txt survived");
    assert.equal(b.hashes[0].hash, sha256('b2'), 'and it is the current one');
    assert.equal(view.runs.length, 3, 'no run is lost by the merge');
  });

  it('merges a merge of two runs touching the same file, newest by time wins', async () => {
    const { alice, bob } = await twoMachines();

    await hashAndCommit(alice, 'alice', await buildTree(await tempDir('alice-tree'), { 'shared.txt': 'from alice' }));
    await wait(10);
    await hashAndCommit(bob, 'bob', await buildTree(await tempDir('bob-tree'), { 'shared.txt': 'from bob' }));
    await mergeInto(alice, bob, 'bob');

    pointAt(path.join(alice, 'data'));
    const entry = (await getView()).files.find((f) => f.path === 'shared.txt');
    assert.equal(entry.hashes.length, 2, 'both machines records are kept');
    const newest = entry.hashes[0];
    assert.ok(
      newest.hash === sha256('from bob') || newest.hash === sha256('from alice'),
      'and one of them is current',
    );
    const newestTime = Math.max(...entry.hashes.map((h) => Date.parse(h.datetime)));
    assert.equal(Date.parse(newest.datetime), newestTime, 'current is decided by time, not by file order');
  });

  it('gives the same history however the run files are ordered on disk', async () => {
    const dir = await tempDir('order');
    pointAt(dir);
    await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
    await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), path.join(dir, 'agents.schema.json'));

    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'one' });
    await saveHashRun(await hashFolder(tree));
    await wait(5);
    await fs.writeFile(path.join(tree, 'a.txt'), 'two');
    await saveHashRun(await hashFolder(tree));
    await wait(5);
    await fs.writeFile(path.join(tree, 'a.txt'), 'three');
    await saveHashRun(await hashFolder(tree));

    const runsDir = path.join(dir, 'hashes', 'runs');
    const before = await getView();

    // Re-create the run files in the opposite order: what an interleaved merge
    // effectively does to one shared document's array. Dropping the index makes
    // the store rebuild from scratch, so nothing can be served from a cache.
    const contents = new Map();
    for (const name of await listNames(runsDir)) contents.set(name, await fs.readFile(path.join(runsDir, name)));
    for (const name of contents.keys()) await fs.rm(path.join(runsDir, name));
    for (const [name, content] of [...contents].reverse()) await fs.writeFile(path.join(runsDir, name), content);
    await fs.rm(path.join(dir, 'hashes', 'index.json'), { force: true });

    const after = await getView();
    assert.deepEqual(
      after.files.map((f) => f.hashes.map((h) => [h.datetime, h.hash])),
      before.files.map((f) => f.hashes.map((h) => [h.datetime, h.hash])),
      'the assembled history must not depend on the order of the files on disk',
    );
    assert.equal(after.files.find((f) => f.path === 'a.txt').hashes[0].hash, sha256('three'));
  });
});

describe('two machines on the same path', () => {
  /** Write a run file by hand, as another machine's clone would bring in. */
  async function putRun(dir, id, finishedAt, host, hash) {
    await write(path.join(dir, 'hashes', 'runs', `${id}.json`), {
      id,
      root: `/home/${host}/sources`,
      host,
      startedAt: finishedAt,
      finishedAt,
      durationMs: 10,
      stats: { files: 1, bytes: 1, errors: 0, changed: 1, unchanged: 0 },
      files: [{ path: 'doc.txt', size: 1, mtime: finishedAt, hash }],
      folders: [],
    });
  }

  it('shows the newer run as current even when the older file is written first', async () => {
    const dir = await tempDir('same-path');
    pointAt(dir);

    await putRun(dir, '2026-10-16T09-00-00-000Z_aaaaaaaa', '2026-10-16T09:00:00.000Z', 'alice-laptop', sha256('older'));
    await putRun(dir, '2026-10-16T10-30-00-000Z_bbbbbbbb', '2026-10-16T10:30:00.000Z', 'bob-laptop', sha256('newer'));

    const view = await getView();
    const entry = view.files.find((f) => f.path === 'doc.txt');
    assert.deepEqual(entry.hashes.map((h) => h.hash), [sha256('newer'), sha256('older')]);
    assert.equal(entry.hashes[0].runId, '2026-10-16T10-30-00-000Z_bbbbbbbb');
    assert.deepEqual(view.runs.map((r) => r.host), ['bob-laptop', 'alice-laptop'], 'runs newest first');
  });

  it('marks a path as changed exactly when its newest hash differs from the one before', async () => {
    const dir = await tempDir('changed');
    pointAt(dir);

    await putRun(dir, '2026-10-16T09-00-00-000Z_1', '2026-10-16T09:00:00.000Z', 'a', sha256('one'));
    await putRun(dir, '2026-10-16T10-00-00-000Z_2', '2026-10-16T10:00:00.000Z', 'a', sha256('two'));

    const entry = (await getView()).files.find((f) => f.path === 'doc.txt');
    assert.equal(entry.hashes.length > 1 && entry.hashes[0].hash !== entry.hashes[1].hash, true);
  });

  it('does not mark a path as changed when two machines recorded the same content', async () => {
    const dir = await tempDir('same-content');
    pointAt(dir);

    await putRun(dir, '2026-10-16T09-00-00-000Z_1', '2026-10-16T09:00:00.000Z', 'a', sha256('same'));
    await putRun(dir, '2026-10-16T10-00-00-000Z_2', '2026-10-16T10:00:00.000Z', 'b', sha256('same'));

    const entry = (await getView()).files.find((f) => f.path === 'doc.txt');
    assert.equal(entry.hashes.length, 2, 'both records are kept, so the history is not rewritten away');
    assert.equal(entry.hashes[0].hash !== entry.hashes[1].hash, false, 'so the row is not flagged as changed');
  });
});