/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Data folder backend.
 *
 *   GET /api/data-folder -> the setting, the folder in use, whether it is default
 *   PUT /api/data-folder -> point the app at another folder, or back to the default
 *
 * The setting itself cannot live inside the data folder - moving the folder
 * would move the setting that points at it - so it is remembered in
 * data-location.json next to package.json. Precedence on startup is
 * --data-dir / JSONM_DATA_DIR > this setting > <repo>/data.
 *
 * Switching is all-or-nothing: the target is prepared first (folder created, a
 * missing schema carried over), and only then does the app move. A failure
 * leaves the previous folder in use.
 */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  config,
  dataFolderSetting,
  defaultDataDir,
  resolveDataFolder,
  setDataDir,
  writeDataFolderPointer,
} from './config.js';
import { fileExists } from './store.js';
import { resetSchemaCache } from './validate.js';

export const dataFolderRouter = Router();

dataFolderRouter.get('/api/data-folder', (req, res) => {
  res.json(dataFolderSetting());
});

dataFolderRouter.put('/api/data-folder', async (req, res) => {
  const { dataFolder } = req.body ?? {};
  if (dataFolder !== undefined && typeof dataFolder !== 'string') {
    return res.status(400).json({ error: 'dataFolder must be a string' });
  }
  if (config.dataDirLocked) {
    return res.status(409).json({
      error:
        'The data folder is fixed by --data-dir / JSONM_DATA_DIR for this run; start the server without it to change the folder here.',
    });
  }

  const raw = String(dataFolder ?? '').trim();
  const previous = config.dataDir;
  const target = resolveDataFolder(raw);

  try {
    await fs.mkdir(path.join(target, 'agents'), { recursive: true });

    // Carry the schema along when the new folder has none: without it nothing
    // could be validated. A folder that brings its own schema keeps it.
    const targetSchema = path.join(target, 'agents.schema.json');
    if (!(await fileExists(targetSchema))) {
      const currentSchema = path.join(previous, 'agents.schema.json');
      if (await fileExists(currentSchema)) await fs.copyFile(currentSchema, targetSchema);
    }
  } catch (err) {
    setDataDir(previous);
    return res.status(400).json({ error: `Cannot use ${target} as the data folder: ${err.message}` });
  }

  setDataDir(raw);
  writeDataFolderPointer(raw);
  resetSchemaCache();

  return res.json({ ok: true, ...dataFolderSetting(), dataDir: config.dataDir, previousDir: previous, defaultDir: defaultDataDir });
});