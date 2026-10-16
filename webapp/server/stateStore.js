/**
 * UI state that survives a reload: data/state.json.
 *
 * Small on purpose - the app remembers what the user last worked with, not
 * session data. The file is optional: a missing or broken one falls back to the
 * defaults instead of breaking the UI, and it is rewritten atomically like every
 * other file the app owns.
 */
import { files } from './config.js';
import { readJsonFile, writeJsonFile } from './store.js';

const DEFAULTS = {
  hashTab: {
    /** Absolute path of the folder that was last picked or hashed. */
    lastFolder: '',
  },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Coerce whatever is on disk into a valid state object. */
function sanitise(raw) {
  const state = structuredClone(DEFAULTS);
  if (!isPlainObject(raw)) return state;
  if (typeof raw.hashTab?.lastFolder === 'string') {
    state.hashTab.lastFolder = raw.hashTab.lastFolder.trim();
  }
  return state;
}

export async function readState() {
  try {
    return sanitise(await readJsonFile(files.state, DEFAULTS));
  } catch {
    // Unreadable or malformed state is not worth failing the app over.
    return sanitise(null);
  }
}

/**
 * Merge a patch into the stored state.
 *
 * @param {{ hashTab?: { lastFolder?: string } }} patch
 * @returns {Promise<object>} the state after the merge
 */
export async function updateState(patch) {
  const next = await readState();
  if (isPlainObject(patch?.hashTab) && typeof patch.hashTab.lastFolder === 'string') {
    next.hashTab.lastFolder = patch.hashTab.lastFolder.trim();
  }
  await writeJsonFile(files.state, next);
  return next;
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