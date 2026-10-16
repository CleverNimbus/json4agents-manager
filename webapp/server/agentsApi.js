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
import { loadSchema, validateAgentCollection, validateAgentRecord } from './validate.js';

export const agentsRouter = Router();

/** Validate one record, then the collection it would belong to. */
async function checkAgent(agent, previousCode) {
  const record = await validateAgentRecord(agent);
  if (!record.valid) return record;

  // Replace the record being edited (old code and/or new code) in the
  // collection, so the check sees the state the store would be left in.
  const replaced = new Set([previousCode, agent?.code].filter(Boolean));
  const { records } = await listAgents();
  const others = records.filter((entry) => !replaced.has(entry?.code));
  return validateAgentCollection([...others, agent]);
}

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

agentsRouter.get('/api/schema', async (req, res) => {
  const { schema } = await loadSchema();
  res.json(schema);
});

// Anything below that reaches this router with a bad code is an AgentStoreError.
agentsRouter.use((err, req, res, next) => {
  if (!(err instanceof AgentStoreError)) return next(err);
  return res.status(err.status).json({ error: err.message });
});