/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read-only computed view: the producer -> consumer graph between agents,
 * derived from each agent's `result_generated_files` and
 * `source_dependant_files`. See `agentDependencies.js` for the matching rule.
 */
import { Router } from 'express';

import { listAgents } from './agentsStore.js';
import { findDependencies } from './agentDependencies.js';

export const dependenciesRouter = Router();

dependenciesRouter.get('/api/agent-dependencies', async (_req, res) => {
  const { records } = await listAgents();
  res.json(findDependencies(records));
});
