/**
 * hashes.json persistence.
 *
 * Shape (a superset of the file that shipped with the old browser app, so an
 * existing hashes.json loads without migration):
 *
 *   {
 *     "sourceFolder": "/abs/path",
 *     "generated":    "run timestamp",
 *     "runs":    [ { startedAt, finishedAt, root, files, bytes, errors, changed, unchanged } ],
 *     "folders": [ { path, hashes: [ { datetime, hash } ] } ],
 *     "files":   [ { path, size, mtime, hashes: [ { datetime, hash } ] } ]
 *   }
 *
 * Hashing the same path again appends a new timestamped hash, so the grid keeps
 * the history of every run - but only when the hash actually changed. An
 * unchanged hash is dropped, which keeps "2 hashes" meaningful: it means the
 * content changed twice, not that the folder was scanned twice.
 */
import { files } from './config.js';
import { readJsonFile, writeJsonFile } from './store.js';

const EMPTY = { folders: [], files: [], runs: [] };

function indexByPath(list) {
  const index = new Map();
  for (const entry of list) {
    if (entry && typeof entry.path === 'string') index.set(entry.path, entry);
  }
  return index;
}

/**
 * @returns {boolean} true when a hash was stored, false when it was identical
 *   to the last recorded one and therefore skipped.
 */
function appendHash(index, list, entryPath, hash, datetime, extra) {
  let entry = index.get(entryPath);
  if (!entry) {
    entry = { path: entryPath, ...extra, hashes: [] };
    list.push(entry);
    index.set(entryPath, entry);
  } else if (extra) {
    // Size and mtime always describe the most recent observation, even when
    // the content itself did not change.
    Object.assign(entry, extra);
  }

  const last = entry.hashes[entry.hashes.length - 1];
  if (last && last.hash === hash) return false;

  entry.hashes.push({ datetime, hash });
  return true;
}

const byPath = (a, b) => a.path.localeCompare(b.path);

/**
 * Merge a finished hash run into hashes.json and write it back atomically.
 *
 * @param {object} result value returned by hashFolder()
 */
export async function saveHashRun(result) {
  const existing = await readJsonFile(files.hashes, EMPTY);
  const doc = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};

  doc.folders = Array.isArray(doc.folders) ? doc.folders : [];
  doc.files = Array.isArray(doc.files) ? doc.files : [];
  doc.runs = Array.isArray(doc.runs) ? doc.runs : [];

  let changed = 0;
  let unchanged = 0;

  const foldersByPath = indexByPath(doc.folders);
  for (const folder of result.folders) {
    const stored = appendHash(foldersByPath, doc.folders, folder.path, folder.hash, result.finishedAt);
    stored ? (changed += 1) : (unchanged += 1);
  }

  const filesByPath = indexByPath(doc.files);
  for (const file of result.files) {
    const stored = appendHash(filesByPath, doc.files, file.path, file.hash, result.finishedAt, {
      size: file.size,
      mtime: file.mtime,
    });
    stored ? (changed += 1) : (unchanged += 1);
  }

  doc.runs.push({
    root: result.root,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    files: result.stats.files,
    bytes: result.stats.bytes,
    errors: result.stats.errors,
    changed,
    unchanged,
  });

  doc.folders.sort(byPath);
  doc.files.sort(byPath);
  doc.runs.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  doc.sourceFolder = result.root;
  doc.generated = result.finishedAt;

  await writeJsonFile(files.hashes, doc);
  return { changed, unchanged };
}