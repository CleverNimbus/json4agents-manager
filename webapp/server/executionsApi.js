/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Execution receipt API.
 *
 *   GET  /api/executions          every receipt plus its status against git
 *   POST /api/executions          publish one run: { agent, paths }
 *
 * POST never commits anything. It writes one immutable receipt file and
 * tells the caller which staged paths must ride the same commit.
 */
import { Router } from 'express';
import { receiptsView, recordExecution } from './executionsStore.js';

export const executionsRouter = Router();

executionsRouter.get('/api/executions', async (req, res) => {
  res.json(await receiptsView());
});

executionsRouter.post('/api/executions', async (req, res, next) => {
  try {
    const { agent, paths } = req.body ?? {};
    const result = await recordExecution({ agent, paths });
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    // 409 carries per-path conflicts; the shared error handler would drop them.
    if (err.status === 409 && Array.isArray(err.conflicts)) {
      return res.status(409).json({ error: err.message, errors: err.conflicts });
    }
    return next(err);
  }
});
