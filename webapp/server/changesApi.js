/**
 * Uncommitted git changes inside the workspace folder.
 *
 *   GET /api/changes -> the files git still reports as changed or untracked
 *
 * Requires both workspace settings from the Settings tab; without them the
 * response is { configured: false } and the tab explains what to set.
 */
import { Router } from 'express';
import { listUncommittedFiles } from './gitChanges.js';

export const changesRouter = Router();

changesRouter.get('/api/changes', async (req, res) => {
  res.json(await listUncommittedFiles());
});