/**
 * Agent store: one JSON file per agent record in data/agents/.
 *
 *   data/agents/AG-001.json   ->  { "code": "AG-001", "name": "...", ... }
 *
 * The file name is the agent code. Codes are validated against a strict pattern
 * before they are turned into a path, so a code can never escape the folder.
 * Records are always written to a temporary file and renamed into place, and
 * the grid order is the code order (see listAgents).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { files } from './config.js';
import { writeJsonFile } from './store.js';

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

export const fileNameFor = (code) => `${assertValidCode(code)}.json`;

export const pathFor = (code) => path.join(files.agentsDir, fileNameFor(code));

export async function ensureStore() {
  await fs.mkdir(files.agentsDir, { recursive: true });
}

async function readAgentFile(code) {
  const file = pathFor(code);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new AgentStoreError(`No agent with code ${code}`, 404);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AgentStoreError(`${fileNameFor(code)} is not valid JSON: ${err.message}`, 500);
  }
}

/**
 * Every record in the store, sorted by agent code.
 *
 * A file that cannot be parsed is reported instead of being dropped, so broken
 * data is visible in the UI rather than silently disappearing.
 *
 * @returns {Promise<{ records: object[], issues: Array<{file:string,message:string}> }>}
 */
export async function listAgents() {
  const { records, issues } = await scanAgents();
  return { records: records.map((record) => record.agent), issues };
}

export async function readAgent(code) {
  await ensureStore();
  return readAgentFile(assertValidCode(code));
}

/**
 * Read every agent file, keeping only the ones whose identity is sound.
 *
 * An agent's code is its file name, so a file whose content says something else
 * cannot be addressed, renamed or deleted without creating a second copy of the
 * record. Such files are reported as issues and left out of the list rather
 * than shown as a row that would write to the wrong file.
 *
 * @returns {Promise<{ records: Array<{code: string, agent: object, file: string}>, issues: Array<{file: string, message: string}> }>}
 */
export async function scanAgents() {
  await ensureStore();
  const entries = await fs.readdir(files.agentsDir, { withFileTypes: true });
  const issues = [];
  const records = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(files.agentsDir, entry.name);

    let agent;
    try {
      agent = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      issues.push({ file: entry.name, message: err.message });
      continue;
    }

    const expected = path.basename(entry.name, '.json');
    if (typeof agent?.code !== 'string' || agent.code === '') {
      issues.push({ file: entry.name, message: 'The record has no "code" field' });
      continue;
    }
    if (agent.code !== expected) {
      issues.push({
        file: entry.name,
        message: `File name and code disagree: the file is ${expected}.json but the record says "${agent.code}"`,
      });
      continue;
    }
    records.push({ code: agent.code, agent, file });
  }

  // Two codes that differ only in case are two files on Linux and one file on
  // macOS or Windows, where the second write would silently clobber the first.
  const folded = new Map();
  for (const record of records) {
    const key = record.code.toLowerCase();
    const previous = folded.get(key);
    if (previous) issues.push({ file: path.basename(record.file), message: `Code collides with ${previous} ignoring case` });
    else folded.set(key, record.code);
  }

  records.sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: 'base' }));
  return { records, issues };
}

export async function agentExists(code) {
  try {
    await fs.access(pathFor(code));
    return true;
  } catch {
    return false;
  }
}

export async function createAgent(agent) {
  await ensureStore();
  const code = assertValidCode(agent?.code);
  if (await agentExists(code)) throw new AgentStoreError(`Agent ${code} already exists`, 409);
  await writeJsonFile(pathFor(code), agent);
  return agent;
}

/**
 * Update an agent. When the record's code changed the file is renamed too, so
 * the store stays "one file per code".
 */
export async function updateAgent(previousCode, agent) {
  await ensureStore();
  const from = assertValidCode(previousCode);
  const to = assertValidCode(agent?.code);

  if (!(await agentExists(from))) throw new AgentStoreError(`No agent with code ${from}`, 404);
  if (to !== from && (await agentExists(to))) throw new AgentStoreError(`Agent ${to} already exists`, 409);

  await writeJsonFile(pathFor(to), agent);
  if (to !== from) await fs.rm(pathFor(from), { force: true });
  return agent;
}

export async function deleteAgent(code) {
  await ensureStore();
  const target = assertValidCode(code);
  if (!(await agentExists(target))) throw new AgentStoreError(`No agent with code ${target}`, 404);
  await fs.rm(pathFor(target));
  return target;
}