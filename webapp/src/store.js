/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Shared reactive state and the actions that mutate it.
 *
 * Both tabs keep their state here so switching tabs (or reloading a grid) never
 * loses an in-flight hash run.
 */
import { reactive } from 'vue';
import { formatBytes, formatDuration } from './format.js';
import * as api from './api.js';

export const store = reactive({
  activeTab: 'agents',
  banner: null,

  /**
   * Bumped whenever the data source underneath the app changes (the data folder
   * setting). Tabs that keep local copies of what they showed watch this.
   */
  revision: 0,

  agents: {
    /** Folder holding one JSON file per agent. */
    dir: '',
    list: [],
    valid: true,
    errors: [],
    loading: false,
    loaded: false,
  },

  schema: null,

  hashes: {
    file: '',
    doc: { folders: [], files: [], runs: [], broken: [] },
    loading: false,
    loaded: false,
    /** True while the derived index is being rebuilt. */
    rebuilding: false,
    /**
     * Bumped every time `loadHashes` finishes, so listeners (e.g. the
     * execution plan) can re-derive themselves without re-fetching agents.
     */
    revision: 0,
  },

  /** Computed producer -> consumer graph for the Agent Dependencies tab. */
  dependencies: {
    agents: [],
    edges: [],
    loading: false,
    loaded: false,
  },

  /** Computed execution order for the Hashing tab (left panel). */
  executionPlan: {
    generatedAt: '',
    changedPaths: [],
    steps: [],
    loading: false,
    loaded: false,
  },

  /** Remembered UI choices, persisted in data/state.json. */
  state: {
    file: '',
    hashTab: { lastFolder: '' },
    loaded: false,
  },

  /** Settings from the Settings tab, persisted in data/settings.json. */
  settings: {
    file: '',
    workspaceFolder: '',
    gitRoot: '',
    updatedAt: '',
    loaded: false,
    /** Bumped on every successful save; views that depend on it watch this. */
    revision: 0,
  },

  /** Where the app keeps its JSON files; from data-location.json. */
  dataFolder: {
    value: '',
    resolved: '',
    isDefault: true,
    locked: false,
    pointerFile: '',
    defaultDir: '',
    loaded: false,
  },

  hashJob: {
    running: false,
    phase: 'idle', // idle | scanning | hashing | writing | done | cancelled | error
    root: '',
    total: 0,
    done: 0,
    bytes: 0,
    errors: 0,
    lastFile: '',
    summary: null,
    message: '',

    /** The single progress line under the toolbar. */
    get progressText() {
      switch (this.phase) {
        case 'scanning':
          return `Scanning ${this.root} …`;
        case 'hashing':
          return `Hashing ${this.done}/${this.total || '?'} files · ${formatBytes(this.bytes)} · last: ${this.lastFile || '—'}`;
        case 'writing':
          return `Hashed ${this.done} files, writing hashes.json …`;
        case 'done': {
          const s = this.summary;
          const moved = Number.isFinite(s.changed) ? ` · ${s.changed} changed, ${s.unchanged} unchanged` : '';
          const run = s.runId ? ` · run ${String(s.runId).split('_')[0]}` : '';
          return `Done — ${s.files} files, ${s.folders} folders, ${formatBytes(s.bytes)} in ${formatDuration(s.durationMs)}${moved}${run}${s.errors ? ` · ${s.errors} unreadable` : ''}`;
        }
        case 'cancelled':
          return `Cancelled after ${this.done}/${this.total || '?'} files — hashes.json left unchanged`;
        case 'error':
          return `Error: ${this.message}`;
        default:
          return this.message || 'Idle — pick a folder and press Hash folder.';
      }
    },
  },
});

let hashController = null;

export function setBanner(kind, text) {
  store.banner = text ? { kind, text } : null;
}

export const clearBanner = () => setBanner('info', '');

/**
 * Forget everything that was read from the data folder. Used before a reload
 * after the data folder changed, so nothing from the old folder lingers.
 */
function invalidateDataCaches() {
  store.schema = null;
  store.agents.loaded = false;
  store.hashes.loaded = false;
  store.dependencies.loaded = false;
  store.executionPlan.loaded = false;
  store.state.loaded = false;
  store.settings.loaded = false;
}

/**
 * Re-read agents, schema, hashes, state and settings from the data folder.
 * Anything that cannot be read is reported: after a folder switch, silently
 * keeping the previous folder's rows would be worse than an error.
 */
export async function reloadAll() {
  invalidateDataCaches();
  const loaders = [
    ['agents', loadAgents],
    ['schema', loadSchema],
    ['hashes', loadHashes],
    ['dependencies', loadDependencies],
    ['execution-plan', loadExecutionPlan],
    ['state', loadState],
    ['settings', loadSettings],
  ];
  const failures = [];
  for (const [name, load] of loaders) {
    try {
      await load();
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  // Tabs watch these; bumping them makes every open tab show the new folder.
  store.revision += 1;
  store.settings.revision += 1;
  if (failures.length > 0) {
    setBanner('error', `Switched data folder, but some data could not be read — ${failures.join(' · ')}`);
  }
  return store;
}

export async function loadDataFolder() {
  try {
    const info = await api.getDataFolder();
    Object.assign(store.dataFolder, info, { loaded: true });
  } catch {
    store.dataFolder.loaded = true;
  }
  return store.dataFolder;
}

/**
 * Point the app at another data folder, then reload every tab. An empty value
 * goes back to the default <repo>/data.
 */
export async function saveDataFolder(value) {
  const info = await api.saveDataFolder(String(value ?? '').trim());
  Object.assign(store.dataFolder, info, { loaded: true });
  await reloadAll();
  return store.dataFolder;
}

export async function loadSchema() {
  if (store.schema) return store.schema;
  store.schema = await api.getSchema();
  return store.schema;
}

export async function loadAgents() {
  store.agents.loading = true;
  try {
    const { dir, agents, valid, errors } = await api.getAgents();
    store.agents.dir = dir;
    store.agents.list = agents;
    store.agents.valid = valid;
    store.agents.errors = errors ?? [];
    store.agents.loaded = true;
  } finally {
    store.agents.loading = false;
  }
}

/**
 * Create or update one agent file, then reload the list.
 *
 * @param {{previousCode: string, agent: object}} payload
 *   `previousCode` is empty for a new record. When the code changed, the server
 *   renames the file.
 */
export async function saveAgent({ previousCode, agent }) {
  if (previousCode) await api.updateAgent(previousCode, agent);
  else await api.createAgent(agent);
  await loadAgents();
}

/** Delete one agent file, then reload the list. */
export async function removeAgent(code) {
  await api.deleteAgent(code);
  await loadAgents();
}

export async function loadHashes() {
  store.hashes.loading = true;
  try {
    const { file, data } = await api.getHashes();
    store.hashes.file = file;
    store.hashes.doc = {
      folders: Array.isArray(data?.folders) ? data.folders : [],
      files: Array.isArray(data?.files) ? data.files : [],
      runs: Array.isArray(data?.runs) ? data.runs : [],
      broken: Array.isArray(data?.broken) ? data.broken : [],
      sourceFolder: data?.sourceFolder ?? '',
      generated: data?.generated ?? '',
    };
    store.hashes.loaded = true;
    // Listeners (e.g. the execution plan panel) derive themselves from the
    // hashes, so bumping this counter is the signal that the data moved.
    store.hashes.revision += 1;
  } finally {
    store.hashes.loading = false;
  }
}

/**
 * Fetch the computed agent dependency graph. The server derives this from each
 * agent's `result_generated_files` and `source_dependant_files`; the client
 * only renders it.
 */
export async function loadDependencies() {
  store.dependencies.loading = true;
  try {
    const graph = await api.getDependencies();
    store.dependencies.agents = Array.isArray(graph?.agents) ? graph.agents : [];
    store.dependencies.edges = Array.isArray(graph?.edges) ? graph.edges : [];
    store.dependencies.loaded = true;
  } finally {
    store.dependencies.loading = false;
  }
}

/**
 * Fetch the saved execution plan for the Hashing tab. Returns the empty
 * shape when the file does not exist, so the panel can render its "no
 * plan yet" state.
 */
export async function loadExecutionPlan() {
  store.executionPlan.loading = true;
  try {
    const plan = await api.getExecutionPlan();
    store.executionPlan.generatedAt = typeof plan?.generatedAt === 'string' ? plan.generatedAt : '';
    store.executionPlan.changedPaths = Array.isArray(plan?.changedPaths) ? plan.changedPaths : [];
    store.executionPlan.steps = Array.isArray(plan?.steps) ? plan.steps : [];
    store.executionPlan.loaded = true;
  } finally {
    store.executionPlan.loading = false;
  }
}

/**
 * Recompute the plan from the current hashes + agents and persist it. The
 * response is the new saved plan, with all `done` flags reset to false.
 */
export async function generateExecutionPlan() {
  store.executionPlan.loading = true;
  try {
    const plan = await api.generateExecutionPlan();
    store.executionPlan.generatedAt = typeof plan?.generatedAt === 'string' ? plan.generatedAt : '';
    store.executionPlan.changedPaths = Array.isArray(plan?.changedPaths) ? plan.changedPaths : [];
    store.executionPlan.steps = Array.isArray(plan?.steps) ? plan.steps : [];
    store.executionPlan.loaded = true;
  } finally {
    store.executionPlan.loading = false;
  }
}

/**
 * Persist a `done` toggle for a single step. The local store is updated
 * optimistically so the checkbox reflects the click immediately.
 */
export async function setExecutionStepDone(code, done) {
  const steps = store.executionPlan.steps;
  const step = steps.find((entry) => entry.code === code);
  if (!step) return;
  const previous = step.done;
  if (previous === done) return;
  step.done = done;
  try {
    await api.patchExecutionPlan({ steps: [{ code, done }] });
  } catch (err) {
    step.done = previous;
    throw err;
  }
}

/**
 * Throw the derived index away and build it again from the run files.
 *
 * The index is a cache, so this is safe to do at any time: only index.json is
 * rewritten and no run file is touched. Used when the store looks wrong - a
 * grid that disagrees with the runs, or a run file edited by hand.
 *
 * @returns {Promise<{runs:number, files:number, folders:number, broken:object[]}>}
 */
export async function rebuildHashIndex() {
  store.hashes.rebuilding = true;
  try {
    const result = await api.rebuildHashIndex();
    await loadHashes();
    return result;
  } finally {
    store.hashes.rebuilding = false;
  }
}

function resetJob(root) {
  Object.assign(store.hashJob, {
    running: true,
    phase: 'scanning',
    root,
    total: 0,
    done: 0,
    bytes: 0,
    errors: 0,
    lastFile: '',
    summary: null,
    message: '',
  });
}

/**
 * Hash a folder tree and merge the result into hashes.json.
 *
 * @param {{path:string, includeHidden:boolean, followSymlinks:boolean}} options
 */
export async function startHash({ path, includeHidden, followSymlinks }) {
  if (store.hashJob.running) return;
  resetJob(path);
  hashController = new AbortController();

  try {
    await api.hashFolder({ path, includeHidden, followSymlinks }, onHashEvent, hashController.signal);
    await loadHashes();
  } catch (err) {
    if (err.name === 'AbortError') {
      store.hashJob.phase = 'cancelled';
    } else {
      store.hashJob.phase = 'error';
      store.hashJob.message = err.message;
      setBanner('error', `Hashing failed: ${err.message}`);
    }
  } finally {
    store.hashJob.running = false;
    hashController = null;
  }
}

/**
 * Remember the folder the user last picked or hashed, so the hashing tab comes
 * back with it after a reload. Failures are silent: losing the memory of a path
 * must never interrupt a hash run.
 */
export async function rememberHashFolder(folder) {
  const value = String(folder ?? '').trim();
  if (value === '' || store.state.hashTab.lastFolder === value) return;
  try {
    const { state } = await api.saveState({ hashTab: { lastFolder: value } });
    store.state.hashTab.lastFolder = state.hashTab.lastFolder;
  } catch {
    /* not worth a banner */
  }
}

/** Load data/state.json; the folder is only applied when nothing was typed yet. */
export async function loadState() {
  if (store.state.loaded) return store.state;
  try {
    const { file, state } = await api.getState();
    store.state.file = file;
    store.state.hashTab.lastFolder = state?.hashTab?.lastFolder ?? '';
  } catch {
    /* defaults are fine */
  }
  store.state.loaded = true;
  return store.state;
}

export async function loadSettings() {
  if (store.settings.loaded) return store.settings;
  try {
    const { file, settings } = await api.getSettings();
    store.settings.file = file;
    store.settings.workspaceFolder = settings?.workspaceFolder ?? '';
    store.settings.gitRoot = settings?.gitRoot ?? '';
    store.settings.updatedAt = settings?.updatedAt ?? '';
  } catch {
    /* defaults are fine */
  }
  store.settings.loaded = true;
  return store.settings;
}

/**
 * Store the workspace settings. No feature reads them yet, so they are not
 * checked against the filesystem here - the server enforces the git rules.
 *
 * @param {{ workspaceFolder: string, gitRoot: string }} patch
 */
export async function saveSettings(patch) {
  const { settings } = await api.saveSettings(patch);
  store.settings.workspaceFolder = settings.workspaceFolder;
  store.settings.gitRoot = settings.gitRoot;
  store.settings.updatedAt = settings.updatedAt;
  store.settings.loaded = true;
  // Anything derived from the workspace (the changes tab) watches this and
  // reloads, so switching folders takes effect immediately.
  store.settings.revision += 1;
  return store.settings;
}

function onHashEvent(event) {
  const job = store.hashJob;
  switch (event.type) {
    case 'start':
      job.root = event.root;
      break;
    case 'scan-done':
      job.total = event.total;
      job.phase = 'hashing';
      break;
    case 'file':
      job.done = event.done;
      job.total = event.total;
      job.bytes = event.bytes;
      job.lastFile = event.path;
      break;
    case 'file-error':
      job.errors += 1;
      job.lastFile = event.path;
      break;
    case 'writing':
      job.phase = 'writing';
      break;
    case 'done':
      job.phase = 'done';
      job.summary = event.summary;
      job.message = '';
      setBanner(
        'info',
        `Saved hashes for ${event.summary.root} — ${event.summary.changed} changed, ` +
          `${event.summary.unchanged} unchanged, recorded as run ${String(event.summary.runId).split('_')[0]}.`,
      );
      break;
    case 'cancelled':
      job.phase = 'cancelled';
      break;
    case 'error':
      job.phase = 'error';
      job.message = event.message;
      break;
    default:
      break;
  }
}

export function cancelHash() {
  hashController?.abort();
}