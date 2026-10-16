/**
 * Folder explorer backend: lists the contents of one directory so the browser
 * can walk the local filesystem without any native file dialog.
 */
import { Router } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export const fsRouter = Router();

/** Expand a leading `~`, then make the path absolute. */
export function expandPath(input) {
  const trimmed = String(input ?? '').trim();
  if (trimmed === '' || trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

/**
 * Resolve a user supplied path and make sure it is inside the configured root
 * jail (when there is one).
 *
 * @param {string} input
 * @param {{ mustBeDirectory?: boolean }} [options]
 */
export async function resolveBrowsable(input, { mustBeDirectory = true } = {}) {
  const abs = expandPath(input);
  const root = config.browseRoot;
  if (root && abs !== root && !abs.startsWith(root + path.sep)) {
    const err = new Error(`Path is outside the allowed root ${root}`);
    err.status = 403;
    throw err;
  }
  let stats;
  try {
    stats = await fs.stat(abs);
  } catch (err) {
    const wrapped = new Error(
      err.code === 'ENOENT' ? `No such folder: ${abs}` : `Cannot read ${abs}: ${err.message}`,
    );
    wrapped.status = err.code === 'ENOENT' ? 404 : 400;
    throw wrapped;
  }
  if (mustBeDirectory && !stats.isDirectory()) {
    const err = new Error(`Not a folder: ${abs}`);
    err.status = 400;
    throw err;
  }
  return abs;
}

/** Parent directory, or null at the filesystem root / jail boundary. */
export function parentOf(abs) {
  const parent = path.dirname(abs);
  if (parent === abs) return null;
  if (config.browseRoot) {
    if (parent === config.browseRoot) return null;
    if (!parent.startsWith(config.browseRoot + path.sep)) return null;
  }
  return parent;
}

fsRouter.get('/api/fs', async (req, res) => {
  const abs = await resolveBrowsable(req.query.path);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    const childAbs = path.join(abs, dirent.name);
    let kind = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other';
    if (dirent.isSymbolicLink()) kind = 'link';
    let size;
    if (kind === 'file') {
      try {
        size = (await fs.stat(childAbs)).size;
      } catch {
        size = undefined;
      }
    }
    entries.push({ name: dirent.name, path: childAbs, kind, size, hidden: dirent.name.startsWith('.') });
  }

  entries.sort((a, b) => {
    const dirA = a.kind === 'directory' ? 0 : 1;
    const dirB = b.kind === 'directory' ? 0 : 1;
    if (dirA !== dirB) return dirA - dirB;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  res.json({
    path: abs,
    parent: parentOf(abs),
    home: config.home,
    browseRoot: config.browseRoot,
    entries,
  });
});