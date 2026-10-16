/**
 * Hashing tab backend.
 *
 *   POST /api/hash   -> streams newline delimited JSON progress events
 *   GET  /api/hashes -> the current content of hashes.json
 *
 * The stream keeps the browser's "last file hashed" line in sync while the
 * server works, and closing the connection (the Cancel button) aborts the run.
 */
import { Router } from 'express';
import { files } from './config.js';
import { hashFolder } from './hashRunner.js';
import { saveHashRun } from './hashesStore.js';
import { readJsonFile } from './store.js';
import { resolveBrowsable } from './fsApi.js';

export const hashRouter = Router();

hashRouter.get('/api/hashes', async (req, res) => {
  const data = await readJsonFile(files.hashes, { folders: [], files: [], runs: [] });
  res.json({ file: files.hashes, data });
});

hashRouter.post('/api/hash', async (req, res) => {
  const { path: target, includeHidden = true, followSymlinks = false } = req.body ?? {};
  if (typeof target !== 'string' || target.trim() === '') {
    return res.status(400).json({ error: 'A folder path is required' });
  }

  // Resolve (and jail check) before any streaming starts, so failures can still
  // be reported as a normal HTTP error.
  let root;
  try {
    root = await resolveBrowsable(target);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  send({ type: 'start', root });

  try {
    const result = await hashFolder(
      root,
      { includeHidden: Boolean(includeHidden), followSymlinks: Boolean(followSymlinks) },
      send,
      controller.signal,
    );

    send({ type: 'writing' });
    const { changed, unchanged } = await saveHashRun(result);
    send({
      type: 'done',
      summary: {
        root: result.root,
        files: result.stats.files,
        folders: result.folders.length,
        bytes: result.stats.bytes,
        errors: result.stats.errors,
        errorList: result.errors.slice(0, 20),
        changed,
        unchanged,
        durationMs: result.durationMs,
        finishedAt: result.finishedAt,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) send({ type: 'cancelled' });
    else send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});