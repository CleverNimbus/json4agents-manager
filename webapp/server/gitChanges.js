/**
 * Uncommitted git changes inside the workspace folder.
 *
 * The workspace folder and the git root come from data/settings.json (Settings
 * tab). Everything is reported relative to the git root, because that is what
 * gets written into an agent's result_generated_files.
 *
 * "Changed since the last commit" means whatever git status still reports:
 * modified, staged, added, renamed, copied and untracked files. Deleted and
 * unmerged paths are left out - there is nothing to link to.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readSettings } from './settingsStore.js';

const run = promisify(execFile);

/** Parse `git status --porcelain -z` into { code, path } entries. */
export function parsePorcelain(output) {
  const entries = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === '') continue;
    entries.push({ code: field.slice(0, 2), path: field.slice(3) });
    // Renames and copies are followed by the old path in a second NUL field.
    if (field[0] === 'R' || field[0] === 'C') i += 1;
  }
  return entries;
}

function describeStatus(code) {
  if (code === '??') return 'untracked';
  if (code[0] === 'R') return 'renamed';
  if (code[0] === 'C') return 'copied';
  if (code[0] === 'A' || code[1] === 'A') return 'added';
  if (code[0] === 'M' && code[1] === ' ') return 'staged';
  if (code[0] === ' ' && code[1] === 'M') return 'modified';
  if (code[0] === 'M' && code[1] === 'M') return 'modified';
  return code.trim() || 'modified';
}

const isUnusable = (code) => code.includes('D') || code.includes('U') || code === 'AA';

const toPosix = (value) => value.split(path.sep).join('/');

/**
 * @returns {Promise<{configured: false} | {configured: true, workspaceFolder: string, gitRoot: string, files: Array<{path:string,workspacePath:string,size:number,status:string,statusCode:string}>, hidden: number}>}
 */
export async function listUncommittedFiles() {
  const { workspaceFolder, gitRoot } = await readSettings();
  if (!workspaceFolder || !gitRoot) return { configured: false };

  let output;
  try {
    ({ stdout: output } = await run(
      'git',
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: gitRoot, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
    ));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('git is not installed or not on PATH');
      error.status = 500;
      throw error;
    }
    const error = new Error(`git status failed in ${gitRoot}: ${err.stderr?.trim() || err.message}`);
    error.status = 400;
    throw error;
  }

  const workspace = path.resolve(workspaceFolder);
  const root = path.resolve(gitRoot);
  const files = [];
  let hidden = 0;

  for (const entry of parsePorcelain(output)) {
    if (isUnusable(entry.code)) {
      hidden += 1;
      continue;
    }
    const absolute = path.resolve(root, entry.path);

    // Only files below the workspace folder, and only real files (a submodule
    // or a bare directory entry has nothing to link).
    const insideWorkspace = path.relative(workspace, absolute);
    if (insideWorkspace.startsWith('..') || path.isAbsolute(insideWorkspace)) continue;
    let stats;
    try {
      stats = await fs.stat(absolute);
      if (!stats.isFile()) continue;
    } catch {
      continue;
    }

    files.push({
      path: toPosix(path.relative(root, absolute)),
      workspacePath: toPosix(insideWorkspace),
      size: stats.size,
      status: describeStatus(entry.code),
      statusCode: entry.code,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return { configured: true, workspaceFolder, gitRoot, files, hidden };
}