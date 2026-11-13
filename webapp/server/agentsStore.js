/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agent store: one markdown file per agent in the configured agents folder.
 *   <agentsFolder>/AG-001.md
 * The file name stem is the agent code. Codes are validated against a strict
 * pattern before they are turned into a path, so a code can never escape the
 * folder. A file is an agent when its YAML frontmatter validates against the
 * bundled frontmatter schema (see validate.js); anything else is reported as
 * an issue instead of being dropped, so broken data is visible in the UI.
 * The store is read-only: agent files are written by hand, never by the app.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { resolveAgentsFolder } from './config.js';
import { readSettings } from './settingsStore.js';
import { validateFrontmatter } from './validate.js';

/** Codes are used verbatim as file names, so keep them boring. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class AgentStoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function assertValidCode(code) {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || code === '.' || code === '..') {
    throw new AgentStoreError(
      `Invalid agent code ${JSON.stringify(code)}: use letters, digits, dot, dash or underscore (e.g. AG-001)`,
      400,
    );
  }
  return code;
}

export const fileNameFor = (code) => `${assertValidCode(code)}.md`;

/** The folder holding the agent files: the setting, or <repo>/agents. */
export async function agentsDir() {
  const settings = await readSettings();
  return resolveAgentsFolder(settings.agentsFolder);
}

async function readAgentFile(dir, code) {
  const file = path.join(dir, fileNameFor(code));
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new AgentStoreError(`No agent with code ${code}`, 404);
    throw err;
  }
  let doc;
  try {
    doc = matter(text);
  } catch (err) {
    throw new AgentStoreError(`${fileNameFor(code)} cannot be parsed: ${err.message}`, 500);
  }
  const { valid, errors } = validateFrontmatter(doc.data);
  if (!valid) {
    throw new AgentStoreError(
      `${fileNameFor(code)} does not match the agent schema: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      500,
    );
  }
  // The code is the file name stem, so it wins over any stray frontmatter key.
  return { file, agent: { ...doc.data, code, body: doc.content } };
}

/**
 * Read every agent file, keeping only the ones that are sound.
 * A file whose frontmatter does not satisfy the schema cannot be shown as a
 * row: it would claim fields the app does not have. Such files are reported
 * as issues and left out of the list.
 * @returns {Promise<{ records: Array<{code: string, agent: object, file: string}>, issues: Array<{file: string, message: string}> }>}
 */
export async function scanAgents() {
  const dir = await agentsDir();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { records: [], issues: [{ file: dir, message: 'The agents folder does not exist - create it and add <CODE>.md files' }] };
    }
    throw err;
  }
  const issues = [];
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const code = path.basename(entry.name, '.md');
    if (!CODE_PATTERN.test(code) || code === '.' || code === '..') {
      issues.push({
        file: entry.name,
        message: 'The file name is not a valid agent code: use letters, digits, dot, dash or underscore',
      });
      continue;
    }
    const file = path.join(dir, entry.name);
    let agent;
    try {
      agent = matter(await fs.readFile(file, 'utf8')).data;
    } catch (err) {
      issues.push({ file: entry.name, message: err.message });
      continue;
    }
    const { valid, errors } = validateFrontmatter(agent);
    if (!valid) {
      issues.push({ file: entry.name, message: `Does not match the agent schema: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}` });
      continue;
    }
    // The code is the file name stem, so it wins over any stray frontmatter key.
    records.push({ code, agent: { ...agent, code }, file });
  }
  // Two codes that differ only in case are two files on Linux and one file on
  // macOS or Windows, where the second write would silently clobber the first.
  const folded = new Map();
  for (const record of records) {
    const key = record.code.toLowerCase();
    const previous = folded.get(key);
    if (previous) issues.push({ file: `${record.code}.md`, message: `Code collides with ${previous} ignoring case` });
    else folded.set(key, record.code);
  }
  records.sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: 'base' }));
  return { records, issues };
}

/** Every record in the store, sorted by agent code. */
export async function listAgents() {
  const { records, issues } = await scanAgents();
  return { records: records.map((record) => record.agent), issues };
}

export async function readAgent(code) {
  const dir = await agentsDir();
  return readAgentFile(dir, assertValidCode(code));
}
