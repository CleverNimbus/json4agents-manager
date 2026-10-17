/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Hashing tab backend.
 *
 *   POST /api/hash   -> streams newline delimited JSON progress events
 *   GET  /api/hashes -> the history assembled from the hash run files
 *   POST /api/hashes/rebuild -> discard and rebuild the derived index
 *
 * The stream keeps the browser's "last file hashed" line in sync while the
 * server works, and closing the connection (the Cancel button) aborts the run.
 */
import { Router } from 'express';
import { files } from './config.js';
import { hashFolder } from './hashRunner.js';
import { getView, rebuildIndex, saveHashRun } from './hashesStore.js';
import { resolveBrowsable } from './fsApi.js';

export const hashRouter = Router();

hashRouter.get('/api/hashes', async (req, res) => {
  res.json({ file: files.hashesDir, data: await getView() });
});

/**
 * Discard the derived index and rebuild it from the run files.
 *
 * The index is a cache, so this is always safe: only `index.json` is written, and
 * a run file - the one thing in the store that cannot be regenerated - is never
 * touched. Damaged run files are skipped and reported in `broken` rather than
 * dropped silently.
 */
hashRouter.post('/api/hashes/rebuild', async (req, res) => {
  const index = await rebuildIndex();
  return res.json({
    ok: true,
    index: files.hashesIndex,
    generatedAt: index.generatedAt,
    runs: index.runs.length,
    files: index.files.length,
    folders: index.folders.length,
    broken: index.broken,
  });
});

hashRouter.post('/api/hash', async (req, res) => {
  const { path: target, includeHidden = false, followSymlinks = false } = req.body ?? {};
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
    const saved = await saveHashRun(result);
    send({
      type: 'done',
      summary: {
        root: result.root,
        files: result.stats.files,
        folders: result.folders.length,
        bytes: result.stats.bytes,
        errors: result.stats.errors,
        errorList: result.errors.slice(0, 20),
        // Delta runs only record what changed; everything else is already in
        // an earlier run file.
        changed: saved.changed,
        unchanged: Math.max(0, result.stats.files + result.folders.length - saved.changed),
        runId: saved.id,
        runFile: saved.file,
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