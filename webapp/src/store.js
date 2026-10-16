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
    doc: { folders: [], files: [], runs: [] },
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
          return `Done — ${s.files} files, ${s.folders} folders, ${formatBytes(s.bytes)} in ${formatDuration(s.durationMs)}${moved} → hashes.json${s.errors ? ` · ${s.errors} unreadable` : ''}`;
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
      sourceFolder: data?.sourceFolder ?? '',
      generated: data?.generated ?? '',
    };
    store.hashes.loaded = true;
  } finally {
    store.hashes.loading = false;
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
        `Saved hashes for ${event.summary.root} — ${event.summary.changed} changed, ${event.summary.unchanged} unchanged of ${event.summary.files + event.summary.folders} entries.`,
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