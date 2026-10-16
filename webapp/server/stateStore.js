/**
 * Session state that survives a reload: data/state.json.
 *
 * Small on purpose - the app remembers what the user last worked with, not
 * session data. Anything unreadable on disk falls back to the defaults.
 */
import { files } from './config.js';
import { createStateFile } from './stateFile.js';

const DEFAULTS = {
  hashTab: {
    /** Absolute path of the folder that was last picked or hashed. */
    lastFolder: '',
  },
};

function sanitise(raw) {
  const state = structuredClone(DEFAULTS);
  const lastFolder = raw?.hashTab?.lastFolder;
  if (typeof lastFolder === 'string') state.hashTab.lastFolder = lastFolder.trim();
  return state;
}

const file = createStateFile({ getPath: () => files.state, defaults: DEFAULTS, sanitise });

export const readState = () => file.read();

/** Merge a patch into the stored state and write it back. */
export async function updateState(patch) {
  const next = await readState();
  if (typeof patch?.hashTab?.lastFolder === 'string') {
    next.hashTab.lastFolder = patch.hashTab.lastFolder.trim();
  }
  return file.write(next);
}

/**
 * Store `lastFolder` unless it already matches, so repeated hashes of the same
 * folder do not rewrite the file.
 */
export async function rememberHashFolder(folder) {
  const value = String(folder ?? '').trim();
  const current = await readState();
  if (current.hashTab.lastFolder === value) return current;
  return updateState({ hashTab: { lastFolder: value } });
}