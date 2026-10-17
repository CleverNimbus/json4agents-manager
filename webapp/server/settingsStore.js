/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * User settings: data/settings.json.
 *
 * Separate from state.json on purpose. state.json is what the app remembers
 * while you work (last hashed folder); settings.json is what you configure in
 * the Settings tab and expect to still be there tomorrow.
 */
import { files } from './config.js';
import { createStateFile } from './stateFile.js';

const DEFAULTS = {
  /**
   * The folder this workspace works in. Stored for future use - no feature
   * reads it yet, so changing it has no effect on the agents or hashing tabs.
   */
  workspaceFolder: '',
  /**
   * The git repository this workspace belongs to. Also unused so far, but a
   * workspace folder is only accepted when it sits inside this root, and the
   * root must really be a git repository.
   */
  gitRoot: '',
  /** ISO timestamp of the last change, filled in on write. */
  updatedAt: '',
};

function sanitise(raw) {
  const state = structuredClone(DEFAULTS);
  for (const key of ['workspaceFolder', 'gitRoot', 'updatedAt']) {
    if (typeof raw?.[key] === 'string') state[key] = raw[key].trim();
  }
  return state;
}

const file = createStateFile({ getPath: () => files.settings, defaults: DEFAULTS, sanitise });

export const readSettings = () => file.read();

/** Merge a patch into the stored settings and write it back. */
export async function updateSettings(patch) {
  const next = await readSettings();
  for (const key of ['workspaceFolder', 'gitRoot']) {
    if (typeof patch?.[key] === 'string') next[key] = patch[key].trim();
  }
  next.updatedAt = new Date().toISOString();
  return file.write(next);
}