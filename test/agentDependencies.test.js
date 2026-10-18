/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The dependency matcher: a file or `folder/*` reference produced by one
 * agent may satisfy a reference consumed by another, and the rule is not a
 * plain string equality. These tests pin down every shape of match and the
 * shapes that must NOT match, so the visualisation in the Agent Dependencies
 * tab cannot silently drift.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consumersOf, entriesOverlap, findDependencies, producersOf } from '../webapp/server/agentDependencies.js';

const ag = (code, { name = `Agent ${code}`, inputs = [], outputs = [] } = {}) => ({
  code,
  name,
  phase: 1,
  source_dependant_files: inputs,
  result_generated_files: outputs,
});

describe('entriesOverlap', () => {
  it('matches two exact file paths that are equal', () => {
    assert.equal(entriesOverlap('out/X.md', 'out/X.md'), true);
  });

  it('rejects two exact file paths that differ', () => {
    assert.equal(entriesOverlap('out/X.md', 'out/Y.md'), false);
  });

  it('matches a file in a folder when the folder is the consumer (the motivating example)', () => {
    assert.equal(entriesOverlap('out/X.md', 'out/*'), true);
  });

  it('matches a file in a folder when the folder is the producer', () => {
    assert.equal(entriesOverlap('src/*', 'src/main.js'), true);
  });

  it('matches a nested folder against its parent folder in either direction', () => {
    assert.equal(entriesOverlap('src/*', 'src/sub/*'), true);
    assert.equal(entriesOverlap('src/sub/*', 'src/*'), true);
  });

  it('treats "./*" as the whole subtree (root wildcard)', () => {
    assert.equal(entriesOverlap('./*', 'main.js'), true);
    assert.equal(entriesOverlap('./*', 'src/main.js'), true);
    assert.equal(entriesOverlap('src/*', './*'), true);
  });

  it('does not match a root file against a sub-folder wildcard', () => {
    assert.equal(entriesOverlap('main.js', 'src/*'), false);
  });

  it('does not match two sibling folders', () => {
    assert.equal(entriesOverlap('src/*', 'docs/*'), false);
  });

  it('does not match unrelated exact paths', () => {
    assert.equal(entriesOverlap('out/X.md', 'src/main.js'), false);
  });
});

describe('findDependencies', () => {
  it('draws an edge when a file output matches an exact file input', () => {
    const graph = findDependencies([ag('A', { outputs: ['out/X.md'] }), ag('B', { inputs: ['out/X.md'] })]);

    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].from, 'A');
    assert.equal(graph.edges[0].to, 'B');
    assert.deepEqual(graph.edges[0].via, [{ output: 'out/X.md', input: 'out/X.md' }]);
  });

  it('draws an edge when a file output falls inside a folder input', () => {
    const graph = findDependencies([ag('A', { outputs: ['out/X.md'] }), ag('B', { inputs: ['out/*'] })]);

    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.edges[0].via, [{ output: 'out/X.md', input: 'out/*' }]);
  });

  it('draws an edge when a folder output covers a nested folder input', () => {
    const graph = findDependencies([ag('A', { outputs: ['src/*'] }), ag('B', { inputs: ['src/sub/*'] })]);

    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].from, 'A');
    assert.equal(graph.edges[0].to, 'B');
  });

  it('aggregates every matching (output, input) pair on a single edge', () => {
    const graph = findDependencies([
      ag('A', { outputs: ['out/X.md', 'src/*'] }),
      ag('B', { inputs: ['out/*', 'src/main.js'] }),
    ]);

    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.edges[0].via, [
      { output: 'out/X.md', input: 'out/*' },
      { output: 'src/*', input: 'src/main.js' },
    ]);
  });

  it('skips an agent whose own outputs overlap its own inputs (self-edges are noise)', () => {
    const graph = findDependencies([ag('A', { outputs: ['out/*'], inputs: ['out/X.md'] })]);

    assert.equal(graph.edges.length, 0);
  });

  it('leaves isolated agents with no edges but still in the node list', () => {
    const graph = findDependencies([ag('A', { outputs: ['out/*'] }), ag('B', { inputs: ['src/main.js'] })]);

    assert.equal(graph.edges.length, 0);
    assert.deepEqual(
      graph.agents.map((n) => n.code),
      ['A', 'B'],
    );
  });

  it('treats a missing or non-array entry list as empty', () => {
    const graph = findDependencies([ag('A', { outputs: undefined }), ag('B', {})]);

    assert.equal(graph.edges.length, 0);
    assert.equal(graph.agents[0].outputs.length, 0);
    assert.equal(graph.agents[1].inputs.length, 0);
  });

  it('builds a three-node chain and reports every link', () => {
    // A produces everything under `src/`, B reads from `src/main.js`,
    // C reads from `out/X.md` which A also produces.
    const graph = findDependencies([
      ag('A', { outputs: ['src/*', 'out/X.md'] }),
      ag('B', { inputs: ['src/main.js'] }),
      ag('C', { inputs: ['out/*'] }),
    ]);

    const links = graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
    assert.deepEqual(links, ['A->B', 'A->C']);
  });

  it('returns nodes in the order they were given', () => {
    const graph = findDependencies([ag('C'), ag('A'), ag('B')]);
    assert.deepEqual(graph.agents.map((n) => n.code), ['C', 'A', 'B']);
  });
});

describe('consumersOf', () => {
  it('names the agents whose exact input is the changed path', () => {
    const agents = [ag('A', { outputs: ['out/X.md'] }), ag('B', { inputs: ['out/X.md'] })];
    assert.deepEqual(consumersOf('out/X.md', agents), ['B']);
  });

  it('names the agents whose folder input covers the changed path', () => {
    const agents = [ag('B', { inputs: ['out/*'] }), ag('C', { inputs: ['src/main.js'] })];
    assert.deepEqual(consumersOf('out/X.md', agents), ['B']);
  });

  it('names every agent that reads the path, in the order given', () => {
    const agents = [ag('B', { inputs: ['out/*'] }), ag('C', { inputs: ['out/X.md'] }), ag('D')];
    assert.deepEqual(consumersOf('out/X.md', agents), ['B', 'C']);
  });

  it('returns an empty list when no agent reads the path', () => {
    const agents = [ag('B', { inputs: ['src/*'] })];
    assert.deepEqual(consumersOf('docs/r.md', agents), []);
  });

  it('treats a missing or non-array entry list as empty', () => {
    assert.deepEqual(consumersOf('out/X.md', [ag('B', { inputs: undefined }), ag('C', {})]), []);
  });

  it('returns an empty list when there are no agents at all', () => {
    assert.deepEqual(consumersOf('out/X.md', []), []);
  });
});

describe('producersOf', () => {
  it('names the agent whose exact output is the changed path', () => {
    const agents = [ag('A', { outputs: ['out/X.md'] }), ag('B', { inputs: ['out/X.md'] })];
    assert.deepEqual(producersOf('out/X.md', agents), ['A']);
  });

  it('names the agent whose folder output covers the changed path', () => {
    const agents = [ag('A', { outputs: ['out/*'] })];
    assert.deepEqual(producersOf('out/X.md', agents), ['A']);
  });

  it('returns an empty list when no agent produces the path', () => {
    const agents = [ag('A', { outputs: ['out/*'] })];
    assert.deepEqual(producersOf('docs/r.md', agents), []);
  });

  it('treats a missing or non-array entry list as empty', () => {
    assert.deepEqual(producersOf('out/X.md', [ag('A', {})]), []);
  });
});
