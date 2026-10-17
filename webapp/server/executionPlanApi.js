/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read-only computed view plus persistence for the Hashing tab's left panel.
 * The plan lives at `<dataFolder>/execution-plan.json` and is rebuilt on
 * demand by `POST /api/execution-plan/generate`; the per-step `done` flag
 * the user toggles is updated by `PATCH /api/execution-plan`.
 */
import { Router } from 'express';

import { listAgents } from './agentsStore.js';
import { getView } from './hashesStore.js';
import { buildExecutionPlan } from './executionPlan.js';
import { patchPlanDone, readPlan, writePlan } from './executionPlanStore.js';

export const executionPlanRouter = Router();

executionPlanRouter.get('/api/execution-plan', async (_req, res) => {
  res.json(await readPlan());
});

/**
 * Recompute the plan from the current agents and hash view, write it to
 * disk, and return it. Any `done` flags from a previous plan are dropped:
 * a freshly generated plan has no carried-over state.
 */
executionPlanRouter.post('/api/execution-plan/generate', async (_req, res) => {
  const { records } = await listAgents();
  const view = await getView();
  const plan = buildExecutionPlan(records, view);
  const stored = await writePlan({
    version: 1,
    generatedAt: new Date().toISOString(),
    changedPaths: plan.changedPaths,
    steps: plan.steps,
  });
  res.json(stored);
});

/**
 * Toggle the `done` flag on one or more steps. Body shape:
 *   { steps: [{ code: "AG-001", done: true }, …] }
 */
executionPlanRouter.patch('/api/execution-plan', async (req, res) => {
  const patch = req.body;
  if (!patch || !Array.isArray(patch.steps)) {
    return res.status(400).json({ error: 'Expected { steps: [{ code, done }, …] }' });
  }
  res.json(await patchPlanDone(patch));
});
