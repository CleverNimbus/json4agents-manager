/**
 * JSON Schema validation for the agent store.
 *
 * agents.schema.json is the single source of truth: it is compiled once per
 * process with Ajv's draft 2020-12 dialect, so the browser needs no validator of
 * its own. Every write is checked twice:
 *
 *   1. against $defs/agent  - the single record, which gives precise errors
 *   2. against the root     - the whole collection as if it were one document,
 *                             which catches cross record problems
 */
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { files } from './config.js';

/** @type {Promise<{ schema: object, collection: Function, record: Function }> | null} */
let compiled = null;

/**
 * Drop the compiled schema. Required when the data folder changes, otherwise
 * the app would keep validating against the previous folder's schema.
 */
export function resetSchemaCache() {
  compiled = null;
}

export function loadSchema() {
  if (!compiled) {
    compiled = (async () => {
      const schema = JSON.parse(await readFile(files.schema, 'utf8'));
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      const collection = ajv.compile(schema);
      const record = ajv.getSchema(`${schema.$id ?? ''}#/$defs/agent`) ?? ajv.getSchema('#/$defs/agent');
      if (!record) throw new Error('agents.schema.json has no $defs/agent definition');
      return { schema, collection, record };
    })().catch((err) => {
      // Never keep a rejected compile cached: fixing the file (or switching the
      // data folder) has to work without restarting the server.
      compiled = null;
      throw err;
    });
  }
  return compiled;
}

function toIssues(errors) {
  return (errors ?? []).map((err) => ({
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message ?? 'is invalid',
  }));
}

/**
 * Validate one agent record on its own.
 *
 * @param {unknown} agent parsed content of one agent file
 */
export async function validateAgentRecord(agent) {
  const { record } = await loadSchema();
  const valid = record(agent);
  return { valid: Boolean(valid), errors: valid ? [] : toIssues(record.errors) };
}

/**
 * Validate a whole collection. `records` are re-validated as one document so
 * the root level rules (agents array required, no extra keys) still apply.
 */
export async function validateAgentCollection(records) {
  const { collection } = await loadSchema();
  const valid = collection({ agents: records });
  return { valid: Boolean(valid), errors: valid ? [] : toIssues(collection.errors) };
}