/**
 * Hash storage: one immutable file per run.
 *
 *   data/hashes/runs/<runId>.json   written once, never edited, never merged
 *   data/hashes/index.json          derived cache, git ignored, rebuildable
 *
 * Why per run: a single shared hashes.json is rewritten in full by every run, so
 * two machines that hashed anything at all collide on the same sorted document,
 * and "which hash is current" was decided by array position - which a merge can
 * silently reorder. Run files fix both: they are separate files, so git merges
 * them without conflicts, and each records only the paths whose hash actually
 * changed. Current state is then *computed* (newest run that mentions a path),
 * never stored, so it cannot be corrupted by an interleaved merge.
 *
 * A run file is a delta: paths whose hash differs from what this machine last
 * recorded. Unchanged paths are absent, which keeps run files small and makes
 * "3 hashes" mean "the content changed three times".
 *
 * GET /api/hashes still answers in the old flat shape (files/folders/runs with a
 * hashes[] history per path) - it is assembled from the run files on read, so
 * the browser does not care how it is stored.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { files } from './config.js';
import { fileExists, readJsonFile, writeJsonFile } from './store.js';

const INDEX_VERSION = 2;
const RUN_FILE = /\.json$/;

/** Newest first is the order the UI wants; ties broken by run id. */
const sortRuns = (runs) =>
  [...runs].sort((a, b) => {
    const delta = String(b.finishedAt).localeCompare(String(a.finishedAt));
    return delta !== 0 ? delta : String(b.id).localeCompare(String(a.id));
  });

// --------------------------------------------------------------- run files

export async function ensureStore() {
  await fs.mkdir(files.hashesRunsDir, { recursive: true });
}

function runFileName(id) {
  return `${id}.json`;
}

function runFilePath(id) {
  return path.join(files.hashesRunsDir, runFileName(id));
}

/**
 * Run id: the finished timestamp plus a short random suffix. Sorting by id
 * therefore sorts by time, and two runs can never collide.
 */
function newRunId(finishedAt) {
  const stamp = String(finishedAt).replace(/[:.]/g, '-');
  return `${stamp}_${randomUUID().slice(0, 8)}`;
}

export async function listRunFiles() {
  await ensureStore();
  const entries = await fs.readdir(files.hashesRunsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && RUN_FILE.test(entry.name))
    .map((entry) => path.join(files.hashesRunsDir, entry.name));
}

/** Cheap fingerprint of the run directory, used to detect a stale index. */
async function runSignature() {
  const files_ = await listRunFiles();
  const parts = await Promise.all(
    files_.map(async (file) => {
      const stats = await fs.stat(file);
      return `${path.basename(file)}:${stats.size}:${Math.round(stats.mtimeMs)}`;
    }),
  );
  parts.sort();
  return parts.join('|');
}

async function readRunFile(file) {
  const run = await readJsonFile(file, null);
  if (!run || typeof run !== 'object' || typeof run.finishedAt !== 'string') return null;
  return {
    id: path.basename(file, '.json'),
    file,
    root: run.root ?? '',
    host: run.host ?? '',
    startedAt: run.startedAt ?? run.finishedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs ?? null,
    stats: run.stats ?? null,
    files: Array.isArray(run.files) ? run.files : [],
    folders: Array.isArray(run.folders) ? run.folders : [],
    legacy: run.legacy === true,
  };
}

export async function readAllRuns() {
  const files_ = await listRunFiles();
  const runs = (await Promise.all(files_.map(readRunFile))).filter(Boolean);
  return sortRuns(runs);
}

// ------------------------------------------------------------------- index

/**
 * Rebuild the derived index from the run files. Never committed, never merged:
 * it is a cache of what the run files say.
 */
export async function rebuildIndex() {
  const runs = await readAllRuns();

  /** path -> assembled history, newest first */
  const fileHistory = new Map();
  const folderHistory = new Map();

  for (const run of runs) {
    for (const entry of run.files) {
      if (typeof entry?.path !== 'string' || typeof entry?.hash !== 'string') continue;
      const history = fileHistory.get(entry.path) ?? [];
      history.push({ datetime: run.finishedAt, runId: run.id, hash: entry.hash });
      fileHistory.set(entry.path, history);
    }
    for (const entry of run.folders) {
      if (typeof entry?.path !== 'string' || typeof entry?.hash !== 'string') continue;
      const history = folderHistory.get(entry.path) ?? [];
      history.push({ datetime: run.finishedAt, runId: run.id, hash: entry.hash });
      folderHistory.set(entry.path, history);
    }
  }

  const index = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    sourceFolder: runs[0]?.root ?? '',
    runs: runs.map((run) => ({
      id: run.id,
      root: run.root,
      host: run.host,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      stats: run.stats,
      legacy: run.legacy || undefined,
    })),
    files: [],
    folders: [],
  };

  for (const [entryPath, history] of fileHistory) {
    // runs are newest first, so the first match carries the freshest metadata
    const meta = runs.find((run) => run.files.some((entry) => entry.path === entryPath))?.files.find(
      (entry) => entry.path === entryPath,
    );
    index.files.push({ path: entryPath, size: meta?.size, mtime: meta?.mtime, history });
  }
  for (const [entryPath, history] of folderHistory) {
    index.folders.push({ path: entryPath, history });
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  index.files.sort(byPath);
  index.folders.sort(byPath);

  index.signature = await runSignature();
  await writeJsonFile(files.hashesIndex, index);
  return index;
}

export async function getIndex() {
  await ensureStore();
  const cached = await readJsonFile(files.hashesIndex, null);
  if (cached?.version === INDEX_VERSION && cached.signature === (await runSignature())) return cached;
  return rebuildIndex();
}

// -------------------------------------------------------------------- view

/**
 * The flat document the browser consumes, assembled from the run files.
 * Histories are newest first and a path is "changed" when its newest hash
 * differs from the one before it - both derived, never stored.
 */
export async function getView() {
  const index = await getIndex();
  const toRow = (entry) => ({
    path: entry.path,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}),
    hashes: entry.history.map((item) => ({ datetime: item.datetime, hash: item.hash, runId: item.runId })),
  });
  return {
    sourceFolder: index.sourceFolder,
    generated: index.runs[0]?.finishedAt ?? index.generatedAt,
    runs: index.runs,
    files: index.files.map(toRow),
    folders: index.folders.map(toRow),
  };
}

// -------------------------------------------------------------------- write

/**
 * Persist a finished run as its own immutable file, then refresh the index.
 * Nothing that already exists is rewritten, which is what makes concurrent
 * writers safe.
 *
 * @param {object} result value returned by hashFolder()
 */
export async function saveHashRun(result) {
  await ensureStore();

  // A run file is a delta: only paths whose hash differs from what the store
  // already knows. Everything else is already recorded by an earlier run, and
  // leaving it out is what keeps run files (and merges) small.
  const index = await getIndex();
  const known = new Map([...index.files, ...index.folders].map((entry) => [entry.path, entry.history[0]?.hash]));

  const files = result.files
    .filter((file) => known.get(file.path) !== file.hash)
    .map((file) => ({ path: file.path, size: file.size, mtime: file.mtime, hash: file.hash }));
  const folders = result.folders
    .filter((folder) => known.get(folder.path) !== folder.hash)
    .map((folder) => ({ path: folder.path, hash: folder.hash }));

  const id = newRunId(result.finishedAt);
  const run = {
    id,
    host: os.hostname(),
    root: result.root,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    stats: {
      ...result.stats,
      changed: files.length + folders.length,
      unchanged: Math.max(0, result.files.length + result.folders.length - files.length - folders.length),
    },
    files,
    folders,
  };

  await writeJsonFile(runFilePath(id), run);
  await rebuildIndex();

  return {
    id,
    file: runFilePath(id),
    runs: (await readAllRuns()).length,
    changed: files.length + folders.length,
  };
}

// --------------------------------------------------------------- migration

/**
 * One-shot conversion of the old single-file format.
 *
 * The legacy document stored, per path, a list of {datetime, hash} and a run
 * list. Entries are attributed to the run whose finishedAt matches their
 * datetime (which is how the old writer stamped them) and anything left over
 * goes to the newest run. Duplicate {path, hash} inside one run collapse, which
 * retires the legacy duplicate histories.
 *
 * @returns {Promise<{runs:number, files:number, folders:number}|null>}
 */
export async function migrateLegacyHashes() {
  if (!(await fileExists(files.hashes))) return null;
  await ensureStore();
  if ((await listRunFiles()).length > 0) {
    // Already converted; keep the old file only as a leftover to clean up.
    return null;
  }

  const legacy = await readJsonFile(files.hashes, null);
  if (!legacy || typeof legacy !== 'object') return null;

  const runs = Array.isArray(legacy.runs) ? legacy.runs : [];
  if (runs.length === 0) return null;

  /** finishedAt -> synthetic run */
  const byFinishedAt = new Map();
  for (const run of runs) {
    if (typeof run?.finishedAt !== 'string') continue;
    const id = newRunId(run.finishedAt);
    byFinishedAt.set(run.finishedAt, {
      id,
      root: run.root ?? legacy.sourceFolder ?? '',
      host: '',
      startedAt: run.startedAt ?? run.finishedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs ?? null,
      stats: {
        files: run.files ?? null,
        bytes: run.bytes ?? null,
        errors: run.errors ?? null,
        changed: run.changed ?? null,
        unchanged: run.unchanged ?? null,
      },
      files: new Map(),
      folders: new Map(),
      legacy: true,
    });
  }
  if (byFinishedAt.size === 0) return null;

  const fallback = sortRuns([...byFinishedAt.values()])[0];

  // Attribute every stored {datetime, hash} to the run that produced it, then
  // apply the delta rule oldest run first: a hash already recorded by an earlier
  // run is not a change, so it is dropped here as well. That is what retires the
  // legacy duplicate histories instead of carrying them into the new store.
  const drafts = new Map(
    [...byFinishedAt.values()].map((run) => [run.id, { run, files: new Map(), folders: new Map() }]),
  );

  for (const list of [legacy.files, legacy.folders]) {
    const isFolders = list === legacy.folders;
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry?.path !== 'string' || !Array.isArray(entry.hashes)) continue;
      for (const item of entry.hashes) {
        if (typeof item?.hash !== 'string') continue;
        const target = byFinishedAt.get(item.datetime) ?? fallback;
        const draft = drafts.get(target.id);
        const key = `${entry.path}\u0000${item.hash}`;
        if (draft[isFolders ? 'folders' : 'files'].has(key)) continue;
        const record = { path: entry.path, hash: item.hash };
        if (!isFolders) {
          if (typeof entry.size === 'number') record.size = entry.size;
          if (typeof entry.mtime === 'string') record.mtime = entry.mtime;
        }
        draft[isFolders ? 'folders' : 'files'].set(key, record);
      }
    }
  }

  const knownFiles = new Map();
  const knownFolders = new Map();
  let written = 0;
  let fileCount = 0;
  let folderCount = 0;

  // Oldest first, so each run only keeps what it actually changed.
  for (const run of [...byFinishedAt.values()].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))) {
    const draft = drafts.get(run.id);
    const files_ = [...draft.files.values()].filter((entry) => {
      if (knownFiles.get(entry.path) === entry.hash) return false;
      knownFiles.set(entry.path, entry.hash);
      return true;
    });
    const folders = [...draft.folders.values()].filter((entry) => {
      if (knownFolders.get(entry.path) === entry.hash) return false;
      knownFolders.set(entry.path, entry.hash);
      return true;
    });

    // Every legacy run is kept, even one that changed nothing, so the Runs
    // view still shows that the scan happened.
    await writeJsonFile(runFilePath(run.id), {
      id: run.id,
      host: run.host,
      root: run.root,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      stats: run.stats,
      legacy: true,
      files: files_,
      folders,
    });
    written += 1;
    fileCount += files_.length;
    folderCount += folders.length;
  }

  await rebuildIndex();

  // Keep the original as a backup; it is no longer read.
  const backup = files.hashes.replace(/\.json$/, '.migrated.json');
  await fs.rename(files.hashes, backup).catch(() => {});

  return { runs: written, files: fileCount, folders: folderCount, backup };
}