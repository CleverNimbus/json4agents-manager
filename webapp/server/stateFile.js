/**
 * Shared plumbing for the small JSON files the UI owns: state.json and
 * settings.json inside the data folder.
 *
 * Both are best-effort: a missing, empty or malformed file falls back to the
 * defaults instead of breaking the app, and writes go through the same atomic
 * temporary file + rename used for the agents.
 *
 * The path is a function, not a string, so a store keeps working after the user
 * points the app at a different data folder.
 */
import { readJsonFile, writeJsonFile } from './store.js';

/**
 * @param {object} options
 * @param {() => string} options.getPath resolves the current absolute path
 * @param {object} options.defaults value used when the file is absent or broken
 * @param {(raw: unknown) => object} options.sanitise turn whatever was read into a valid state
 */
export function createStateFile({ getPath, defaults, sanitise }) {
  const fallback = () => sanitise(undefined);

  return {
    get file() {
      return getPath();
    },

    /** @returns {Promise<object>} always a valid state object */
    async read() {
      try {
        return sanitise(await readJsonFile(getPath(), fallback()));
      } catch {
        return fallback();
      }
    },

    /** @param {object} state @returns {Promise<object>} the state that was written */
    async write(state) {
      await writeJsonFile(getPath(), state);
      return state;
    },
  };
}