/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The HTTP API, over a real server on an ephemeral port.
 *
 * These are the routes the browser actually calls, so the assertions are about
 * what the UI sees: status codes, the shape of the payload, and the guarantee
 * that a half finished or cancelled hash run never writes anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { agent, buildTree, listNames, readJson, startApp, streamHash, tempDir, useDataFolder, write } from './helpers.js';

let api;
let dir;

before(async () => {
  api = await startApp();
});

after(async () => {
  await api.close();
});

beforeEach(async () => {
  dir = await useDataFolder();
});

const agentsDir = () => path.join(dir, 'agents');

describe('GET /api/agents', () => {
  it('lists records ordered by code and says whether the store is valid', async () => {
    await write(path.join(agentsDir(), 'AG-003.json'), agent('AG-003'));
    await write(path.join(agentsDir(), 'AG-001.json'), agent('AG-001'));
    await write(path.join(agentsDir(), 'AG-002.json'), agent('AG-002'));

    const { status, body } = await api.get('/api/agents');
    assert.equal(status, 200);
    assert.deepEqual(body.agents.map((a) => a.code), ['AG-001', 'AG-002', 'AG-003']);
    assert.equal(body.valid, true);
    assert.deepEqual(body.errors, []);
    assert.equal(body.dir, agentsDir());
  });

  it('reports a file whose code disagrees with its name instead of listing it', async () => {
    await write(path.join(agentsDir(), 'AG-777.json'), agent('AG-001', { name: 'Impostor' }));

    const { body } = await api.get('/api/agents');
    assert.deepEqual(body.agents, [], 'the impostor must not become a row');
    assert.equal(body.valid, false);
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].message, /AG-777\.json/);
    assert.match(body.errors[0].message, /AG-001/);
  });

  it('reports a schema violation with the field that is wrong', async () => {
    await write(path.join(agentsDir(), 'AG-001.json'), agent('AG-001', { phase: 'one' }));

    const { body } = await api.get('/api/agents');
    assert.equal(body.valid, false);
    assert.ok(body.errors.some((e) => e.path.includes('/phase')), JSON.stringify(body.errors));
  });
});

describe('GET /api/schema', () => {
  it('serves the schema the edit form is built from', async () => {
    const { status, body } = await api.get('/api/schema');
    assert.equal(status, 200);
    assert.equal(body.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(body.$defs.agent, 'the form needs $defs/agent');
  });
});

describe('GET /api/agent-dependencies', () => {
  it('returns every agent as a node and links the producers to the consumers', async () => {
    await api.post('/api/agents', {
      agent: agent('AG-001', { source_dependant_files: ['config/root.json'], result_generated_files: ['out/root.md'] }),
    });
    await api.post('/api/agents', {
      agent: agent('AG-002', { source_dependant_files: ['out/*'], result_generated_files: [] }),
    });

    const { status, body } = await api.get('/api/agent-dependencies');
    assert.equal(status, 200);
    assert.deepEqual(body.agents.map((n) => n.code), ['AG-001', 'AG-002']);
    assert.equal(body.edges.length, 1);
    assert.equal(body.edges[0].from, 'AG-001');
    assert.equal(body.edges[0].to, 'AG-002');
    assert.deepEqual(body.edges[0].via, [{ output: 'out/root.md', input: 'out/*' }]);
  });

  it('reports an empty graph when there are no agents', async () => {
    const { status, body } = await api.get('/api/agent-dependencies');
    assert.equal(status, 200);
    assert.deepEqual(body.agents, []);
    assert.deepEqual(body.edges, []);
  });
});

describe('execution-plan endpoints', () => {
  /**
   * Set up the bits the planner needs: one agent with a known output, and a
   * pair of synthetic hash runs that report that file as changed. Returns
   * nothing - the side effect is what matters.
   */
  const setupChangedRun = async () => {
    const runsDir = path.join(dir, 'hashes', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, '2026-01-01T00-00-00Z.json'),
      JSON.stringify({
        id: '2026-01-01T00-00-00Z',
        root: '/x', host: 'test',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
        durationMs: 1, stats: { files: 1, changed: 0, bytes: 0, errors: 0 },
        files: [{ path: 'out/root.md', hash: 'h1' }], folders: [],
      }),
    );
    await fs.writeFile(
      path.join(runsDir, '2026-01-01T00-05-00Z.json'),
      JSON.stringify({
        id: '2026-01-01T00-05-00Z',
        root: '/x', host: 'test',
        startedAt: '2026-01-01T00:05:00Z', finishedAt: '2026-01-01T00:05:00Z',
        durationMs: 1, stats: { files: 1, changed: 1, bytes: 0, errors: 0 },
        files: [{ path: 'out/root.md', hash: 'h2' }], folders: [],
      }),
    );
    await api.post('/api/hashes/rebuild-index', {});
  };

  beforeEach(async () => {
    await api.post('/api/agents', {
      agent: agent('AG-001', {
        source_dependant_files: ['config/root.json'],
        result_generated_files: ['out/root.md'],
      }),
    });
  });

  it('GET returns the empty plan when nothing is saved yet', async () => {
    const { status, body } = await api.get('/api/execution-plan');
    assert.equal(status, 200);
    assert.deepEqual(body.changedPaths, []);
    assert.deepEqual(body.steps, []);
  });

  it('POST /generate writes the plan to data/execution-plan.json', async () => {
    await setupChangedRun();

    const generated = await api.post('/api/execution-plan/generate', {});
    assert.equal(generated.status, 200);
    assert.equal(generated.body.steps.length, 1);
    assert.equal(generated.body.steps[0].code, 'AG-001');
    assert.equal(generated.body.steps[0].done, false);
    assert.deepEqual(generated.body.changedPaths, ['out/root.md']);
    assert.ok(typeof generated.body.generatedAt === 'string' && generated.body.generatedAt !== '');

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'execution-plan.json'), 'utf8'));
    assert.deepEqual(onDisk.changedPaths, generated.body.changedPaths);
    assert.equal(onDisk.steps.length, 1);
  });

  it('GET after generate returns the saved plan', async () => {
    await setupChangedRun();
    await api.post('/api/execution-plan/generate', {});
    const { body } = await api.get('/api/execution-plan');
    assert.equal(body.steps.length, 1);
    assert.equal(body.steps[0].code, 'AG-001');
  });

  it('PATCH toggles the done flag of a step and persists it', async () => {
    await setupChangedRun();
    await api.post('/api/execution-plan/generate', {});
    const patched = await api.request('PATCH', '/api/execution-plan', {
      steps: [{ code: 'AG-001', done: true }],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.steps[0].done, true);

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'execution-plan.json'), 'utf8'));
    assert.equal(onDisk.steps[0].done, true);
  });

  it('PATCH rejects a body that is not { steps: [...] }', async () => {
    const r = await api.request('PATCH', '/api/execution-plan', {});
    assert.equal(r.status, 400);
  });

  it('PATCH ignores codes that are not in the plan', async () => {
    await setupChangedRun();
    await api.post('/api/execution-plan/generate', {});
    const r = await api.request('PATCH', '/api/execution-plan', {
      steps: [{ code: 'AG-MISSING', done: true }],
    });
    assert.equal(r.status, 200);
    for (const step of r.body.steps) assert.equal(step.done, false);
  });
});

describe('POST /api/agents', () => {
  it('creates the file and answers 201', async () => {
    const { status, body } = await api.post('/api/agents', { agent: agent('AG-001', { name: 'First' }) });
    assert.equal(status, 201);
    assert.equal(body.file, path.join(agentsDir(), 'AG-001.json'));
    assert.deepEqual(await listNames(agentsDir()), ['AG-001.json']);
  });

  it('refuses a duplicate with 409', async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
    const { status } = await api.post('/api/agents', { agent: agent('AG-001') });
    assert.equal(status, 409);
    assert.deepEqual(await listNames(agentsDir()), ['AG-001.json'], 'nothing extra was written');
  });

  it('refuses a record that does not match the schema with 400 and the reason', async () => {
    const { status, body } = await api.post('/api/agents', { agent: agent('AG-001', { phase: 'one' }) });
    assert.equal(status, 400);
    assert.ok(body.errors.some((e) => e.path === '/phase'), JSON.stringify(body.errors));
    assert.deepEqual(await listNames(agentsDir()), [], 'nothing was written');
  });

  it('refuses a code that is not a valid file name', async () => {
    for (const code of ['../escape', 'a/b', '']) {
      const { status } = await api.post('/api/agents', { agent: agent(code) });
      assert.equal(status, 400, `expected ${JSON.stringify(code)} to be refused`);
    }
    assert.deepEqual(await listNames(agentsDir()), []);
  });

  it('refuses a body that is not an agent at all', async () => {
    for (const payload of [{}, { agent: null }, { agent: 'AG-001' }]) {
      assert.equal((await api.post('/api/agents', payload)).status, 400);
    }
  });
});

describe('PUT /api/agents/:code', () => {
  it('updates the record', async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
    const { status } = await api.put('/api/agents/AG-001', { agent: agent('AG-001', { notes: 'updated' }) });
    assert.equal(status, 200);

    const { body } = await api.get('/api/agents/AG-001');
    assert.equal(body.agent.notes, 'updated');
  });

  it('renames the file when the code changes', async () => {
    await api.post('/api/agents', { agent: agent('AG-001', { notes: 'keep' }) });
    const { status } = await api.put('/api/agents/AG-001', { agent: agent('AG-002', { notes: 'keep' }) });

    assert.equal(status, 200);
    assert.deepEqual(await listNames(agentsDir()), ['AG-002.json']);
    const { body } = await api.get('/api/agents/AG-002');
    assert.equal(body.agent.notes, 'keep');
  });

  it('answers 404 for a code that is not there', async () => {
    const { status } = await api.put('/api/agents/AG-404', { agent: agent('AG-404') });
    assert.equal(status, 404);
  });

  it('refuses a rename onto an existing code with 409', async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
    await api.post('/api/agents', { agent: agent('AG-002') });
    const { status } = await api.put('/api/agents/AG-001', { agent: agent('AG-002') });
    assert.equal(status, 409);
    assert.deepEqual(await listNames(agentsDir()), ['AG-001.json', 'AG-002.json']);
  });
});

describe('DELETE /api/agents/:code', () => {
  it('removes the file', async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
    const { status, body } = await api.del('/api/agents/AG-001');
    assert.equal(status, 200);
    assert.equal(body.deleted, 'AG-001');
    assert.deepEqual(await listNames(agentsDir()), []);
  });

  it('answers 404 the second time', async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
    await api.del('/api/agents/AG-001');
    assert.equal((await api.del('/api/agents/AG-001')).status, 404);
  });

  it('refuses a code that is not a valid file name', async () => {
    assert.equal((await api.del('/api/agents/..%2Fescape')).status, 400);
  });
});

describe('POST /api/agents/:code/link-files', () => {
  beforeEach(async () => {
    await api.post('/api/agents', { agent: agent('AG-001') });
  });

  it('saves the parent folders of the changed files, suffixed with "/*"', async () => {
    const { status, body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['src/a.js', 'docs/readme.md'],
    });
    assert.equal(status, 200);
    assert.deepEqual(body.added, ['src/*', 'docs/*']);
    assert.equal(body.alreadyPresent, 0);
    assert.deepEqual(body.agent.result_generated_files, ['src/*', 'docs/*']);

    const onDisk = JSON.parse(await fs.readFile(path.join(agentsDir(), 'AG-001.json'), 'utf8'));
    assert.deepEqual(onDisk.result_generated_files, ['src/*', 'docs/*'], 'the JSON file on disk holds the folder references');
  });

  it('collapses several files in the same folder into a single "folder/*" entry', async () => {
    const { body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['src/a.js', 'src/b.js'],
    });

    assert.deepEqual(body.added, ['src/*'], 'one entry per immediate folder, regardless of file count');
    assert.deepEqual(body.agent.result_generated_files, ['src/*']);
  });

  it('keeps different immediate folders as separate entries, even when nested', async () => {
    const { body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['src/a.js', 'src/sub/c.js'],
    });

    assert.deepEqual(body.added, ['src/*', 'src/sub/*'], 'a sub-folder is not covered by its parent');
    assert.deepEqual(body.agent.result_generated_files, ['src/*', 'src/sub/*']);
  });

  it('records a file at the git root as "./*"', async () => {
    const { body } = await api.post('/api/agents/AG-001/link-files', { paths: ['README.md'] });

    assert.deepEqual(body.added, ['./*']);
    assert.deepEqual(body.agent.result_generated_files, ['./*']);
  });

  it('skips folder entries that are already listed', async () => {
    await api.post('/api/agents/AG-001/link-files', { paths: ['src/a.js'] });
    const { body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['src/a.js', 'src/c.js', 'docs/r.md'],
    });

    assert.deepEqual(body.added, ['docs/*'], 'src/* was already there');
    assert.equal(body.alreadyPresent, 1, 'one distinct folder entry was already present');
    assert.deepEqual(body.agent.result_generated_files, ['src/*', 'docs/*']);
  });

  it('keeps folder entries in the order their files were first seen', async () => {
    const { body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['docs/z.js', 'src/a.js'],
    });

    assert.deepEqual(body.added, ['docs/*', 'src/*']);
    assert.deepEqual(body.agent.result_generated_files, ['docs/*', 'src/*']);
  });

  it('refuses a path that is absolute or escapes the git root', async () => {
    for (const bad of ['/etc/passwd', '../outside.txt', 'a/../../b.txt']) {
      const { status } = await api.post('/api/agents/AG-001/link-files', { paths: [bad] });
      assert.equal(status, 400, `expected ${bad} to be refused`);
    }
    const { body } = await api.get('/api/agents/AG-001');
    assert.equal(body.agent.result_generated_files, undefined, 'nothing was written');
  });

  it('refuses a body that is not a list of paths', async () => {
    for (const payload of [{}, { paths: 'src/a.js' }, { paths: [''] }, { paths: [null] }]) {
      assert.equal((await api.post('/api/agents/AG-001/link-files', payload)).status, 400);
    }
  });

  it('answers 404 for an agent that does not exist', async () => {
    const { status } = await api.post('/api/agents/AG-404/link-files', { paths: ['a.js'] });
    assert.equal(status, 404);
  });
});

describe('POST /api/hash', () => {
  it('streams a start, progress, and a summary that names the run file', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a', 'sub/b.txt': 'b' });
    const events = await streamHash(api.url, tree);

    assert.equal(events[0].type, 'start');
    assert.equal(events.at(-1).type, 'done');

    const fileEvents = events.filter((e) => e.type === 'file');
    assert.equal(fileEvents.length, 2, 'one event per file while the server is working');
    assert.deepEqual(fileEvents.map((e) => e.path).sort(), ['a.txt', 'sub/b.txt']);

    const summary = events.at(-1).summary;
    assert.equal(summary.root, tree);
    assert.equal(summary.files, 2);
    assert.equal(summary.changed, 4, 'two files plus the root folder and sub');
    assert.equal(summary.errors, 0);
    assert.ok(summary.runId, 'the summary says which run file was written');
    assert.ok(summary.runFile.endsWith(`${summary.runId}.json`));
    assert.ok(summary.durationMs >= 0);
  });

  it('writes exactly one run file, and a second identical run writes an empty one', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const first = await streamHash(api.url, tree);
    const second = await streamHash(api.url, tree);

    const names = await listNames(path.join(dir, 'hashes', 'runs'));
    assert.equal(names.length, 2, 'the run itself is always recorded');
    assert.equal(first.at(-1).summary.changed, 2);
    assert.equal(second.at(-1).summary.changed, 0, 'nothing changed the second time');
    assert.equal(second.at(-1).summary.unchanged, 2);
  });

  it('refuses a path that is not a folder with 400', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    const { status, body } = await api.post('/api/hash', { path: path.join(tree, 'a.txt') });
    assert.equal(status, 400);
    assert.match(body.error, /not a folder/i);
  });

  it('refuses a folder that does not exist with 404', async () => {
    const { status, body } = await api.post('/api/hash', { path: '/tmp/definitely-not-here-42' });
    assert.equal(status, 404);
    assert.match(body.error, /no such folder/i);
  });

  it('refuses an empty path before anything is written', async () => {
    const { status } = await api.post('/api/hash', { path: '   ' });
    assert.equal(status, 400);
    assert.deepEqual(await listNames(path.join(dir, 'hashes')), []);
  });

  it('writes nothing when the client disconnects mid-run', async () => {
    const files = {};
    for (let i = 0; i < 200; i += 1) files[`f${i}.bin`] = 'y'.repeat(8192);
    const tree = await buildTree(await tempDir('big'), files);

    const events = await streamHash(api.url, tree, { stopAfter: 3 });
    assert.ok(events.some((e) => e.type === 'file'), 'the run really started');

    assert.deepEqual(await listNames(path.join(dir, 'hashes')), [], 'a cancelled run leaves nothing behind');
  });
});

describe('POST /api/hashes/rebuild', () => {
  it('rebuilds the index from the run files and serves the same history', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await streamHash(api.url, tree);
    await fs.writeFile(path.join(tree, 'a.txt'), 'b');
    await streamHash(api.url, tree);

    const before = (await api.get('/api/hashes')).body.data;
    const indexFile = path.join(dir, 'hashes', 'index.json');
    const stored = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    await write(indexFile, { ...stored, files: [], folders: [], runs: [] });

    const { status, body } = await api.post('/api/hashes/rebuild');
    assert.equal(status, 200);
    assert.equal(body.runs, 2);
    assert.equal(body.files, 1);
    assert.equal(body.folders, 1);

    const after = (await api.get('/api/hashes')).body.data;
    assert.deepEqual(after.files, before.files, 'the history is back exactly as it was');
    assert.deepEqual(after.runs, before.runs);
  });

  it('reports which run files it could not read, and still serves the rest', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await streamHash(api.url, tree);
    await write(path.join(dir, 'hashes', 'runs', 'garbage.json'), '{ not json');

    const { body } = await api.post('/api/hashes/rebuild');
    assert.equal(body.runs, 1, 'the readable run is still counted');
    assert.equal(body.broken.length, 1);
    assert.equal(body.broken[0].file, 'garbage.json');

    const served = (await api.get('/api/hashes')).body.data;
    assert.equal(served.files.length, 1);
    assert.equal(served.broken.length, 1, 'and the damage is visible in the tab');
  });

  it('never modifies a run file', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await streamHash(api.url, tree);
    const runsDir = path.join(dir, 'hashes', 'runs');
    const before = new Map();
    for (const name of await listNames(runsDir)) before.set(name, await fs.readFile(path.join(runsDir, name)));

    await api.post('/api/hashes/rebuild');

    assert.deepEqual(await listNames(runsDir), [...before.keys()]);
    for (const [name, content] of before) {
      assert.deepEqual(await fs.readFile(path.join(runsDir, name)), content);
    }
  });

  it('is harmless on a store with nothing in it', async () => {
    const { status, body } = await api.post('/api/hashes/rebuild');
    assert.equal(status, 200);
    assert.equal(body.runs, 0);
    assert.deepEqual(body.broken, []);
    assert.equal((await api.get('/api/hashes')).body.data.runs.length, 0);
  });

  it('leaves the store usable when every run file is damaged', async () => {
    await write(path.join(dir, 'hashes', 'runs', 'garbage.json'), '{ not json');
    const { status, body } = await api.post('/api/hashes/rebuild');
    assert.equal(status, 200);
    assert.equal(body.runs, 0);
    assert.equal(body.broken.length, 1);

    const served = await api.get('/api/hashes');
    assert.equal(served.status, 200);
    assert.deepEqual(served.body.data.files, []);
  });
});

describe('GET /api/hashes', () => {
  it('serves the history assembled from the run files', async () => {
    const tree = await buildTree(await tempDir('tree'), { 'a.txt': 'a' });
    await streamHash(api.url, tree);
    await fs.writeFile(path.join(tree, 'a.txt'), 'b');
    await streamHash(api.url, tree);

    const { status, body } = await api.get('/api/hashes');
    assert.equal(status, 200);
    assert.equal(body.data.files.length, 1);
    assert.equal(body.data.files[0].hashes.length, 2, 'two real changes');
    assert.ok(body.data.runs.length === 2);
  });

  it('is usable before anything has been hashed', async () => {
    const { status, body } = await api.get('/api/hashes');
    assert.equal(status, 200);
    assert.deepEqual(body.data.files, []);
    assert.deepEqual(body.data.runs, []);
  });
});

describe('GET and PUT /api/state', () => {
  const lastFolder = async () => (await api.get('/api/state')).body.state.hashTab.lastFolder;

  it('remembers the last hashed folder', async () => {
    assert.equal(await lastFolder(), '');

    await api.put('/api/state', { hashTab: { lastFolder: '/home/you/projects' } });
    assert.equal(await lastFolder(), '/home/you/projects');
  });

  it('refuses a patch that is not the shape it expects, and changes nothing', async () => {
    await api.put('/api/state', { hashTab: { lastFolder: '/home/you/projects' } });

    for (const patch of [{ hashTab: null }, { hashTab: [] }, { hashTab: { lastFolder: 42 } }, []]) {
      const { status } = await api.put('/api/state', patch);
      assert.equal(status, 400, `expected ${JSON.stringify(patch)} to be refused`);
    }
    assert.equal(await lastFolder(), '/home/you/projects');
  });

  it('accepts an empty patch as a no-op', async () => {
    await api.put('/api/state', { hashTab: { lastFolder: '/home/you/projects' } });
    const { status } = await api.put('/api/state', {});
    assert.equal(status, 200);
    assert.equal(await lastFolder(), '/home/you/projects');
  });
});

describe('GET and PUT /api/settings', () => {
  const getCollection = async () => (await api.get('/api/settings')).body.settings.hashFolders;

  it('starts with an empty hash folder collection', async () => {
    assert.deepEqual(await getCollection(), []);
  });

  it('saves a hash folder collection and returns the trimmed list', async () => {
    const { status, body } = await api.put('/api/settings', { hashFolders: ['  /tmp/a  ', '/tmp/b'] });
    assert.equal(status, 200);
    assert.deepEqual(body.settings.hashFolders, ['/tmp/a', '/tmp/b']);
    assert.deepEqual(await getCollection(), ['/tmp/a', '/tmp/b']);
  });

  it('replaces the collection wholesale when the patch lists fewer entries', async () => {
    await api.put('/api/settings', { hashFolders: ['/tmp/a', '/tmp/b'] });
    const { body } = await api.put('/api/settings', { hashFolders: ['/tmp/c'] });
    assert.deepEqual(body.settings.hashFolders, ['/tmp/c']);
    assert.deepEqual(await getCollection(), ['/tmp/c']);
  });

  it('refuses a non-array hashFolders patch and leaves the file alone', async () => {
    await api.put('/api/settings', { hashFolders: ['/tmp/keep'] });
    for (const patch of [{ hashFolders: 'nope' }, { hashFolders: { 0: '/tmp/x' } }, { hashFolders: [1, 2, 3] }]) {
      const { status } = await api.put('/api/settings', patch);
      assert.equal(status, 400, `expected ${JSON.stringify(patch)} to be refused`);
    }
    assert.deepEqual(await getCollection(), ['/tmp/keep']);
  });

  it('strips nullish entries and trims the rest before persisting', async () => {
    const { status, body } = await api.put('/api/settings', { hashFolders: ['/tmp/a', null, '  /tmp/b  ', undefined] });
    assert.equal(status, 200);
    assert.deepEqual(body.settings.hashFolders, ['/tmp/a', '/tmp/b']);
  });

  it('writes to data/settings.json on disk', async () => {
    await api.put('/api/settings', { hashFolders: ['/tmp/disk'] });
    const onDisk = await readJson(path.join(dir, 'settings.json'));
    assert.deepEqual(onDisk.hashFolders, ['/tmp/disk']);
  });
});

describe('GET /api/fs', () => {
  it('lists a folder: directories first, then files with size and hidden flag', async () => {
    const tree = await buildTree(await tempDir('fs'), {
      'a.txt': 'hello',
      'sub/inner.txt': 'x',
      '.hidden': 'secret',
    });

    const { status, body } = await api.get(`/api/fs?path=${encodeURIComponent(tree)}`);
    assert.equal(status, 200);
    assert.equal(body.path, tree);
    assert.equal(body.parent, path.dirname(tree));
    assert.deepEqual(
      body.entries.map((entry) => entry.name),
      ['sub', '.hidden', 'a.txt'],
      'directories before files, then by name',
    );

    const sub = body.entries.find((entry) => entry.name === 'sub');
    assert.equal(sub.kind, 'directory');
    const hidden = body.entries.find((entry) => entry.name === '.hidden');
    assert.equal(hidden.kind, 'file');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.size, 'secret'.length);
    const file = body.entries.find((entry) => entry.name === 'a.txt');
    assert.equal(file.hidden, false);
    assert.equal(file.size, 'hello'.length);
  });

  it('falls back to the home folder when no path is given', async () => {
    const { status, body } = await api.get('/api/fs');
    assert.equal(status, 200);
    assert.equal(body.path, body.home, 'an empty path means the home folder');
    assert.ok(Array.isArray(body.entries));
  });

  it('answers 404 for a folder that does not exist', async () => {
    const { status, body } = await api.get(`/api/fs?path=${encodeURIComponent('/tmp/definitely-not-here-42')}`);
    assert.equal(status, 404);
    assert.match(body.error, /No such folder/);
  });

  it('answers 400 for a path that is not a folder', async () => {
    const tree = await buildTree(await tempDir('fs-file'), { 'a.txt': 'x' });
    const { status, body } = await api.get(`/api/fs?path=${encodeURIComponent(path.join(tree, 'a.txt'))}`);
    assert.equal(status, 400);
    assert.match(body.error, /Not a folder/);
  });

  it('answers 403, not 500, for a folder it cannot read', async () => {
    const locked = await tempDir('fs-locked');
    await fs.chmod(locked, 0o000);
    try {
      const { status, body } = await api.get(`/api/fs?path=${encodeURIComponent(locked)}`);
      assert.equal(status, 403, 'a permission error is a 403, never a bare 500');
      assert.match(body.error, /No permission to read/);
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });
});

describe('unknown routes', () => {
  it('answer 404 with a message instead of an HTML error page', async () => {
    const { status, body } = await api.get('/api/nope');
    assert.equal(status, 404);
    assert.match(body.error, /No route for GET/);
  });
});

describe('the loopback guard', () => {
  /**
   * fetch() refuses to set the Host header (it is a forbidden header), so the
   * guard is exercised over raw http, the way a real DNS rebinding attempt
   * would arrive.
   */
  const rawGet = (port, headers) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });

  it('refuses a request that names another host', async () => {
    const { createApp } = await import('../webapp/server.js');
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();

    try {
      const rebinding = await rawGet(port, { Host: 'evil.example.com' });
      assert.equal(rebinding.status, 403);
      assert.match(JSON.parse(rebinding.body).error, /Host header/);

      const loopback = await rawGet(port, { Host: `127.0.0.1:${port}` });
      assert.equal(loopback.status, 200, 'a loopback host is fine');

      const crossOrigin = await rawGet(port, { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example.com' });
      assert.equal(crossOrigin.status, 403);

      const ownOrigin = await rawGet(port, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` });
      assert.equal(ownOrigin.status, 200, 'the app may call itself');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});