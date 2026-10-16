/**
 * Shared plumbing for the small JSON files the UI owns: data/state.json and
 * data/settings.json.
 *
 * Both are best-effort: a missing, empty or malformed file falls back to the
 * defaults instead of breaking the app, and writes go through the same atomic
 * temporary file + rename used for the agents.
 */
import { readJsonFile, writeJsonFile } from './store.js';

/**
 * @param {object} options
 * @param {string} options.file absolute path of the JSON file
 * @param {object} options.defaults value used when the file is absent or broken
 * @param {(raw: unknown) => object} options.sanitise turn whatever was read into a valid state
 */
export function createStateFile({ file, defaults, sanitise }) {
  const fallback = () => sanitise(undefined);

  return {
    file,

    /** @returns {Promise<object>} always a valid state object */
    async read() {
      try {
        return sanitise(await readJsonFile(file, fallback()));
      } catch {
        return fallback();
      }
    },

    /** @param {object} state @returns {Promise<object>} the state that was written */
    async write(state) {
      await writeJsonFile(file, state);
      return state;
    },
  };
}