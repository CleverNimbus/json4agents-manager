/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Uncommitted git changes inside the workspace folder.
 *
 *   GET /api/changes -> the files git still reports as changed or untracked
 *
 * Requires both workspace settings from the Settings tab; without them the
 * response is { configured: false } and the tab explains what to set.
 *
 * Every file row carries `consumers` and `producers`: the agent codes whose
 * `source_dependant_files` / `result_generated_files` cover the path, using
 * the same folder/file overlap rule as the Agent Dependencies tab. The agent
 * store is read best effort - a broken or missing agent file must never stop
 * the listing, so the rows fall back to empty lists instead.
 */
import { Router } from 'express';
import { consumersOf, producersOf } from './agentDependencies.js';
import { listAgents } from './agentsStore.js';
import { listUncommittedFiles } from './gitChanges.js';

export const changesRouter = Router();

/** Stamp each row with the agents that read or produce it. */
async function withAgentRoles(files) {
  let records = [];
  try {
    ({ records } = await listAgents());
  } catch {
    records = [];
  }
  return files.map((file) => ({
    ...file,
    consumers: consumersOf(file.path, records),
    producers: producersOf(file.path, records),
  }));
}

changesRouter.get('/api/changes', async (req, res) => {
  const view = await listUncommittedFiles();
  if (!view.configured) return res.json(view);
  res.json({ ...view, files: await withAgentRoles(view.files) });
});
