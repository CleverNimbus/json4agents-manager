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

import { agent, buildTree, listNames, startApp, streamHash, tempDir, useDataFolder, write } from './helpers.js';

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

  it('adds the paths to result_generated_files and reports what was new', async () => {
    const { status, body } = await api.post('/api/agents/AG-001/link-files', {
      paths: ['src/a.js', 'src/b.js'],
    });
    assert.equal(status, 200);
    assert.deepEqual(body.added, ['src/a.js', 'src/b.js']);
    assert.equal(body.alreadyPresent, 0);
    assert.deepEqual(body.agent.result_generated_files, ['src/a.js', 'src/b.js']);
  });

  it('skips paths that are already listed', async () => {
    await api.post('/api/agents/AG-001/link-files', { paths: ['src/a.js'] });
    const { body } = await api.post('/api/agents/AG-001/link-files', { paths: ['src/a.js', 'src/c.js'] });

    assert.deepEqual(body.added, ['src/c.js']);
    assert.equal(body.alreadyPresent, 1);
    assert.deepEqual(body.agent.result_generated_files, ['src/a.js', 'src/c.js'], 'no duplicate entry');
  });

  it('keeps paths in the order they were given', async () => {
    const { body } = await api.post('/api/agents/AG-001/link-files', { paths: ['z.js', 'a.js'] });
    assert.deepEqual(body.agent.result_generated_files, ['z.js', 'a.js']);
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