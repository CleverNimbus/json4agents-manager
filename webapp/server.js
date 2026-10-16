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
 *   npm start -- --data-dir /path  # agents.json / hashes.json live elsewhere
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import { appDir, config, files } from './server/config.js';
import { agentsRouter } from './server/agentsApi.js';
import { changesRouter } from './server/changesApi.js';
import { fsRouter } from './server/fsApi.js';
import { hashRouter } from './server/hashApi.js';
import { settingsRouter } from './server/settingsApi.js';
import { stateRouter } from './server/stateApi.js';

const require = createRequire(import.meta.url);
const vueFile = require.resolve('vue/dist/vue.esm-browser.prod.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const app = express();
app.disable('x-powered-by');

/**
 * While the server only listens on loopback, reject requests that name another
 * host. Without this a page on the internet could talk to this server through
 * DNS rebinding and use its filesystem access.
 */
if (LOOPBACK_HOSTS.has(config.host)) {
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (!LOOPBACK_HOSTS.has(host)) return res.status(403).json({ error: `Unexpected Host header: ${req.headers.host}` });
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

app.get('/', (req, res) => res.sendFile(path.join(appDir, 'index.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(appDir, 'styles.css')));
app.use('/src', express.static(path.join(appDir, 'src')));

app.use(agentsRouter);
app.use(changesRouter);
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

app.listen(config.port, config.host, () => {
  console.log(`JSON Manager  ->  http://${config.host}:${config.port}`);
  console.log(`  data dir    : ${config.dataDir}`);
  console.log(`  agents      : ${files.agentsDir}/*.json`);
  console.log(`  schema      : ${files.schema}`);
  console.log(`  hashes      : ${files.hashes}`);
  if (config.browseRoot) console.log(`  browse root : ${config.browseRoot}`);
});