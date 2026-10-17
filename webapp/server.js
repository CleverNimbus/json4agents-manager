/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * JSON Manager - local web app server.
 *
 * Serves the browser UI from webapp/ and exposes a small JSON API for the
 * agents file, the local folder explorer and the folder hashing runner.
 * Everything stays on this machine; the server binds to 127.0.0.1 by default.
 *
 *   npm start                      # http://127.0.0.1:8000
 *   npm start -- --port 9000       # different port
 *   npm start -- --root ~/projects # only browse/hash inside this folder
 *   npm start -- --data-dir /path  # the data folder lives elsewhere
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { appDir, config, files } from './server/config.js';
import { agentsRouter } from './server/agentsApi.js';
import { changesRouter } from './server/changesApi.js';
import { dataFolderRouter } from './server/dataFolderApi.js';
import { dependenciesRouter } from './server/dependenciesApi.js';
import { executionPlanRouter } from './server/executionPlanApi.js';
import { executionsRouter } from './server/executionsApi.js';
import { fsRouter } from './server/fsApi.js';
import { hashRouter } from './server/hashApi.js';
import { migrateLegacyHashes } from './server/hashesStore.js';
import { settingsRouter } from './server/settingsApi.js';
import { stateRouter } from './server/stateApi.js';

const require = createRequire(import.meta.url);
const vueFile = require.resolve('vue/dist/vue.esm-browser.prod.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Build the express app without starting a listener.
 *
 * Exported so the tests can mount it on an ephemeral port (`app.listen(0)`)
 * instead of starting a second server process; `npm start` goes through
 * startServer() below.
 *
 * @param {{ host?: string }} [options] `host: ''` skips the loopback guard,
 *   which the tests do not want because their Host header is not loopback.
 */
export function createApp({ host = config.host } = {}) {
  const app = express();
  app.disable('x-powered-by');

  /**
   * While the server only listens on loopback, reject requests that name another
   * host. Without this a page on the internet could talk to this server through
   * DNS rebinding and use its filesystem access.
   */
  if (LOOPBACK_HOSTS.has(host)) {
    app.use((req, res, next) => {
      const requestHost = (req.headers.host ?? '').split(':')[0];
      if (!LOOPBACK_HOSTS.has(requestHost)) {
        return res.status(403).json({ error: `Unexpected Host header: ${req.headers.host}` });
      }
      const origin = req.headers.origin;
      if (origin && !LOOPBACK_HOSTS.has(new URL(origin).hostname)) {
        return res.status(403).json({ error: `Cross origin requests are not allowed: ${origin}` });
      }
      return next();
    });
  }

  app.use(express.json({ limit: '32mb' }));

  // Vue 3 is served straight out of node_modules, so the browser app needs no
  // build step - index.html maps the bare specifier "vue" to this URL.
  app.get('/vendor/vue.esm-browser.prod.js', (req, res) => res.sendFile(vueFile));

  // Mermaid is shipped as a split ESM bundle: a core entry that imports
  // diagram chunks from a sibling `chunks/` folder. The importmap maps the
  // bare specifier "mermaid" to the core URL; serving the whole dist folder
  // makes the relative chunk imports resolve without a second route.
  const mermaidDir = path.join(appDir, '..', 'node_modules', 'mermaid', 'dist');
  app.use('/vendor/mermaid', express.static(mermaidDir));

  app.get('/', (req, res) => res.sendFile(path.join(appDir, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(appDir, 'styles.css')));
  app.use('/src', express.static(path.join(appDir, 'src')));

  app.use(agentsRouter);
  app.use(changesRouter);
  app.use(dataFolderRouter);
  app.use(dependenciesRouter);
  app.use(executionPlanRouter);
  app.use(executionsRouter);
  app.use(fsRouter);
  app.use(hashRouter);
  app.use(stateRouter);
  app.use(settingsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars -- express needs the 4 arg signature
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

/** Log the effective configuration, which is what you check when it misbehaves. */
function logConfiguration() {
  console.log(`JSON Manager  ->  http://${config.host}:${config.port}`);
  console.log(`  data dir    : ${config.dataDir}${config.dataDirLocked ? '  (fixed by --data-dir)' : ''}`);
  console.log(`  agents      : ${files.agentsDir}/*.json`);
  console.log(`  schema      : ${files.schema}`);
  console.log(`  hash runs   : ${files.hashesRunsDir}/*.json`);
  if (config.browseRoot) console.log(`  browse root : ${config.browseRoot}`);
}

export async function startServer() {
  const server = createApp().listen(config.port, config.host);
  await new Promise((resolve) => server.once('listening', resolve));
  logConfiguration();

  // One-shot conversion of the old single-file hashes.json into per-run files.
  // Failure must not stop the app: the legacy file simply stays where it is.
  try {
    const migrated = await migrateLegacyHashes();
    if (migrated) {
      console.log(
        `  migrated    : hashes.json -> ${migrated.runs} run file(s), ` +
          `${migrated.files} file + ${migrated.folders} folder entries (kept a backup: ${migrated.backup})`,
      );
    }
  } catch (err) {
    console.warn(`  could not migrate hashes.json: ${err.message}`);
  }

  return server;
}

// Only when run as the program (`npm start`), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}