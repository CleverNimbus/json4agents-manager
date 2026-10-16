/**
 * Settings backend.
 *
 *   GET /api/settings -> the stored settings
 *   PUT /api/settings -> validate, then merge a patch into settings.json
 *
 * Validation happens after the patch is merged with what is already stored, so
 * saving one field is checked against the other. See settingsValidation.js for
 * the rules.
 */
import { Router } from 'express';
import { files } from './config.js';
import { readSettings, updateSettings } from './settingsStore.js';
import { validateWorkspaceSettings } from './settingsValidation.js';

export const settingsRouter = Router();

settingsRouter.get('/api/settings', async (req, res) => {
  res.json({ file: files.settings, settings: await readSettings() });
});

settingsRouter.put('/api/settings', async (req, res) => {
  const patch = req.body;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Expected an object like { "workspaceFolder": "/path", "gitRoot": "/path" }' });
  }

  const fields = ['workspaceFolder', 'gitRoot'];
  for (const key of fields) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') {
      return res.status(400).json({ error: `${key} must be a string` });
    }
  }

  // Merge first, then judge the pair the save would actually produce.
  const merged = { ...(await readSettings()) };
  for (const key of fields) {
    if (typeof patch[key] === 'string') merged[key] = patch[key].trim();
  }

  const { valid, errors } = await validateWorkspaceSettings(merged);
  if (!valid) {
    return res.status(400).json({ error: 'The workspace settings are not valid', errors });
  }

  return res.json({ ok: true, settings: await updateSettings(patch) });
});