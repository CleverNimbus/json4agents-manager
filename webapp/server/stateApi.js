/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * UI state backend.
 *
 *   GET /api/state -> the stored state
 *   PUT /api/state -> merge a patch (currently only hashTab.lastFolder)
 */
import { Router } from 'express';
import { files } from './config.js';
import { readState, updateState } from './stateStore.js';

export const stateRouter = Router();

stateRouter.get('/api/state', async (req, res) => {
  res.json({ file: files.state, state: await readState() });
});

stateRouter.put('/api/state', async (req, res) => {
  const patch = req.body;
  if (
    patch === null ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    (patch.hashTab !== undefined && (patch.hashTab === null || typeof patch.hashTab !== 'object' || Array.isArray(patch.hashTab)))
  ) {
    return res.status(400).json({ error: 'Expected an object like { "hashTab": { "lastFolder": "/path" } }' });
  }
  if (patch.hashTab?.lastFolder !== undefined && typeof patch.hashTab.lastFolder !== 'string') {
    return res.status(400).json({ error: 'hashTab.lastFolder must be a string' });
  }
  return res.json({ ok: true, state: await updateState(patch) });
});