/**
 * Agent validation shared by the CRUD endpoints and the link-files endpoint:
 * a record has to satisfy $defs/agent on its own and the collection it would
 * belong to.
 */
import { listAgents } from './agentsStore.js';
import { validateAgentCollection, validateAgentRecord } from './validate.js';

/**
 * @param {object} agent the record as it would be stored
 * @param {string} [previousCode] code of the record being replaced or renamed
 */
export async function checkAgent(agent, previousCode) {
  const record = await validateAgentRecord(agent);
  if (!record.valid) return record;

  // Replace the record being edited (old code and/or new code) in the
  // collection, so the check sees the state the store would be left in.
  const replaced = new Set([previousCode, agent?.code].filter(Boolean));
  const { records } = await listAgents();
  const others = records.filter((entry) => !replaced.has(entry?.code));
  return validateAgentCollection([...others, agent]);
}