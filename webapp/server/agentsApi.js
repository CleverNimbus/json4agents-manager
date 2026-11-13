/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agents tab backend for the read-only markdown store in the agents folder.
 *
 *   GET    /api/agents        every record, sorted by code
 *   GET    /api/agents/:code  one record (frontmatter + body)
 *
 * Agent files are written by hand, so there is nothing to create, update or
 * delete here; the API only reads and reports what is on disk.
 */
import { Router } from 'express';
import { AgentStoreError, agentsDir, listAgents, readAgent } from './agentsStore.js';

export const agentsRouter = Router();

agentsRouter.get('/api/agents', async (req, res) => {
  const { records, issues } = await listAgents();
  const errors = [...issues.map((issue) => ({ path: issue.file, message: issue.message }))];
  res.json({ dir: await agentsDir(), agents: records, valid: errors.length === 0, errors });
});

agentsRouter.get('/api/agents/:code', async (req, res) => {
  const { file, agent } = await readAgent(req.params.code);
  res.json({ file, agent });
});

// Anything below that reaches this router with a bad code is an AgentStoreError.
agentsRouter.use((err, req, res, next) => {
  if (!(err instanceof AgentStoreError)) return next(err);
  return res.status(err.status).json({ error: err.message });
});
