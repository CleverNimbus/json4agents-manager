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

export const config = {
  appDir,
  serverDir,
  repoDir,
  host: args.host || process.env.HOST || '127.0.0.1',
  port: Number(args.port || process.env.PORT || 8000),
  dataDir: path.resolve(args.dataDir || process.env.JSONM_DATA_DIR || path.join(repoDir, 'data')),
  /**
   * Optional jail: when set, the folder explorer and the hash runner refuse to
   * leave this directory. `null` means the whole local filesystem is browsable,
   * which is the default for a single user tool.
   */
  browseRoot: args.root ? path.resolve(args.root) : null,
  home: os.homedir(),
};

/** Absolute paths of everything the app reads or writes. */
export const files = {
  /** Folder holding one JSON file per agent record. */
  agentsDir: path.join(config.dataDir, 'agents'),
  schema: path.join(config.dataDir, 'agents.schema.json'),
  hashes: path.join(config.dataDir, 'hashes.json'),
  /** UI state that outlives a reload, e.g. the last hashed folder. */
  state: path.join(config.dataDir, 'state.json'),
  /** Settings chosen in the Settings tab, e.g. the workspace folder. */
  settings: path.join(config.dataDir, 'settings.json'),
};