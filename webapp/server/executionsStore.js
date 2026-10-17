/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Execution receipts: one immutable file per published agent run.
 *
 *   data/executions/<receiptId>.json   written once, committed to git
 *
 * A receipt says: "this agent, with exactly these input blobs, produced
 * exactly these output blobs". It stores git-root-relative paths, the git
 * blob oid and the sha256 of the content - never the content itself, never
 * an absolute path, never the machine name. Receipts are separate immutable
 * files, so two teammates recording runs at the same time merge as plain
 * additions: no shared document, no conflict.
 *
 * Recording hashes the git *index*, not the dirty worktree: every input and
 * output must be staged (or unchanged from HEAD) so the receipt describes
 * exactly what the next commit will carry. Unpushed receipts do not exist
 * for the rest of the team - which is the point: only published runs count.
 *
 * The forbidden rule: a path already covered by a receipt for the same
 * agent and the same input blobs can never be re-recorded. Identical
 * content would be noise; different content means the output was edited
 * without re-running the agent, and publishing that would pretend a human
 * edit was agent-generated. Restore the recorded blob, or change the inputs
 * and re-run.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { files } from './config.js';
import { parsePorcelain } from './gitChanges.js';
import { sha256Hex } from './hashRunner.js';
import { readSettings } from './settingsStore.js';
import { readJsonFile, writeJsonFile } from './store.js';

const run = promisify(execFile);
const RECEIPT_FILE = /\.json$/;

/** Newest first; ties broken by id, like the hash store. */
const sortReceipts = (receipts) =>
  [...receipts].sort((a, b) => {
    const delta = String(b.recordedAt).localeCompare(String(a.recordedAt));
    return delta !== 0 ? delta : String(b.id).localeCompare(String(a.id));
  });

// --------------------------------------------------------------- git helpers

async function git(gitRoot, args) {
  try {
    const { stdout } = await run('git', args, {
      cwd: gitRoot,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('git is not installed or not on PATH');
      error.status = 500;
      throw error;
    }
    const error = new Error(`git ${args[0]} failed in ${gitRoot}: ${err.stderr?.trim() || err.message}`);
    error.status = 400;
    throw error;
  }
}

/** Map git-root-relative path -> two letter porcelain status code. */
export async function statusCodes(gitRoot) {
  const output = await git(gitRoot, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const map = new Map();
  for (const entry of parsePorcelain(output)) map.set(entry.path, entry.code);
  return map;
}

/** Map path -> blob oid currently in the index. One call for every path. */
export async function indexBlobs(gitRoot, paths) {
  const map = new Map();
  if (paths.length === 0) return map;
  const output = await git(gitRoot, ['ls-files', '-s', '-z', '--', ...paths]);
  for (const field of output.split('\0')) {
    if (field === '') continue;
    const tab = field.indexOf('\t');
    if (tab < 0) continue;
    const oid = field.slice(0, tab).split(' ')[1];
    if (oid) map.set(field.slice(tab + 1), oid);
  }
  return map;
}

/**
 * Map path -> blob oid on HEAD. An unborn branch (fresh repository, nothing
 * committed yet) simply has no HEAD entries; that is not an error.
 */
export async function headBlobs(gitRoot, paths) {
  const map = new Map();
  if (paths.length === 0) return map;
  let output;
  try {
    output = await git(gitRoot, ['ls-tree', '-r', '-z', 'HEAD', '--', ...paths]);
  } catch {
    return map;
  }
  for (const field of output.split('\0')) {
    if (field === '') continue;
    const tab = field.indexOf('\t');
    if (tab < 0) continue;
    const parts = field.slice(0, tab).split(/\s+/);
    if (parts[1] === 'blob' && parts[2]) map.set(field.slice(tab + 1), parts[2]);
  }
  return map;
}

// --------------------------------------------------------------- receipts

export async function ensureStore() {
  await fs.mkdir(files.executionsDir, { recursive: true });
}

/**
 * Receipt id: the recorded timestamp plus a short random suffix, so sorting
 * by id sorts by time and two receipts can never collide.
 */
function newReceiptId(recordedAt) {
  const stamp = String(recordedAt).replace(/[:.]/g, '-');
  return `${stamp}_${randomUUID().slice(0, 8)}`;
}

export function receiptFilePath(id) {
  return path.join(files.executionsDir, `${id}.json`);
}

export async function listReceiptFiles() {
  await ensureStore();
  const entries = await fs.readdir(files.executionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && RECEIPT_FILE.test(entry.name))
    .map((entry) => path.join(files.executionsDir, entry.name))
    .sort();
}

/** One damaged receipt must not take the whole store down. */
export async function readReceipt(file) {
  let receipt;
  try {
    receipt = await readJsonFile(file, null);
  } catch {
    return null;
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const entries = (list) =>
    Array.isArray(list)
      ? list
          .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
          .map((entry) => ({
            path: entry.path,
            blob: typeof entry.blob === 'string' ? entry.blob : '',
            sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
          }))
      : [];
  return {
    id: typeof receipt.id === 'string' ? receipt.id : path.basename(file, '.json'),
    file,
    agent: typeof receipt.agent === 'string' ? receipt.agent : '',
    recordedAt: typeof receipt.recordedAt === 'string' ? receipt.recordedAt : '',
    inputs: entries(receipt.inputs),
    outputs: entries(receipt.outputs),
  };
}

export async function readAllReceipts() {
  const receiptFiles = await listReceiptFiles();
  const receipts = [];
  for (const file of receiptFiles) {
    const receipt = await readReceipt(file);
    if (receipt) receipts.push(receipt);
  }
  return sortReceipts(receipts);
}

export async function readBrokenReceiptFiles() {
  const receiptFiles = await listReceiptFiles();
  const broken = [];
  for (const file of receiptFiles) {
    try {
      const receipt = await readJsonFile(file, null);
      if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
        broken.push({ file, message: 'not a receipt object' });
      }
    } catch (err) {
      broken.push({ file, message: err.message });
    }
  }
  return broken;
}

// --------------------------------------------------------------- recording

const isBadPath = (entry) =>
  typeof entry !== 'string' ||
  entry.trim() === '' ||
  path.isAbsolute(entry) ||
  entry.split(/[\\/]/).includes('..');

/** True when two recorded entry sets carry the same paths with same blobs. */
export function sameEntrySet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const byPath = new Map(a.map((entry) => [entry.path, entry.blob]));
  return b.every((entry) => byPath.has(entry.path) && byPath.get(entry.path) === entry.blob);
}

/**
 * Publish one execution: validate against git, refuse forbidden republishing,
 * write the immutable receipt. Never touches the agent record and never runs
 * git commit - the caller commits receipt + outputs (+ staged inputs) itself.
 *
 * @returns {Promise<{receipt: object, file: string, staged: string[]}>}
 */
export async function recordExecution({ agent: code, paths }) {
  if (typeof code !== 'string' || code.trim() === '') {
    const error = new Error('Expected { "agent": "AG-001", "paths": ["relative/path", …] }');
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    const error = new Error('Select at least one generated file to record');
    error.status = 400;
    throw error;
  }
  for (const entry of paths) {
    if (isBadPath(entry)) {
      const error = new Error(`Path must be relative to the git root: ${entry}`);
      error.status = 400;
      throw error;
    }
  }

  const { gitRoot } = await readSettings();
  if (!gitRoot) {
    const error = new Error('Configure the workspace folder and git root first (Settings tab)');
    error.status = 400;
    throw error;
  }

  // Lazy import keeps the agent store out of module load and gives 404s for
  // unknown codes through AgentStoreError.
  const { readAgent } = await import('./agentsStore.js');
  const agent = await readAgent(code.trim());

  const inputs = Array.isArray(agent.source_dependant_files) ? agent.source_dependant_files : [];
  for (const entry of inputs) {
    if (isBadPath(entry)) {
      const error = new Error(`Agent ${agent.code} lists an unusable input path: ${entry}`);
      error.status = 400;
      throw error;
    }
  }

  const outputs = [...new Set(paths.map((entry) => entry.trim()))].sort();
  const all = [...new Set([...inputs, ...outputs])].sort();

  // Every path must be exactly what the next commit will carry: staged, or
  // unchanged from HEAD. Untracked, deleted, unmerged or half staged paths
  // are refused - a receipt must never describe bytes git does not have.
  const status = await statusCodes(gitRoot);
  for (const entry of all) {
    const statusCode = status.get(entry);
    if (statusCode === undefined) continue; // clean against HEAD
    if (statusCode === '??') {
      throw badRequest(`${entry} is not tracked by git - stage it (git add) so the commit carries the recorded content`);
    }
    if (statusCode.includes('D')) throw badRequest(`${entry} is deleted - restore or stage the deletion first`);
    if (statusCode.includes('U')) throw badRequest(`${entry} is unmerged - resolve the conflict first`);
    if (statusCode[1] !== ' ') {
      throw badRequest(`${entry} has unstaged changes - stage them so the receipt matches the commit`);
    }
  }

  const blobs = await indexBlobs(gitRoot, all);
  const recorded = [];
  for (const entry of all) {
    const blob = blobs.get(entry);
    if (!blob) throw badRequest(`${entry} is not in the git index`);
    let content;
    try {
      content = await fs.readFile(path.join(gitRoot, entry));
    } catch {
      throw badRequest(`${entry} cannot be read from ${gitRoot}`);
    }
    recorded.push({ path: entry, blob, sha256: sha256Hex(content) });
  }
  const byPath = new Map(recorded.map((entry) => [entry.path, entry]));
  const inputsList = inputs.map((entry) => byPath.get(entry)).filter(Boolean);
  const outputsList = outputs.map((entry) => byPath.get(entry)).filter(Boolean);

  // The forbidden rule: same agent + same input blobs + same output path is
  // never republished, whether the content is identical (noise) or different
  // (a hand edit dressed up as an agent run).
  const conflicts = [];
  for (const existing of await readAllReceipts()) {
    if (existing.agent !== agent.code) continue;
    if (!sameEntrySet(existing.inputs, inputsList)) continue;
    for (const output of outputsList) {
      const match = existing.outputs.find((entry) => entry.path === output.path);
      if (!match) continue;
      if (match.sha256 === output.sha256 && match.blob === output.blob) {
        conflicts.push({
          path: output.path,
          message: `already recorded for these inputs by receipt ${existing.id} - nothing new to publish`,
        });
      } else {
        conflicts.push({
          path: output.path,
          message:
            `differs from receipt ${existing.id} while the inputs are unchanged - ` +
            'restore the recorded content, or change the inputs and re-run the agent',
        });
      }
    }
  }
  if (conflicts.length > 0) {
    const error = new Error('This execution is already published for the same inputs');
    error.status = 409;
    error.conflicts = conflicts;
    throw error;
  }

  const recordedAt = new Date().toISOString();
  const id = newReceiptId(recordedAt);
  const receipt = { id, agent: agent.code, recordedAt, inputs: inputsList, outputs: outputsList };
  await ensureStore();
  const file = receiptFilePath(id);
  await writeJsonFile(file, receipt);

  // What must ride the same commit: the receipt plus every path that is
  // staged right now (clean paths are already on HEAD).
  const staged = all.filter((entry) => status.has(entry));
  return { receipt, file, staged };
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// --------------------------------------------------------------- view

/**
 * Receipts plus a status computed against the current git state:
 *   valid        inputs and outputs still exactly as recorded - teammates skip
 *   stale-inputs an input changed since; a re-run is expected
 *   diverged     an output changed while inputs did not - a hand edit broke it
 *   unknown      git or settings unavailable, cannot tell
 * "Current" means the index when a path is staged, HEAD otherwise.
 */
export async function receiptsView() {
  const receipts = await readAllReceipts();
  const broken = await readBrokenReceiptFiles();
  const { gitRoot } = await readSettings();
  if (!gitRoot) {
    return {
      configured: false,
      receipts: receipts.map((receipt) => ({ ...receipt, status: 'unknown' })),
      broken: broken.map((entry) => entry.file),
    };
  }

  const paths = [...new Set(receipts.flatMap((receipt) => [...receipt.inputs, ...receipt.outputs].map((e) => e.path)))];
  let current = new Map();
  try {
    const [index, head] = await Promise.all([indexBlobs(gitRoot, paths), headBlobs(gitRoot, paths)]);
    current = new Map([...head, ...index]); // staged wins over HEAD
  } catch {
    return {
      configured: true,
      gitRoot,
      receipts: receipts.map((receipt) => ({ ...receipt, status: 'unknown' })),
      broken: broken.map((entry) => entry.file),
    };
  }

  const withStatus = receipts.map((receipt) => {
    const changed = (list) => list.some((entry) => (current.get(entry.path) ?? null) !== entry.blob);
    let status = 'valid';
    if (changed(receipt.inputs)) status = 'stale-inputs';
    else if (changed(receipt.outputs)) status = 'diverged';
    return { ...receipt, status };
  });
  return { configured: true, gitRoot, receipts: withStatus, broken: broken.map((entry) => entry.file) };
}
