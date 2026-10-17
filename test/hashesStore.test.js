/**
 * The hash store: one immutable file per run, plus a derived index.
 *
 * This is the module that replaced a single shared hashes.json, so the tests are
 * about the properties that made sharing safe:
 *
 *  - a run file is written once and never rewritten
 *  - a run file is a delta, so an unchanged tree records almost nothing
 *  - "which hash is current" is computed from the run files, newest first, and
 *    never read from the order entries happen to appear in
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { hashFolder } from '../webapp/server/hashRunner.js';
import {
  getIndex,
  getView,
  migrateLegacyHashes,
  readAllRuns,
  readBrokenRunFiles,
  rebuildIndex,
  saveHashRun,
} from '../webapp/server/hashesStore.js';
import { buildTree, listNames, readJson, tempDir, useDataFolder, write } from './helpers.js';

let dir;

beforeEach(async () => {
  dir = await useDataFolder({ label: 'hashes' });
});

const runsDir = () => path.join(dir, 'hashes', 'runs');
const runNames = () => listNames(runsDir());
const entryFor = (view, filePath) => view.files.find((f) => f.path === filePath);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const readRun = async (id) => readJson(path.join(runsDir(), `${id}.json`));
const sizeOf = async (file) => (await fs.stat(file)).size;
const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

/** Hash a folder and store the result, the way the Hashing tab does. */
async function run(root) {
  return saveHashRun(await hashFolder(root));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('saveHashRun', () => {
  it('writes exactly one run file, named after the run', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const saved = await run(tree);

    assert.deepEqual(await runNames(), [`${saved.id}.json`]);
    const stored = await readRun(saved.id);
    assert.equal(stored.id, saved.id);
    assert.equal(stored.root, tree);
    assert.equal(stored.host, os.hostname(), 'the run records which machine produced it');
  });

  it('records the paths that changed and nothing else', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'keep.txt': 'k' });
    await run(tree);

    await fs.writeFile(path.join(tree, 'a.txt'), 'a changed');
    const second = await run(tree);

    const stored = await readRun(second.id);
    assert.deepEqual(stored.files.map((f) => f.path), ['a.txt'], 'only the file that changed is in the delta');
    assert.deepEqual(stored.folders.map((f) => f.path), ['.'], 'the root rolls up, so it changed too');
  });

  it('writes a tiny run file for a tree where nothing changed', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    const second = await run(tree);

    const stored = await readRun(second.id);
    assert.deepEqual(stored.files, [], 'an unchanged file is not recorded again');
    assert.deepEqual(stored.folders, []);
    assert.equal(second.changed, 0);
    assert.ok(await sizeOf(path.join(runsDir(), `${second.id}.json`)) < 1024);
  });

  it('never rewrites a run file that already exists', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const first = await run(tree);
    const file = path.join(runsDir(), `${first.id}.json`);
    const before = await fs.readFile(file);

    await fs.writeFile(path.join(tree, 'a.txt'), 'changed');
    await run(tree);

    assert.deepEqual(await fs.readFile(file), before, 'an existing run file must be byte identical afterwards');
  });

  it('gives two runs with the same timestamp different ids', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const base = await hashFolder(tree);
    const stamp = '2026-10-16T19:04:31.469Z';

    const first = await saveHashRun(base);
    const second = await saveHashRun({ ...base, finishedAt: stamp, startedAt: stamp });

    assert.notEqual(first.id, second.id, 'two runs can never share a file name');
    assert.equal((await runNames()).length, 2);
    assert.ok(second.id.startsWith('2026-10-16T19-04-31-469Z'), 'the id carries the finish time, so it sorts');
  });

  it('counts what changed and what did not', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'b.txt': 'b' });
    const first = await run(tree);
    assert.equal(first.changed, 3, 'two files plus the root folder');

    const second = await run(tree);
    assert.equal(second.changed, 0);
    const stored = await readRun(second.id);
    assert.equal(stored.stats.changed, 0);
    assert.equal(stored.stats.unchanged, 3);
  });
});

describe('getView - assembled histories', () => {
  it('puts the newest hash first and the oldest last', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'one' });
    await run(tree);
    await wait(5);
    await fs.writeFile(path.join(tree, 'a.txt'), 'two');
    await run(tree);
    await wait(5);
    await fs.writeFile(path.join(tree, 'a.txt'), 'three');
    await run(tree);

    const entry = entryFor(await getView(), 'a.txt');
    assert.equal(entry.hashes.length, 3, 'three real changes, three hashes');
    assert.deepEqual(entry.hashes.map((h) => h.hash), [sha256('three'), sha256('two'), sha256('one')]);
    const times = entry.hashes.map((h) => h.datetime);
    assert.deepEqual([...times].sort().reverse(), times, 'timestamps descend');
  });

  it('orders runs newest first', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'one' });
    await run(tree);
    await wait(5);
    await run(tree);

    const finished = (await getView()).runs.map((r) => r.finishedAt);
    assert.deepEqual([...finished].sort().reverse(), finished);
  });

  it('breaks a tie on the same timestamp with the run id, so the order is total', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'one' });
    const base = await hashFolder(tree);
    const stamp = '2026-10-16T19:04:31.469Z';
    const file = (content) => [{ path: 'a.txt', size: 3, mtime: stamp, hash: sha256(content) }];

    const first = await saveHashRun({ ...base, finishedAt: stamp, files: file('one') });
    const second = await saveHashRun({ ...base, finishedAt: stamp, files: file('two') });

    const entry = entryFor(await getView(), 'a.txt');
    assert.equal(entry.hashes.length, 2);
    const winner = first.id > second.id ? first.id : second.id;
    assert.equal(entry.hashes[0].runId, winner, 'the higher run id wins, and it is the one shown as current');
  });

  it('reports the newest run as the source folder', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    const view = await getView();
    assert.equal(view.sourceFolder, tree);
    assert.equal(view.generated, view.runs[0].finishedAt);
  });

  it('is empty but usable before anything has been hashed', async () => {
    const view = await getView();
    assert.deepEqual(view.files, []);
    assert.deepEqual(view.folders, []);
    assert.deepEqual(view.runs, []);
  });

  it('carries size and mtime from the newest run that saw the file', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'abc' });
    await run(tree);
    await fs.writeFile(path.join(tree, 'a.txt'), 'abcdef');
    await run(tree);

    const entry = entryFor(await getView(), 'a.txt');
    assert.equal(entry.size, 6, 'size describes the newest observation');
  });

  it('keeps a path that no longer exists in the tree', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'gone.txt': 'a' });
    await run(tree);
    await fs.rm(path.join(tree, 'gone.txt'));
    await run(tree);

    assert.ok(entryFor(await getView(), 'gone.txt'), 'the history records what was seen, not a listing');
  });

  it('stores the hash once when two runs in a row saw the same content', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'same' });
    await run(tree);
    await wait(5);
    await run(tree);
    await wait(5);
    await run(tree);

    const entry = entryFor(await getView(), 'a.txt');
    assert.equal(entry.hashes.length, 1, '"1 hash" means the content changed once, not that it was scanned once');
  });
});

describe('the index', () => {
  it('is rebuilt from the run files when it is missing', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    await fs.rm(path.join(dir, 'hashes', 'index.json'), { force: true });

    const index = await getIndex();
    assert.equal(index.files.length, 1);
    assert.equal(index.runs.length, 1);
  });

  it('produces the same answer however many times it is rebuilt', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'd/b.txt': 'b' });
    await run(tree);
    await fs.writeFile(path.join(tree, 'a.txt'), 'changed');
    await run(tree);

    const first = await rebuildIndex();
    const second = await rebuildIndex();
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.folders, first.folders);
    assert.deepEqual(
      second.runs.map((r) => r.id),
      first.runs.map((r) => r.id),
    );
  });

  it('picks up a run file that appeared behind its back', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    assert.equal((await getView()).runs.length, 1);

    const id = '2099-01-01T00-00-00-000Z_ffffffff';
    await write(path.join(runsDir(), `${id}.json`), {
      id,
      root: tree,
      startedAt: '2099-01-01T00:00:00.000Z',
      finishedAt: '2099-01-01T00:00:00.000Z',
      durationMs: 1,
      stats: { files: 1, bytes: 1, errors: 0, changed: 1, unchanged: 0 },
      files: [{ path: 'a.txt', size: 1, mtime: '2099-01-01T00:00:00.000Z', hash: sha256('from the future') }],
      folders: [],
    });

    const view = await getView();
    assert.equal(view.runs.length, 2, 'a hand-added run file is not ignored');
    assert.equal(entryFor(view, 'a.txt').hashes[0].hash, sha256('from the future'));
  });

  it('skips a broken run file instead of losing the whole store', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    await write(path.join(runsDir(), 'garbage.json'), '{ not json');

    assert.equal((await readAllRuns()).length, 1);
    assert.equal((await getView()).files.length, 1, 'the readable run is still served');
    const broken = await readBrokenRunFiles();
    assert.deepEqual(broken.map((b) => b.file), ['garbage.json'], 'but the problem is reportable');
  });

  it('is written where the app expects it', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    assert.deepEqual(await listNames(path.join(dir, 'hashes')), ['index.json', 'runs']);
  });
});

describe('rebuildIndex', () => {
  it('rebuilds the index from the run files and answers the same as before', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'd/b.txt': 'b' });
    await run(tree);
    await fs.writeFile(path.join(tree, 'a.txt'), 'changed');
    await run(tree);

    const before = await getView();
    const index = await rebuildIndex();
    const after = await getView();

    assert.deepEqual(after.files, before.files, 'the served history is unchanged');
    assert.equal(index.files.length, 2);
    assert.equal(index.runs.length, 2);
  });

  it('replaces an index that was written by hand', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);

    const indexFile = path.join(dir, 'hashes', 'index.json');
    await write(indexFile, { version: 2, signature: 'stale', files: [{ path: 'ghost', history: [] }] });

    const index = await rebuildIndex();
    assert.ok(!index.files.some((f) => f.path === 'ghost'), 'the stale content is gone');
    assert.equal(index.files.length, 1);
    assert.notEqual(index.signature, 'stale');
  });

  it('rebuilds an index whose file version is older than this code', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);

    const indexFile = path.join(dir, 'hashes', 'index.json');
    const stale = await readJson(indexFile);
    await write(indexFile, { ...stale, version: 1 });

    const served = await getView();
    assert.equal(served.files.length, 1, 'an old index version is not trusted');
  });

  it('produces an empty index when there are no runs at all', async () => {
    const index = await rebuildIndex();
    assert.deepEqual(index.files, []);
    assert.deepEqual(index.folders, []);
    assert.deepEqual(index.runs, []);
    assert.equal(index.sourceFolder, '');
    assert.deepEqual(await getView().then((v) => v.files), [], 'and the served view is empty, not broken');
  });

  it('skips a damaged run file and says how many runs it could read', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    await write(path.join(runsDir(), 'garbage.json'), '{ not json');

    const result = await rebuildIndex();
    assert.equal(result.runs.length, 1);
    assert.deepEqual(result.broken.map((b) => b.file), ['garbage.json'], 'the damage is reported, not hidden');
  });

  it('never touches a run file', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);
    const before = new Map();
    for (const name of await runNames()) before.set(name, await fs.readFile(path.join(runsDir(), name)));

    await rebuildIndex();
    await rebuildIndex();

    for (const [name, content] of before) {
      assert.deepEqual(await fs.readFile(path.join(runsDir(), name)), content, `${name} must be byte identical`);
    }
    assert.deepEqual(await runNames(), [...before.keys()]);
  });

  it('leaves the run files alone even when every one of them is damaged', async () => {
    await write(path.join(runsDir(), 'garbage.json'), '{ not json');
    const result = await rebuildIndex();

    assert.deepEqual(result.files, []);
    assert.equal(result.broken.length, 1);
    assert.deepEqual(await runNames(), ['garbage.json'], 'the damaged file is still there to look at');
  });

  it('says how long it took and which folder it covers', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await run(tree);

    const result = await rebuildIndex();
    assert.equal(result.sourceFolder, tree);
    assert.ok(Date.parse(result.generatedAt) > 0);
    assert.equal(await exists(path.join(dir, 'hashes', 'index.json')), true, 'the index is written');
  });
});

describe('migrateLegacyHashes', () => {
  const stamp = (time) => ({ startedAt: time, finishedAt: time });

  /** A hashes.json in the format the old browser app produced. */
  const legacyDocument = () => ({
    sourceFolder: '/home/you/sources',
    generated: '2026-10-16T19:04:31.469Z',
    runs: [
      { root: '/home/you/sources', ...stamp('2026-10-16T18:55:13.525Z'), durationMs: 2992, files: 2, bytes: 300, errors: 0, changed: 2, unchanged: 0 },
      { root: '/home/you/sources', ...stamp('2026-10-16T18:56:47.919Z'), durationMs: 2000, files: 2, bytes: 300, errors: 0, changed: 0, unchanged: 2 },
      { root: '/home/you/sources', ...stamp('2026-10-16T19:04:31.469Z'), durationMs: 2000, files: 2, bytes: 300, errors: 0, changed: 1, unchanged: 1 },
    ],
    files: [
      {
        path: 'a.txt',
        size: 100,
        mtime: '2026-10-16T18:00:00.000Z',
        hashes: [
          { datetime: '2026-10-16T18:55:13.525Z', hash: sha256('a1') },
          { datetime: '2026-10-16T18:56:47.919Z', hash: sha256('a1') },
          { datetime: '2026-10-16T19:04:31.469Z', hash: sha256('a2') },
        ],
      },
      {
        path: 'b.txt',
        size: 200,
        mtime: '2026-10-16T18:00:00.000Z',
        hashes: [
          { datetime: '2026-10-16T18:55:13.525Z', hash: sha256('b1') },
          { datetime: '2026-10-16T18:56:47.919Z', hash: sha256('b1') },
        ],
      },
    ],
    folders: [{ path: '.', hashes: [{ datetime: '2026-10-16T18:55:13.525Z', hash: sha256('root1') }] }],
  });

  it('does nothing when there is no legacy file', async () => {
    assert.equal(await migrateLegacyHashes(), null);
  });

  it('converts the document into one run file per run, sorted by time', async () => {
    await write(path.join(dir, 'hashes.json'), legacyDocument());
    const result = await migrateLegacyHashes();

    assert.equal(result.runs, 3);
    const names = await runNames();
    assert.equal(names.length, 3);
    assert.deepEqual([...names].sort(), names, 'file names carry the timestamp so they sort');
  });

  it('keeps the original as a backup and stops reading it', async () => {
    await write(path.join(dir, 'hashes.json'), legacyDocument());
    await migrateLegacyHashes();

    assert.equal(await exists(path.join(dir, 'hashes.json')), false);
    assert.equal(await exists(path.join(dir, 'hashes.migrated.json')), true);
    assert.equal(await migrateLegacyHashes(), null, 'a second call is a no-op');
  });

  it('collapses the repeated hashes the old format could hold', async () => {
    await write(path.join(dir, 'hashes.json'), legacyDocument());
    await migrateLegacyHashes();

    const view = await getView();
    assert.deepEqual(entryFor(view, 'a.txt').hashes.map((h) => h.hash), [sha256('a2'), sha256('a1')]);
    assert.deepEqual(entryFor(view, 'b.txt').hashes.map((h) => h.hash), [sha256('b1')]);
  });

  it('marks converted runs and keeps a run that changed nothing', async () => {
    await write(path.join(dir, 'hashes.json'), legacyDocument());
    await migrateLegacyHashes();

    const runs = await readAllRuns();
    assert.equal(runs.length, 3, 'the scan that found nothing is still a run');
    assert.ok(runs.every((entry) => entry.legacy === true));
    const quiet = runs.find((entry) => entry.finishedAt === '2026-10-16T18:56:47.919Z');
    assert.deepEqual(quiet.files, [], 'and it holds no entries');
  });

  it('preserves the history order and the size of each file', async () => {
    await write(path.join(dir, 'hashes.json'), legacyDocument());
    await migrateLegacyHashes();

    const entry = entryFor(await getView(), 'a.txt');
    assert.deepEqual(
      entry.hashes.map((h) => h.datetime),
      ['2026-10-16T19:04:31.469Z', '2026-10-16T18:55:13.525Z'],
      'newest first, and the unchanged middle run contributes nothing',
    );
    assert.equal(entry.size, 100);
    assert.equal(entry.mtime, '2026-10-16T18:00:00.000Z');
  });

  it('keeps every recorded hash when the legacy entries cannot be attributed to a run', async () => {
    await write(path.join(dir, 'hashes.json'), {
      ...legacyDocument(),
      files: [
        {
          path: 'orphan.txt',
          size: 1,
          mtime: '2026-10-16T18:00:00.000Z',
          hashes: [{ datetime: '2020-01-01T00:00:00.000Z', hash: sha256('orphan') }],
        },
      ],
    });
    await migrateLegacyHashes();

    assert.deepEqual(entryFor(await getView(), 'orphan.txt').hashes.map((h) => h.hash), [sha256('orphan')]);
  });

  it('refuses to convert a document that is not a hash store', async () => {
    await write(path.join(dir, 'hashes.json'), { hello: 'world' });
    assert.equal(await migrateLegacyHashes(), null);
    assert.equal(await exists(path.join(dir, 'hashes.json')), true, 'the file is left alone');
  });

  it('refuses to convert a document with no runs to attribute entries to', async () => {
    await write(path.join(dir, 'hashes.json'), { files: [], folders: [] });
    assert.equal(await migrateLegacyHashes(), null);
  });
});