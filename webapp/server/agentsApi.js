/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Agents tab backend for the per-file store in data/agents/.
 *
 *   GET    /api/agents        every record, sorted by code
 *   GET    /api/agents/:code  one record
 *   POST   /api/agents        create data/agents/<code>.json
 *   PUT    /api/agents/:code  update; renames the file when the code changes
 *   DELETE /api/agents/:code  remove the file
 *   GET    /api/schema        the JSON Schema the edit form is built from
 *
 * Writes validate the record on its own and then the whole collection, so a
 * store that somehow holds conflicting records is still caught.
 */
import { Router } from 'express';
import path from 'node:path';
import { files } from './config.js';
import {
  AgentStoreError,
  createAgent,
  deleteAgent,
  listAgents,
  pathFor,
  readAgent,
  updateAgent,
} from './agentsStore.js';
import { checkAgent } from './agentsValidation.js';
import { readSettings } from './settingsStore.js';
import { loadSchema, validateAgentCollection, validateAgentRecord } from './validate.js';

export const agentsRouter = Router();

agentsRouter.get('/api/agents', async (req, res) => {
  const { records, issues } = await listAgents();
  const errors = [...issues.map((issue) => ({ path: issue.file, message: issue.message }))];

  // Report records that are readable but do not satisfy the schema.
  for (const agent of records) {
    const { valid, errors: recordErrors } = await validateAgentRecord(agent);
    if (!valid) {
      errors.push(...recordErrors.map((err) => ({ path: String(agent?.code ?? '?') + err.path, message: err.message })));
    }
  }

  const collection = await validateAgentCollection(records);
  errors.push(...collection.errors.filter((err) => !err.path.startsWith('/agents/')));

  res.json({ dir: files.agentsDir, agents: records, valid: errors.length === 0, errors });
});

agentsRouter.get('/api/agents/:code', async (req, res) => {
  res.json({ file: pathFor(req.params.code), agent: await readAgent(req.params.code) });
});

agentsRouter.post('/api/agents', async (req, res) => {
  const agent = req.body?.agent;
  const checked = await checkAgent(agent);
  if (!checked.valid) return res.status(400).json({ error: 'Agent does not match the schema', errors: checked.errors });

  const created = await createAgent(agent);
  return res.status(201).json({ ok: true, file: pathFor(created.code), agent: created });
});

agentsRouter.put('/api/agents/:code', async (req, res) => {
  const agent = req.body?.agent;
  const checked = await checkAgent(agent, req.params.code);
  if (!checked.valid) return res.status(400).json({ error: 'Agent does not match the schema', errors: checked.errors });

  const updated = await updateAgent(req.params.code, agent);
  return res.json({ ok: true, file: pathFor(updated.code), agent: updated });
});

agentsRouter.delete('/api/agents/:code', async (req, res) => {
  const code = await deleteAgent(req.params.code);
  return res.json({ ok: true, deleted: code });
});

/**
 * Link uncommitted files to an agent: adds each path to the agent's
 * result_generated_files, keeping the order and skipping paths already listed.
 * Paths must be relative to the configured git root.
 */
agentsRouter.post('/api/agents/:code/link-files', async (req, res) => {
  const { paths } = req.body ?? {};
  if (!Array.isArray(paths)) {
    return res.status(400).json({ error: 'Expected { "paths": ["relative/path", …] }' });
  }
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return res.status(400).json({ error: 'Every path must be a non empty string' });
    }
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      return res.status(400).json({ error: `Path must be relative to the git root: ${entry}` });
    }
  }

  const { gitRoot } = await readSettings();
  const agent = await readAgent(req.params.code);
  const existing = Array.isArray(agent.result_generated_files) ? agent.result_generated_files : [];
  const known = new Set(existing);

  const added = [];
  for (const entry of paths.map((value) => value.trim())) {
    if (known.has(entry)) continue;
    known.add(entry);
    added.push(entry);
  }

  if (added.length === 0) {
    return res.json({ ok: true, file: pathFor(agent.code), agent, added: [], alreadyPresent: paths.length, gitRoot });
  }

  const updated = { ...agent, result_generated_files: [...existing, ...added] };
  const checked = await checkAgent(updated, agent.code);
  if (!checked.valid) {
    return res.status(400).json({ error: 'The agent would not match the schema', errors: checked.errors });
  }

  const saved = await updateAgent(agent.code, updated);
  return res.json({
    ok: true,
    file: pathFor(saved.code),
    agent: saved,
    added,
    alreadyPresent: paths.length - added.length,
    gitRoot,
  });
});

agentsRouter.get('/api/schema', async (req, res) => {
  const { schema } = await loadSchema();
  res.json(schema);
});

// Anything below that reaches this router with a bad code is an AgentStoreError.
agentsRouter.use((err, req, res, next) => {
  if (!(err instanceof AgentStoreError)) return next(err);
  return res.status(err.status).json({ error: err.message });
});