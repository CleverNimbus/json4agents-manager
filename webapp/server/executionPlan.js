/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Derive the execution plan that the Hashing tab renders in its left panel.
 *
 * Inputs: the list of agent records, and the assembled hash view (the same
 * shape the existing tab already consumes). The plan answers two questions:
 *   - which agents must run, because one of their outputs or one of their
 *     inputs was reported as changed in the most recent hash run, and
 *   - which downstream agents must follow them, because they consume one of
 *     those outputs (directly or transitively), and in what order.
 *
 * An output hit means the agent's own domain moved on; an input hit means
 * something the agent reads - possibly a file no other agent produces - was
 * edited, so the agent itself must re-run. Both make the agent a root of the
 * plan.
 *
 * The matching rule for "X covers Y" is the same folder/file rule used by
 * the Agent Dependencies tab (see `agentDependencies.js`), so a folder
 * wildcard like `src/*` and a concrete file `src/main.js` agree.
 */
import { entriesOverlap } from './agentDependencies.js';

/** Mirror the `changed` rule the front-end uses in the hash grids. */
function entryChanged(entry) {
  const history = Array.isArray(entry?.hashes) ? entry.hashes : [];
  if (history.length < 2) return false;
  return history[0]?.hash !== history[1]?.hash;
}

/** All file/folder paths whose hash moved in the most recent run. */
function collectChangedPaths(view) {
  const out = [];
  for (const file of view?.files ?? []) if (entryChanged(file)) out.push(file.path);
  for (const folder of view?.folders ?? []) if (entryChanged(folder)) out.push(folder.path);
  return out;
}

/** Build a normalised agent record the planner can read cheaply. */
function normalise(agent) {
  return {
    code: agent.code,
    name: agent.name ?? '',
    phase: typeof agent.phase === 'number' ? agent.phase : 0,
    outputs: Array.isArray(agent.result_generated_files) ? agent.result_generated_files : [],
    inputs: Array.isArray(agent.source_dependant_files) ? agent.source_dependant_files : [],
  };
}

/**
 * Build the plan. `view` is the assembled hash document (the same shape
 * returned by `GET /api/hashes`); `agents` is the list of agent records.
 * Returns `{ changedPaths, steps }`; `steps` is empty when nothing has to
 * be executed.
 */
export function buildExecutionPlan(agents, view) {
  const all = (agents ?? []).map(normalise);
  const byCode = new Map(all.map((a) => [a.code, a]));

  const changedPaths = collectChangedPaths(view);
  if (changedPaths.length === 0) return { changedPaths, steps: [] };

  // Phase 1: an agent is a root when a changed path overlaps one of its
  // outputs (its own domain moved on) or one of its inputs (something it
  // reads changed, so it must re-run - even when no other agent produces
  // that path).
  const triggered = new Set();
  const triggeredBy = new Map(); // code -> [{ output, change } | { input, change }]
  for (const agent of all) {
    const hits = [];
    for (const output of agent.outputs) {
      for (const change of changedPaths) {
        if (entriesOverlap(output, change)) hits.push({ output, change });
      }
    }
    for (const input of agent.inputs) {
      for (const change of changedPaths) {
        if (entriesOverlap(input, change)) hits.push({ input, change });
      }
    }
    if (hits.length > 0) {
      triggered.add(agent.code);
      triggeredBy.set(agent.code, hits);
    }
  }
  if (triggered.size === 0) return { changedPaths, steps: [] };

  // Phase 2: BFS the downstream closure. Every (producer, consumer) edge
  // that fires is recorded so the topo sort and the UI can both read it.
  const closed = new Set(triggered);
  const queue = [...triggered];
  const edgeMap = new Map(); // consumerCode -> [{ fromCode, output, input }]
  while (queue.length > 0) {
    const producerCode = queue.shift();
    const producer = byCode.get(producerCode);
    if (!producer) continue;
    for (const consumer of all) {
      if (consumer.code === producerCode) continue;
      for (const input of consumer.inputs) {
        for (const output of producer.outputs) {
          if (!entriesOverlap(output, input)) continue;
          const list = edgeMap.get(consumer.code) ?? [];
          const dup = list.some((edge) => edge.fromCode === producerCode && edge.output === output && edge.input === input);
          if (!dup) {
            list.push({ fromCode: producerCode, output, input });
            edgeMap.set(consumer.code, list);
          }
          if (!closed.has(consumer.code)) {
            closed.add(consumer.code);
            queue.push(consumer.code);
          }
        }
      }
    }
  }

  // Phase 3: topologically order the closure. Producers run before
  // consumers; ties break on ascending phase, then on agent code.
  const order = topoSort(closed, byCode, edgeMap);

  // A root hit and a downstream edge can both apply to one agent: its own
  // input changed *and* a producer of that input is a root as well. The step
  // then carries both lists, root hits first. The reason prefers the output
  // hit, then the input hit, then plain downstream.
  const steps = order.map((code) => {
    const agent = byCode.get(code);
    const rootHits = triggeredBy.get(code) ?? [];
    const edgeHits = edgeMap.get(code) ?? [];
    const reason = rootHits.some((hit) => 'output' in hit)
      ? 'changed'
      : rootHits.length > 0
        ? 'input-changed'
        : 'downstream';
    return {
      code,
      name: agent?.name ?? '',
      phase: agent?.phase ?? 0,
      reason,
      triggers: [...rootHits, ...edgeHits],
    };
  });

  return { changedPaths, steps };
}

/**
 * Kahn's algorithm restricted to the affected agents. Cycles are tolerated:
 * whatever cannot be reached (in a DAG sense) is appended at the end, so the
 * list is always complete and the run order is still well defined.
 */
function topoSort(closed, byCode, edgeMap) {
  const inDegree = new Map();
  for (const code of closed) inDegree.set(code, 0);
  for (const [consumerCode, edges] of edgeMap) {
    if (!closed.has(consumerCode)) continue;
    // Each *distinct* producer feeding this consumer counts as one in-edge;
    // duplicate (producer, output, input) triples are already collapsed in
    // the BFS, so we count unique producers here.
    const producers = new Set(edges.map((edge) => edge.fromCode));
    inDegree.set(consumerCode, (inDegree.get(consumerCode) ?? 0) + producers.size);
  }

  /** Insert into `ready` keeping (phase asc, code asc) ordering. */
  const insertSorted = (ready, code) => {
    const phase = byCode.get(code)?.phase ?? 0;
    let index = 0;
    while (index < ready.length) {
      const other = byCode.get(ready[index])?.phase ?? 0;
      if (other < phase) { index += 1; continue; }
      if (other > phase) break;
      if (ready[index].localeCompare(code) < 0) { index += 1; continue; }
      break;
    }
    ready.splice(index, 0, code);
  };

  const ready = [];
  for (const [code, deg] of inDegree) if (deg === 0) insertSorted(ready, code);

  const order = [];
  while (ready.length > 0) {
    const code = ready.shift();
    order.push(code);
    // Decrement every consumer that the popped agent feeds.
    for (const [consumerCode, edges] of edgeMap) {
      if (!closed.has(consumerCode)) continue;
      if (!edges.some((edge) => edge.fromCode === code)) continue;
      const next = inDegree.get(consumerCode) - 1;
      inDegree.set(consumerCode, next);
      if (next === 0) insertSorted(ready, consumerCode);
    }
  }
  // Append anything left over from a cycle so the list stays complete.
  if (order.length < closed.size) {
    for (const code of closed) if (!order.includes(code)) order.push(code);
  }
  return order;
}
