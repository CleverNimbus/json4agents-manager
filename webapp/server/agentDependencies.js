/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Pure dependency analysis over a list of agent records.
 *
 * An agent A *produces for* agent B when one of A's `result_generated_files`
 * overlaps one of B's `source_dependant_files`. The overlap is not a plain
 * string match: the suffix `/*` is shorthand for "every path under this
 * folder", so a concrete file output `src/main.js` covers the folder input
 * `src/*`, and a broad output `src/*` covers the narrower input `src/sub/*`.
 *
 * The returned graph is directed: the producer is the source of the edge,
 * matching the rule that the producer is the parent of the consumer. A
 * self-edge (an agent whose own outputs overlap its own inputs) is dropped
 * to keep the picture focused on the relations between agents.
 */
const FOLDER_SUFFIX = '/*';

/** Parse an entry into either a folder reference (`prefix/*`) or a file path. */
function parseEntry(entry) {
  const raw = String(entry ?? '');
  if (raw.endsWith(FOLDER_SUFFIX)) {
    return { kind: 'folder', folder: raw.slice(0, -FOLDER_SUFFIX.length), raw };
  }
  return { kind: 'file', raw };
}

/** True when `path` lies inside the subtree described by `folder` (transitive). */
function isUnder(path, folder) {
  if (folder === '.' || folder === '') return true;
  return path === folder || path.startsWith(folder + '/');
}

/** Two entries overlap when the sets of paths they describe share at least one element. */
export function entriesOverlap(a, b) {
  const pa = parseEntry(a);
  const pb = parseEntry(b);
  if (pa.kind === 'file' && pb.kind === 'file') return pa.raw === pb.raw;
  if (pa.kind === 'folder' && pb.kind === 'file') return isUnder(pb.raw, pa.folder);
  if (pa.kind === 'file' && pb.kind === 'folder') return isUnder(pa.raw, pb.folder);
  return isUnder(pa.folder, pb.folder) || isUnder(pb.folder, pa.folder);
}

/**
 * Build the producer->consumer graph for a list of agent records. Each agent
 * contributes a node carrying the entries it owns; each overlapping pair
 * between a producer's outputs and a consumer's inputs contributes one edge
 * (with every matching (output, input) pair listed under `via`).
 */
export function findDependencies(agents) {
  const nodes = agents.map((agent) => ({
    code: agent.code,
    name: agent.name ?? '',
    outputs: Array.isArray(agent.result_generated_files) ? agent.result_generated_files : [],
    inputs: Array.isArray(agent.source_dependant_files) ? agent.source_dependant_files : [],
  }));

  const edges = [];
  for (const producer of nodes) {
    for (const consumer of nodes) {
      if (producer.code === consumer.code) continue;
      const via = [];
      for (const output of producer.outputs) {
        for (const input of consumer.inputs) {
          if (entriesOverlap(output, input)) via.push({ output, input });
        }
      }
      if (via.length > 0) {
        edges.push({ from: producer.code, to: consumer.code, via });
      }
    }
  }

  return { agents: nodes, edges };
}
