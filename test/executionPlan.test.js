/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildExecutionPlan } from '../webapp/server/executionPlan.js';

const ag = (code, { name = `Agent ${code}`, phase = 1, inputs = [], outputs = [] } = {}) => ({
  code,
  name,
  phase,
  source_dependant_files: inputs,
  result_generated_files: outputs,
});

/** Build the minimum `view` shape the planner reads (the assembled hash doc). */
const viewOf = (files = [], folders = []) => ({ files, folders });

/** A file entry that has been hashed twice with different content. */
const changedFile = (path, latest, previous) => ({
  path,
  hashes: [{ hash: latest }, { hash: previous }],
});
/** A file entry whose hash is stable. */
const stableFile = (path, hash) => ({ path, hashes: [{ hash }] });

describe('buildExecutionPlan', () => {
  it('returns an empty plan when there are no hash runs', () => {
    const plan = buildExecutionPlan([ag('A', { outputs: ['out/X.md'] })], viewOf());
    assert.deepEqual(plan.changedPaths, []);
    assert.deepEqual(plan.steps, []);
  });

  it('returns an empty plan when the latest run introduced no changes', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/X.md'] })],
      viewOf([stableFile('out/X.md', 'h1')]),
    );
    assert.deepEqual(plan.steps, []);
  });

  it('returns an empty plan when changes do not match any agent output', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/X.md'] })],
      viewOf([changedFile('docs/r.md', 'h2', 'h1')]),
    );
    assert.deepEqual(plan.steps, []);
  });

  it('lists an agent whose output is exactly a changed file', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/X.md'] })],
      viewOf([changedFile('out/X.md', 'new', 'old')]),
    );
    assert.deepEqual(plan.changedPaths, ['out/X.md']);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].code, 'A');
    assert.equal(plan.steps[0].reason, 'changed');
    assert.deepEqual(plan.steps[0].triggers, [{ output: 'out/X.md', change: 'out/X.md' }]);
  });

  it('lists an agent when a changed file lies inside its folder output', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/*'] })],
      viewOf([changedFile('out/X.md', 'new', 'old')]),
    );
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].code, 'A');
  });

  it('lists an agent when a changed folder is exactly its wildcard output', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/*'] })],
      viewOf([], [changedFile('out', 'h2', 'h1')]),
    );
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].code, 'A');
  });

  it('adds a consumer whose input changed: it is a root, yet still ordered after its producer', () => {
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, outputs: ['out/*'] }),
        ag('B', { phase: 2, inputs: ['out/X.md'] }),
      ],
      viewOf([changedFile('out/X.md', 'new', 'old')]),
    );
    const codes = plan.steps.map((step) => step.code);
    assert.deepEqual(codes, ['A', 'B'], 'the topo sort still puts the producer first');
    assert.equal(plan.steps[1].reason, 'input-changed', 'B re-runs because its own input changed');
    const edge = plan.steps[1].triggers.find((trigger) => trigger.fromCode === 'A');
    assert.ok(edge, 'the downstream edge is still reported alongside the input hit');
  });

  it('walks the full transitive downstream chain (grandchild included)', () => {
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, outputs: ['out/*'] }),
        ag('B', { phase: 2, inputs: ['out/X.md'], outputs: ['build/*'] }),
        ag('C', { phase: 3, inputs: ['build/app.bin'] }),
      ],
      viewOf([changedFile('out/X.md', 'new', 'old')]),
    );
    const codes = plan.steps.map((step) => step.code);
    assert.deepEqual(codes, ['A', 'B', 'C']);
    assert.equal(plan.steps[2].reason, 'downstream');
    assert.equal(plan.steps[2].triggers[0].fromCode, 'B');
  });

  it('orders a diamond by phase first, then by code', () => {
    // A triggers; B and C both consume A and each produce something D needs.
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, outputs: ['out/*'] }),
        ag('B', { phase: 2, inputs: ['out/X.md'], outputs: ['build/*'] }),
        ag('C', { phase: 2, inputs: ['out/Y.md'], outputs: ['tests/*'] }),
        ag('D', { phase: 3, inputs: ['build/*', 'tests/*'] }),
      ],
      viewOf([changedFile('out/X.md', 'n', 'o'), changedFile('out/Y.md', 'n', 'o')]),
    );
    const codes = plan.steps.map((step) => step.code);
    // A first (phase 1). B and C share phase 2 and no order between them, so
    // they sort alphabetically. D is phase 3 so it comes last.
    assert.deepEqual(codes, ['A', 'B', 'C', 'D']);
  });

  it('aggregates every trigger on a single triggered step', () => {
    const plan = buildExecutionPlan(
      [ag('A', { outputs: ['out/X.md', 'src/main.js'] })],
      viewOf([changedFile('out/X.md', 'n', 'o'), changedFile('src/main.js', 'n', 'o')]),
    );
    assert.equal(plan.steps[0].triggers.length, 2);
  });

  it('aggregates every matching edge on a single downstream step', () => {
    // A produces two things; B consumes both, so B is downstream of A on
    // two distinct edges. B's input `out/*` also overlaps the changed path,
    // so the step carries the input root hit as well.
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, outputs: ['out/X.md', 'src/*'] }),
        ag('B', { phase: 2, inputs: ['out/*', 'src/main.js'] }),
      ],
      viewOf([changedFile('out/X.md', 'n', 'o')]),
    );
    const step = plan.steps[1];
    assert.equal(step.reason, 'input-changed');
    assert.equal(step.triggers.filter((trigger) => trigger.fromCode).length, 2, 'two downstream edges');
    assert.equal(step.triggers.filter((trigger) => trigger.input && !trigger.fromCode).length, 1, 'one input root hit');
  });

  it('survives a cycle by appending the leftover agent at the end', () => {
    // B consumes A and A consumes B - a cycle. A is also the triggered
    // agent, so the closure is {A, B}. The topo must still produce both.
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, outputs: ['out/*'], inputs: ['build/*'] }),
        ag('B', { phase: 2, outputs: ['build/*'], inputs: ['out/*'] }),
      ],
      viewOf([changedFile('out/X.md', 'n', 'o')]),
    );
    const codes = plan.steps.map((step) => step.code);
    assert.deepEqual(codes.sort(), ['A', 'B']);
    assert.equal(plan.steps.length, 2);
  });

  it('lists an agent whose input is exactly a changed file, even when no agent produces it', () => {
    const plan = buildExecutionPlan(
      [ag('A', { inputs: ['cfg/app.json'] })],
      viewOf([changedFile('cfg/app.json', 'new', 'old')]),
    );
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].reason, 'input-changed');
    assert.deepEqual(plan.steps[0].triggers, [{ input: 'cfg/app.json', change: 'cfg/app.json' }]);
  });

  it('lists an agent when a changed file lies inside its folder input', () => {
    const plan = buildExecutionPlan(
      [ag('A', { inputs: ['cfg/*'] })],
      viewOf([changedFile('cfg/app.json', 'new', 'old')]),
    );
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].reason, 'input-changed');
  });

  it('prefers the output reason when one agent is hit on both sides, and reports both hits', () => {
    const plan = buildExecutionPlan(
      [ag('A', { inputs: ['cfg/*'], outputs: ['out/*'] })],
      viewOf([changedFile('out/X.md', 'n', 'o'), changedFile('cfg/app.json', 'n', 'o')]),
    );
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].reason, 'changed');
    assert.equal(plan.steps[0].triggers.length, 2, 'one output hit and one input hit');
  });

  it('fans out downstream from an input-changed root', () => {
    const plan = buildExecutionPlan(
      [
        ag('A', { phase: 1, inputs: ['cfg/app.json'], outputs: ['out/*'] }),
        ag('B', { phase: 2, inputs: ['out/X.md'] }),
      ],
      viewOf([changedFile('cfg/app.json', 'new', 'old')]),
    );
    const codes = plan.steps.map((step) => step.code);
    assert.deepEqual(codes, ['A', 'B']);
    assert.equal(plan.steps[0].reason, 'input-changed');
    assert.equal(plan.steps[1].reason, 'downstream', 'B reads an output of A, whose input changed');
  });
});
