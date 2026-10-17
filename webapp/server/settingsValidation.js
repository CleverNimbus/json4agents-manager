/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Rules for the workspace settings, enforced on the server before anything is
 * written. The browser mirrors them for instant feedback, but this is the copy
 * that counts.
 *
 *  - both fields empty  -> nothing configured, allowed
 *  - only one filled in -> refused, they are configured as a pair
 *  - git root           -> must be a folder containing a git repository
 *  - workspace folder   -> must be the git root itself or a folder inside it
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * @param {{ workspaceFolder?: string, gitRoot?: string }} settings
 * @returns {Promise<{ valid: boolean, errors: Array<{ field: string, message: string }> }>}
 */
export async function validateWorkspaceSettings(settings) {
  const workspaceFolder = String(settings?.workspaceFolder ?? '').trim();
  const gitRoot = String(settings?.gitRoot ?? '').trim();
  const errors = [];

  if (workspaceFolder === '' && gitRoot === '') return { valid: true, errors };
  if (workspaceFolder === '') errors.push({ field: 'workspaceFolder', message: 'Set a workspace folder, or clear both fields.' });
  if (gitRoot === '') errors.push({ field: 'gitRoot', message: 'Set the workspace git root, or clear both fields.' });

  let resolvedRoot;
  if (gitRoot !== '') {
    let stats = null;
    try {
      stats = await fs.stat(gitRoot);
    } catch {
      errors.push({ field: 'gitRoot', message: `No such folder: ${gitRoot}` });
    }

    if (stats?.isDirectory()) {
      resolvedRoot = path.resolve(gitRoot);
      // A git repository is a .git directory, or a .git file when the folder is
      // a worktree or a submodule checkout.
      let hasGit = false;
      try {
        const stats = await fs.lstat(path.join(resolvedRoot, '.git'));
        hasGit = stats.isDirectory() || stats.isFile();
      } catch {
        hasGit = false;
      }
      if (!hasGit) errors.push({ field: 'gitRoot', message: `Not a git repository: ${gitRoot} has no .git` });
    } else if (stats) {
      errors.push({ field: 'gitRoot', message: `Not a folder: ${gitRoot}` });
    }
  }

  if (workspaceFolder !== '' && resolvedRoot) {
    if (!isInside(path.resolve(workspaceFolder), resolvedRoot)) {
      errors.push({
        field: 'workspaceFolder',
        message: `Workspace folder must be the git root or a folder inside it (${gitRoot})`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}