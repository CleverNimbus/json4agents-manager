import { reactive } from './lib/vue.esm-browser.prod.js';
import * as fs from './fileAccess.js';

/**
 * @typedef {Object} Agent
 * @property {string} code
 * @property {string} name
 * @property {string} description
 * @property {string} notes
 * @property {number} phase
 * @property {string} parent
 * @property {string[]} source_dependant_files
 * @property {string[]} result_generated_files
 * @property {string[]} executions
 */

export const state = reactive({
  /** @type {Agent[]} */
  agents: [],
  fileName: '',
  handle: null,
  loading: true,
  error: null,
  dirty: false,
  fsSupported: fs.supportsFileSystemAccess(),
});

async function loadBundledSample() {
  const res = await fetch('./agents.sample.json');
  if (!res.ok) throw new Error('bundled agents.sample.json missing');
  const data = await res.json();
  return { name: 'agents.sample.json (bundled)', data };
}

async function loadFallback() {
  const { name, data } = await loadBundledSample();
  state.fileName = name;
  state.agents = data.agents || [];
}

export async function initStore() {
  state.loading = true;
  try {
    if (!state.fsSupported) {
      await loadFallback();
      return;
    }
    const handle = await fs.loadHandle();
    if (handle) {
      try {
        const writable = await fs.requestWritePermission(handle);
        const { name, data } = await fs.readJsonFromHandle(handle);
        state.handle = handle;
        state.fileName = name;
        state.agents = data.agents || [];
        state.dirty = !writable;
      } catch (e) {
        state.error = 'Could not reload last file: ' + e.message;
        await loadFallback();
      }
    } else {
      await loadFallback();
    }
  } catch (e) {
    state.error = 'Load failed: ' + e.message;
    state.agents = [];
  } finally {
    state.loading = false;
  }
}

export async function openFile() {
  try {
    const handle = await fs.pickJsonFile();
    const writable = await fs.requestWritePermission(handle);
    const { name, data } = await fs.readJsonFromHandle(handle);
    state.handle = handle;
    state.fileName = name;
    state.agents = data.agents || [];
    state.dirty = !writable;
    state.error = null;
    await fs.saveHandle(handle);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    state.error = 'Open failed: ' + e.message;
  }
}

async function persist() {
  try {
    if (!state.handle) {
      downloadJson();
    } else {
      const ok = await fs.requestWritePermission(state.handle);
      if (!ok) {
        state.error = 'Write permission denied. Re-open the file and grant access.';
        return;
      }
      await fs.writeJsonToHandle(state.handle, { agents: state.agents });
      state.error = null;
    }
    state.dirty = false;
  } catch (e) {
    state.error = 'Save failed: ' + e.message;
  }
}

/**
 * @param {Agent} agent
 */
export async function addAgent(agent) {
  state.agents.push(agent);
  state.dirty = true;
  await persist();
}

/**
 * @param {number} index
 * @param {Agent} agent
 */
export async function updateAgent(index, agent) {
  state.agents.splice(index, 1, agent);
  state.dirty = true;
  await persist();
}

/**
 * @param {number} index
 */
export async function deleteAgent(index) {
  state.agents.splice(index, 1);
  state.dirty = true;
  await persist();
}

function downloadJson() {
  const blob = new Blob([JSON.stringify({ agents: state.agents }, null, 2) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agents.json';
  a.click();
  URL.revokeObjectURL(url);
}
