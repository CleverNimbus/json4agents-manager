/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Frontmatter validation against the bundled schema.
 *
 * The schema ships with the code (webapp/server/schemas/), so these tests pin
 * down what the file format accepts: the four required fields, the two
 * execution modes, and the closed vocabulary of information outputs. Extra
 * keys are tolerated on purpose - hand-written files grow notes over time.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateFrontmatter } from '../webapp/server/validate.js';
import { agent } from './helpers.js';

describe('validateFrontmatter', () => {
  it('accepts the fixture record', () => {
    const { valid, errors } = validateFrontmatter(agent('AG-001'));
    assert.equal(valid, true, JSON.stringify(errors));
    assert.deepEqual(errors, []);
  });

  it('accepts the other execution mode and unknown extra keys', () => {
    const { valid } = validateFrontmatter(
      agent('AG-001', { execution_mode: 'new_information_update', owner: 'sefe' }),
    );
    assert.equal(valid, true);
  });

  it('requires all four fields', () => {
    const { valid, errors } = validateFrontmatter({});
    assert.equal(valid, false);
    const missing = errors.find((e) => e.path === '/').message;
    for (const field of ['execution_mode', 'information_sources', 'information_outputs', 'generated_document_types']) {
      assert.match(missing, new RegExp(field));
    }
  });

  it('rejects an unknown execution mode', () => {
    const { valid, errors } = validateFrontmatter(agent('AG-001', { execution_mode: 'sometimes' }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.path === '/execution_mode'));
  });

  it('rejects an output outside the documented vocabulary', () => {
    const { valid, errors } = validateFrontmatter(agent('AG-001', { information_outputs: ['Vibes'] }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.path === '/information_outputs/0'));
  });

  it('rejects a list that is not a list of strings', () => {
    for (const value of ['src/a.js', ['src/a.js', 7]]) {
      assert.equal(validateFrontmatter(agent('AG-001', { information_sources: value })).valid, false);
    }
  });

  it('rejects a non-object frontmatter', () => {
    for (const value of [null, 'AG-001', 42, []]) {
      assert.equal(validateFrontmatter(value).valid, false);
    }
  });
});
