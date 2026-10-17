/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * agentsValidation.js — checkAgent: record + collection validation.
 *
 * checkAgent is the gate every CRUD endpoint calls before writing. It must
 * catch a record that passes $defs/agent alone but breaks the collection —
 * e.g. a duplicate code.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { checkAgent } from '../webapp/server/agentsValidation.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import { agent, useDataFolder, write } from './helpers.js';

let dir;

beforeEach(async () => {
  dir = await useDataFolder({ label: 'agents-validation' });
});

describe('checkAgent', () => {
  it('accepts a valid record when it is the only one', async () => {
    const result = await checkAgent(agent('AG-001'));
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors ?? [], []);
  });

  it('accepts a valid record alongside others', async () => {
    await write(path.join(dir, 'agents', 'AG-002.json'), agent('AG-002'));
    const result = await checkAgent(agent('AG-001'));
    assert.equal(result.valid, true);
  });

  it('rejects a record that fails $defs/agent', async () => {
    const result = await checkAgent({ not: 'an agent' });
    assert.equal(result.valid, false);
    assert.ok((result.errors ?? []).length > 0);
  });

  it('accepts adding a new unique code to a non-empty collection', async () => {
    await write(path.join(dir, 'agents', 'AG-002.json'), agent('AG-002'));
    const result = await checkAgent(agent('AG-001'));
    assert.equal(result.valid, true, 'AG-001 does not collide with AG-002');
  });

  it('excludes the previousCode from the duplicate check on rename', async () => {
    // Seed AG-001, rename it to AG-002 — the old code must not count.
    await write(path.join(dir, 'agents', 'AG-001.json'), agent('AG-001'));
    const result = await checkAgent(agent('AG-002'), 'AG-001');
    assert.equal(result.valid, true, 'renaming AG-001 → AG-002 must not collide with the old code');
  });

  it('passes when the new code replaces the old and a third agent exists', async () => {
    // Three agents, rename one: replaced set covers both old and new codes.
    await write(path.join(dir, 'agents', 'AG-001.json'), agent('AG-001'));
    await write(path.join(dir, 'agents', 'AG-002.json'), agent('AG-002'));
    await write(path.join(dir, 'agents', 'AG-003.json'), agent('AG-003'));
    const result = await checkAgent(agent('AG-002'), 'AG-001');
    assert.equal(result.valid, true, 'renaming AG-001→AG-002 when AG-002 is also replaced must pass');
  });

  it('rejects additionalProperties even when $defs/agent passes', async () => {
    const result = await checkAgent(agent('AG-001', { surprise: true }));
    assert.equal(result.valid, false);
    assert.ok((result.errors ?? []).some((e) => e.keyword === 'additionalProperties'));
  });

  it('rejects a non-object record before touching the collection', async () => {
    for (const value of [null, 'string', 42, []]) {
      const result = await checkAgent(value);
      assert.equal(result.valid, false, `${typeof value} must fail`);
    }
  });

  it('surfaces $defs/agent errors before collection errors', async () => {
    // A record that is both invalid alone AND would collide — the first
    // failure (record) must surface, not be masked by the collection check.
    await write(path.join(dir, 'agents', 'AG-001.json'), agent('AG-001'));
    const result = await checkAgent({ not: 'valid' });
    assert.equal(result.valid, false);
  });
});
