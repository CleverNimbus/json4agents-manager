/**
 * Shared test plumbing.
 *
 * Two rules the whole suite depends on:
 *
 *  1. **Never touch the real data folder.** Every test that reads or writes data
 *     gets a fresh directory under the OS temp dir and points the app at it with
 *     `setDataDir()`. Twice in this project's history a manual test wrote junk
 *     into the real `data/`; the suite must not be able to do the same.
 *  2. **Never assert against what the code happens to do.** Tests state the
 *     expected result first. When one fails, either the expectation or the code
 *     is wrong, and the code gets fixed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { setDataDir } from '../webapp/server/config.js';
import { resetSchemaCache } from '../webapp/server/validate.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.resolve(here, '..');
export const webappDir = path.join(repoDir, 'webapp');

const temps = [];

/** Create an empty temporary directory that is removed when the test file ends. */
export async function tempDir(label = 'jm') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  temps.push(dir);
  return dir;
}

after(async () => {
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Give the test an isolated data folder: schema copied from the real one,
 * agents/ created, and `config.dataDir` pointed at it.
 *
 * @param {{label?: string, agents?: object[]}} [options]
 */
export async function useDataFolder({ label = 'data', agents = [] } = {}) {
  const dir = await tempDir(label);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), path.join(dir, 'agents.schema.json'));
  for (const agent of agents) {
    await fs.writeFile(path.join(dir, 'agents', `${agent.code}.json`), `${JSON.stringify(agent, null, 2)}\n`);
  }
  return pointAt(dir);
}

/**
 * Point the app at an existing data folder. The schema cache has to be dropped
 * too, otherwise validation would keep using the previous folder's schema.
 */
export function pointAt(dir) {
  setDataDir(dir);
  resetSchemaCache();
  return dir;
}

/** A minimal record that satisfies $defs/agent. */
export const agent = (code, overrides = {}) => ({ code, name: `Agent ${code}`, phase: 1, ...overrides });

/** Write a file, creating parent folders. */
export async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** Build a directory tree from { 'rel/path': 'contents' }. */
export async function buildTree(root, files) {
  for (const [rel, content] of Object.entries(files)) await write(path.join(root, rel), content);
  return root;
}

/** Read a JSON file, failing loudly with the path when it cannot be parsed. */
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Names of the entries in a directory, sorted - for "what is on disk" checks. */
export async function listNames(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// --------------------------------------------------------------- HTTP client

/**
 * Start the app on an ephemeral port with the loopback Host guard disabled
 * (the test client sends a 127.0.0.1 host header, but keeping the guard out of
 * the way means a failure here is about the route, not about the header).
 *
 * @returns {Promise<{get, request, post, put, del, close, url}>}
 */
export async function startApp() {
  const { createApp } = await import('../webapp/server.js');
  const server = createApp({ host: '' }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const request = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, body: json, text };
  };

  return {
    url: base,
    request,
    get: (route) => request('GET', route),
    post: (route, body) => request('POST', route, body ?? {}),
    put: (route, body) => request('PUT', route, body ?? {}),
    del: (route) => request('DELETE', route),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Consume the NDJSON hash stream and collect the events.
 *
 * @param {string} base app URL
 * @param {string} target folder to hash
 * @param {{stopAfter?: number, timeoutMs?: number}} [options] stopAfter aborts the
 *   request once that many `file` events arrived, which is how the cancel path
 *   is exercised.
 */
export async function streamHash(base, target, { stopAfter = Infinity, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/hash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
    signal: controller.signal,
  });

  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let sawStop = false;

  const readDone = (async () => {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        events.push(JSON.parse(line));
        if (!sawStop && events.filter((e) => e.type === 'file').length >= stopAfter) {
          sawStop = true;
          controller.abort();
        }
      }
    }
  })();

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await readDone;
  } catch (err) {
    // An aborted stream is the expected outcome when stopAfter fired.
    if (!sawStop) throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ------------------------------------------------------- repository fixtures

/** Path of the file that remembers which folder is the data folder. */
export const dataFolderPointerFile = path.join(repoDir, 'data-location.json');

/**
 * Run `body` with `data-location.json` removed, and removed again afterwards.
 *
 * Pointing the app at a data folder writes that file in the repository root, so
 * a test must neither read a leftover from an earlier run nor leave one behind.
 *
 * This is also why the suite runs with --test-concurrency=1: the pointer lives in
 * the repository, so two test files touching it at the same time would race.
 */
export async function withDataFolderPointerPreserved(body) {
  let saved = null;
  try {
    saved = await fs.readFile(dataFolderPointerFile);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Start from a known state: the suite tests the default, so no pointer.
  await fs.rm(dataFolderPointerFile, { force: true });
  try {
    return await body();
  } finally {
    await fs.rm(dataFolderPointerFile, { force: true });
    if (saved) await fs.writeFile(dataFolderPointerFile, saved);
  }
}

/**
 * Import config.js in a child process with a given argv/env, and report the
 * data folder it resolved. Used for the precedence rules, which are decided once
 * at import time and cannot be re-imported in the same process.
 */
export async function resolvedDataDir({ argv = [], env = {} } = {}) {
  const script = `import(${JSON.stringify(path.join(webappDir, 'server', 'config.js'))})
    .then((m) => { console.log(JSON.stringify({ dataDir: m.config.dataDir, locked: m.config.dataDirLocked })); });`;
  // "dummy" fills argv[1] so config.js's parseArgs(process.argv.slice(2)) sees the
  // flags; without it node itself would swallow them as its own options.
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, 'dummy', ...argv], {
    cwd: repoDir,
    env: {
      ...process.env,
      JSONM_DATA_DIR: '',
      ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === null ? '' : String(v)])),
    },
  });
  return JSON.parse(stdout.trim());
}