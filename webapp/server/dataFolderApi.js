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
 * Switching only re-points the app; the folders below it are created by
 * whichever store needs them. (Agent files are not data-folder state: they
 * live in the agents folder configured in settings.json.)
 */
import { Router } from 'express';
import {
  config,
  dataFolderSetting,
  defaultDataDir,
  setDataDir,
  writeDataFolderPointer,
} from './config.js';

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

  setDataDir(raw);
  writeDataFolderPointer(raw);

  return res.json({ ok: true, ...dataFolderSetting(), dataDir: config.dataDir, previousDir: previous, defaultDir: defaultDataDir });
});