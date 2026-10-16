/**
 * Runtime configuration.
 *
 * Values come from CLI flags first, then environment variables, then defaults.
 * The app files (index.html, src/, styles.css) live in webapp/; everything the
 * app persists lives in the data directory, which defaults to <repo>/data:
 *
 *   data/agents.schema.json   the schema every agent file is validated against
 *   data/agents/<CODE>.json   one file per agent record
 *   data/hashes.json          hash results
 */
import os from 'node:os';
import path from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parse `--key value`, `--key=value` and `--flag` into an object. */
function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const rawKey = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = 'true';
    }
    parsed[key] = value;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

/** Folder holding server.js, index.html, src/ and styles.css. */
export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const serverDir = path.join(appDir, 'server');
export const repoDir = path.resolve(appDir, '..');

/**
 * Where the "data folder" setting is remembered. It cannot live inside the data
 * folder - moving the folder would move the setting that points at it - so it
 * sits next to package.json, and defaults to <repo>/data when absent.
 */
export const dataFolderPointer = path.join(repoDir, 'data-location.json');

function expand(input) {
  const value = String(input ?? '').trim();
  if (value === '' || value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(repoDir, value);
}

/** The data folder the user picked in Settings, if any. */
function readDataFolderPointer() {
  try {
    const pointer = JSON.parse(readFileSync(dataFolderPointer, 'utf8'));
    return typeof pointer?.dataFolder === 'string' && pointer.dataFolder.trim() !== '' ? pointer.dataFolder : '';
  } catch {
    return '';
  }
}

/** CLI flag wins, then the setting from Settings, then <repo>/data. */
function initialDataDir() {
  const flag = args.dataDir || process.env.JSONM_DATA_DIR;
  if (flag) return expand(flag);
  const pointer = readDataFolderPointer();
  if (pointer) return expand(pointer);
  return path.join(repoDir, 'data');
}

export const config = {
  appDir,
  serverDir,
  repoDir,
  host: args.host || process.env.HOST || '127.0.0.1',
  port: Number(args.port || process.env.PORT || 8000),
  /** Mutable: the Settings tab can point the app at another folder. */
  dataDir: initialDataDir(),
  /** True while the value comes from --data-dir / JSONM_DATA_DIR. */
  dataDirLocked: Boolean(args.dataDir || process.env.JSONM_DATA_DIR),
  /**
   * Optional jail: when set, the folder explorer and the hash runner refuse to
   * leave this directory. `null` means the whole local filesystem is browsable,
   * which is the default for a single user tool.
   */
  browseRoot: args.root ? path.resolve(args.root) : null,
  home: os.homedir(),
};

export const defaultDataDir = path.join(repoDir, 'data');

/**
 * Turn whatever the user typed into an absolute path. `~` and relative paths
 * are expanded; an empty value means "use the default folder".
 */
export function resolveDataFolder(value) {
  const raw = String(value ?? '').trim();
  return raw === '' ? defaultDataDir : expand(raw);
}

/**
 * Point the app at another data folder. Everything below resolves `files`
 * lazily, so this takes effect immediately; the caller is responsible for
 * dropping caches (see resetSchemaCache in validate.js).
 */
export function setDataDir(next) {
  config.dataDir = resolveDataFolder(next);
  return config.dataDir;
}

/**
 * Remember the data folder in the pointer file. Stored as given, so a relative
 * path or ~ keeps working after a move.
 */
export function writeDataFolderPointer(value) {
  const raw = String(value ?? '').trim();
  const resolved = expand(raw || defaultDataDir);
  const payload = { dataFolder: raw, resolved, updatedAt: new Date().toISOString() };
  if (raw === '') {
    rmSync(dataFolderPointer, { force: true });
  } else {
    writeFileSync(dataFolderPointer, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return payload;
}

/** The value shown in Settings: what the user typed, or '' when defaulted. */
export function dataFolderSetting() {
  const pointer = readDataFolderPointer();
  return {
    value: pointer,
    resolved: config.dataDir,
    isDefault: pointer === '',
    locked: config.dataDirLocked,
    pointerFile: dataFolderPointer,
    defaultDir: defaultDataDir,
  };
}

/** Absolute paths of everything the app reads or writes, resolved on access. */
export const files = {
  get agentsDir() {
    return path.join(config.dataDir, 'agents');
  },
  get schema() {
    return path.join(config.dataDir, 'agents.schema.json');
  },
  get hashes() {
    return path.join(config.dataDir, 'hashes.json');
  },
  /** Hash store: one immutable file per run plus a rebuildable index. */
  get hashesDir() {
    return path.join(config.dataDir, 'hashes');
  },
  get hashesRunsDir() {
    return path.join(config.dataDir, 'hashes', 'runs');
  },
  get hashesIndex() {
    return path.join(config.dataDir, 'hashes', 'index.json');
  },
  get state() {
    return path.join(config.dataDir, 'state.json');
  },
  get settings() {
    return path.join(config.dataDir, 'settings.json');
  },
};