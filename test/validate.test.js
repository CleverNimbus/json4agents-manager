/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Schema validation.
 *
 * Two things are worth pinning down here. First, the schema is the source of
 * truth for every write, including the date-time format and the closed object
 * shape. Second - and this was a real bug - a schema that fails to compile must
 * not stay cached as a failure: fixing the file has to work without restarting
 * the server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import {
  loadSchema,
  resetSchemaCache,
  validateAgentCollection,
  validateAgentRecord,
} from '../webapp/server/validate.js';
import { agent, repoDir, useDataFolder, write } from './helpers.js';

let dir;

beforeEach(async () => {
  dir = await useDataFolder();
  resetSchemaCache();
});

const schemaFile = () => path.join(dir, 'agents.schema.json');

describe('validateAgentRecord', () => {
  it('accepts a record that matches $defs/agent', async () => {
    const { valid, errors } = await validateAgentRecord(agent('AG-001'));
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it('accepts every documented optional field', async () => {
    const full = agent('AG-001', {
      description: 'a description',
      notes: 'some notes',
      parent: 'AG-000',
      source_dependant_files: ['src/a.js'],
      result_generated_files: ['out/b.txt'],
    });
    assert.equal((await validateAgentRecord(full)).valid, true);
  });

  it('requires code, name and phase', async () => {
    const { valid, errors } = await validateAgentRecord({ description: 'no identity' });
    assert.equal(valid, false);
    const required = errors.filter((e) => e.keyword === 'required').map((e) => e.message).join(' ');
    for (const field of ['code', 'name', 'phase']) assert.match(required, new RegExp(field));
  });

  it('rejects a phase that is not a number', async () => {
    const { valid, errors } = await validateAgentRecord(agent('AG-001', { phase: 'one' }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.path === '/phase'));
  });

  it('rejects a field the schema does not know', async () => {
    const { valid, errors } = await validateAgentRecord(agent('AG-001', { surprise: 1 }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.keyword === 'additionalProperties'));
  });

  it('rejects a field of the wrong shape', async () => {
    const { valid, errors } = await validateAgentRecord(agent('AG-001', { result_generated_files: 'out.txt' }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.path === '/result_generated_files'));
  });

  it('rejects a non-object record', async () => {
    for (const value of [null, 'AG-001', 42, []]) {
      assert.equal((await validateAgentRecord(value)).valid, false);
    }
  });

});

describe('validateAgentCollection', () => {
  it('accepts a document holding valid records', async () => {
    const { valid } = await validateAgentCollection([agent('AG-001'), agent('AG-002')]);
    assert.equal(valid, true);
  });

  it('rejects the document when any record is wrong', async () => {
    const { valid, errors } = await validateAgentCollection([agent('AG-001'), agent('AG-002', { phase: 'x' })]);
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
  });

  it('the root schema insists on the agents array', async () => {
    const { collection } = await loadSchema();
    assert.equal(collection({}), false, 'a document without "agents" is not a collection');
    assert.equal(collection({ agents: [] }), true);
  });

});

describe('schema cache', () => {
  it('reuses the compiled schema within one folder', async () => {
    const first = await loadSchema();
    const second = await loadSchema();
    assert.equal(first, second, 'the same promise is reused until the cache is reset');
  });

  it('does not cache a failure: a fixed schema works without a restart', async () => {
    await write(schemaFile(), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' });
    resetSchemaCache();

    await assert.rejects(() => loadSchema(), /\$defs\/agent/, 'a schema without $defs/agent must fail');

    // Same process, no restart: fix the file and it must be picked up.
    await write(
      schemaFile(),
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { agent: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } },
      }),
    );
    const { schema } = await loadSchema();
    assert.ok(schema.$defs?.agent, 'the repaired schema is compiled');
    assert.equal((await validateAgentRecord({ code: 'AG-001' })).valid, true);
  });

  it('does not cache a schema that is not valid JSON', async () => {
    await write(schemaFile(), '{ not json');
    resetSchemaCache();
    await assert.rejects(() => loadSchema());
    await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), schemaFile());
    resetSchemaCache();
    const { schema } = await loadSchema();
    assert.equal(schema.title, 'Agents');
  });
});