/**
 * Folder hashing.
 *
 * 1. Walk the tree once to collect every file (path, size, mtime) and every
 *    folder, so the UI can show a total up front.
 * 2. Hash the files with streaming SHA-256 and a bounded number of parallel
 *    reads, emitting one progress event per file.
 * 3. Roll every folder up bottom up: the folder hash is the SHA-256 of
 *    `name \0 childHash \u001e` for every child (folders and files, sorted by
 *    name).
 *
 * Step 3 is the exact algorithm the previous browser based implementation used,
 * so re-hashing a tree produces the same folder hashes as hashes.json already
 * contains. An empty folder hashes to the digest of the empty string.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const HASH_CONCURRENCY = 8;
const NAME_SEP = '\u0000';
const ENTRY_SEP = '\u001e';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Folder hash from its children: sha256 over `name \0 childHash \u001e` for
 * every child, folders and files together, sorted by name.
 *
 * Exported so integrity checks recompute exactly what the runner wrote instead
 * of a second implementation that could drift.
 *
 * @param {Array<{name: string, hash: string}>} children
 */
export function rollupHash(children) {
  const parts = [...children]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => `${child.name}${NAME_SEP}${child.hash}${ENTRY_SEP}`)
    .join('');
  return sha256Hex(parts);
}

function abortError() {
  const err = new Error('Hashing cancelled');
  err.name = 'AbortError';
  return err;
}

/** Run `worker` over every item, at most `limit` at a time. */
async function forEachLimited(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function hashFile(abs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const hash = createHash('sha256');
    const stream = createReadStream(abs);
    const onAbort = () => stream.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * @param {string} root absolute folder path
 * @returns {Promise<{ folders: Map<string, {childDirs:Set<string>, files:Array}> }>}
 */
async function scanTree(root, { includeHidden, followSymlinks }, signal) {
  const folders = new Map([['', { childDirs: new Set(), files: [] }]]);
  const visitedLinks = new Set();
  const stack = [''];

  while (stack.length > 0) {
    if (signal?.aborted) throw abortError();
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    const dir = await fs.opendir(abs);

    for await (const dirent of dir) {
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const childAbs = path.join(abs, dirent.name);
      const isLink = dirent.isSymbolicLink();

      if (isLink && !followSymlinks) continue;
      if (isLink && visitedLinks.has(childAbs)) continue;
      if (isLink) visitedLinks.add(childAbs);

      // Directories need no extra stat: the dirent already knows the kind.
      if (!isLink && dirent.isDirectory()) {
        folders.get(rel).childDirs.add(childRel);
        folders.set(childRel, { childDirs: new Set(), files: [] });
        stack.push(childRel);
        continue;
      }

      // Files need size + mtime, symlinks need resolving first.
      const targetAbs = isLink ? await fs.realpath(childAbs) : childAbs;
      let stats;
      try {
        stats = await fs.stat(targetAbs);
      } catch {
        continue; // dangling symlink
      }

      if (stats.isDirectory()) {
        folders.get(rel).childDirs.add(childRel);
        folders.set(childRel, { childDirs: new Set(), files: [] });
        stack.push(childRel);
      } else if (stats.isFile()) {
        folders.get(rel).files.push({
          path: childRel,
          name: dirent.name,
          abs: targetAbs,
          size: stats.size,
          mtime: stats.mtime.toISOString(),
        });
      }
    }
  }

  return { folders };
}

/**
 * Hash a folder tree.
 *
 * @param {string} root absolute folder path
 * @param {object} options
 * @param {(event: object) => void} options.onEvent progress callback
 * @param {AbortSignal} [options.signal]
 */
export async function hashFolder(root, { includeHidden = true, followSymlinks = false } = {}, onEvent = () => {}, signal) {
  const startedAt = new Date();
  onEvent({ type: 'scan', root, startedAt: startedAt.toISOString() });

  const { folders } = await scanTree(root, { includeHidden, followSymlinks }, signal);
  const allFiles = [...folders.values()].flatMap((dir) => dir.files);

  onEvent({ type: 'scan-done', total: allFiles.length });

  const errors = [];
  const fileHashes = new Map();
  let done = 0;
  let bytes = 0;

  await forEachLimited(allFiles, HASH_CONCURRENCY, async (file) => {
    if (signal?.aborted) throw abortError();
    try {
      const hash = await hashFile(file.abs, signal);
      fileHashes.set(file.path, hash);
      done += 1;
      bytes += file.size;
      onEvent({
        type: 'file',
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        hash,
        done,
        total: allFiles.length,
        bytes,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      errors.push({ path: file.path, message: err.message });
      onEvent({ type: 'file-error', path: file.path, message: err.message, done, total: allFiles.length });
    }
  });

  // Bottom up rollup: deepest folders first.
  const ordered = [...folders.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
  const folderHashes = new Map();
  const folderList = [];

  for (const rel of ordered) {
    const dir = folders.get(rel);
    // Children (folders and files together) are sorted by name, which is the
    // order the previous browser implementation used for the files of a leaf.
    const children = [
      ...[...dir.childDirs].map((child) => ({ name: path.basename(child), hash: folderHashes.get(child) })),
      ...dir.files
        .map((file) => ({ name: file.name, hash: fileHashes.get(file.path) }))
        .filter((file) => file.hash),
    ];

    const hash = rollupHash(children);
    folderHashes.set(rel, hash);
    folderList.push({ path: rel === '' ? '.' : rel, hash });
    onEvent({ type: 'folder', path: rel === '' ? '.' : rel, hash, done: folderList.length, total: folderHashes.size });
  }

  const finishedAt = new Date();
  const files = allFiles
    .filter((file) => fileHashes.has(file.path))
    .map((file) => ({ path: file.path, size: file.size, mtime: file.mtime, hash: fileHashes.get(file.path) }));

  return {
    root,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    folders: folderList,
    files,
    stats: { files: files.length, bytes, errors: errors.length },
    errors,
  };
}