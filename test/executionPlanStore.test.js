/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { patchPlanDone, readPlan, writePlan } from '../webapp/server/executionPlanStore.js';
import { pointAt, tempDir } from './helpers.js';
import { resetSchemaCache } from '../webapp/server/validate.js';

before(async () => {
  const dir = await tempDir('exec-plan-store');
  pointAt(dir);
  resetSchemaCache();
});

const samplePlan = (overrides = {}) => ({
  version: 1,
  generatedAt: '2026-10-17T10:00:00Z',
  changedPaths: ['out/root-report.md'],
  steps: [
    { code: 'AG-001', name: 'Root', phase: 1, reason: 'changed', triggers: [{ output: 'out/X.md', change: 'out/X.md' }], done: false },
    { code: 'AG-002', name: 'Consumer', phase: 2, reason: 'downstream', triggers: [{ fromCode: 'AG-001', output: 'out/X.md', input: 'out/*' }], done: false },
  ],
  ...overrides,
});

describe('executionPlanStore', () => {
  it('returns the empty shape when no plan file exists', async () => {
    const plan = await readPlan();
    assert.deepEqual(plan, { version: 1, generatedAt: '', changedPaths: [], steps: [] });
  });

  it('writes the plan to disk and reads it back unchanged', async () => {
    const stored = await writePlan(samplePlan());
    assert.equal(stored.steps.length, 2);
    const round = await readPlan();
    assert.deepEqual(round, stored);
  });

  it('drops fields the on-disk shape does not expect', async () => {
    await writePlan({
      steps: [
        { code: 'AG-X', name: 'X', phase: 9, reason: 'changed', triggers: [{}], done: true, extra: 'ignored' },
      ],
    });
    const plan = await readPlan();
    assert.equal(plan.steps[0].code, 'AG-X');
    assert.equal(plan.steps[0].done, true);
    assert.equal(plan.steps[0].extra, undefined);
  });

  it('toggles the done flag of an existing step and leaves the rest alone', async () => {
    await writePlan(samplePlan());
    const before = await readPlan();
    const target = before.steps[0].code;
    const afterPlan = await patchPlanDone({ steps: [{ code: target, done: true }] });
    const changed = afterPlan.steps.find((step) => step.code === target);
    assert.equal(changed.done, true);
    // The other step kept its previous value (false).
    const other = afterPlan.steps.find((step) => step.code !== target);
    assert.equal(other.done, false);
  });

  it('writes the updated plan to disk after a patch', async () => {
    await writePlan(samplePlan());
    const target = (await readPlan()).steps[0].code;
    await patchPlanDone({ steps: [{ code: target, done: true }] });
    const onDisk = await readPlan();
    const step = onDisk.steps.find((entry) => entry.code === target);
    assert.equal(step.done, true);
  });

  it('ignores unknown codes in the patch', async () => {
    await writePlan(samplePlan());
    const result = await patchPlanDone({ steps: [{ code: 'AG-DOES-NOT-EXIST', done: true }] });
    for (const step of result.steps) assert.equal(step.done, false);
  });
});
