/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * stateFile.js — shared read/write wrapper for state.json and settings.json.
 *
 * Best-effort: missing, empty or malformed file falls back to defaults via
 * the sanitise function. Writes go through atomic temp+rename from store.js.
 * Path is a function, so a store survives switching data folders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createStateFile } from '../webapp/server/stateFile.js';
import { useDataFolder } from './helpers.js';

let dir;
let counter = 0;

/**
 * A sanitise that turns anything into a { value } object, with a clear
 * default so we can tell "file was missing" from "file held garbage".
 */
const sanitise = (raw) => {
  if (raw && typeof raw === 'object' && typeof raw.value === 'number') return raw;
  return { value: 0 };
};

const defaults = { value: 0 };

beforeEach(async () => {
  dir = await useDataFolder({ label: 'state-file' });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('createStateFile', () => {
  it('returns defaults when the file does not exist yet', async () => {
    const file = createStateFile({
      getPath: () => path.join(dir, 'state.json'),
      defaults,
      sanitise,
    });

    assert.equal(file.file, path.join(dir, 'state.json'));
    assert.deepEqual(await file.read(), { value: 0 });
  });

  it('writes then reads back the same state', async () => {
    const file = createStateFile({
      getPath: () => path.join(dir, 'state.json'),
      defaults,
      sanitise,
    });

    await file.write({ value: 42 });
    assert.deepEqual(await file.read(), { value: 42 });
  });

  it('falls back to defaults when the file is empty', async () => {
    const target = path.join(dir, 'state.json');
    await fs.writeFile(target, '');

    const file = createStateFile({ getPath: () => target, defaults, sanitise });
    assert.deepEqual(await file.read(), { value: 0 }, 'an empty file sanitises to the default');
  });

  it('falls back to defaults when the file is not JSON', async () => {
    const target = path.join(dir, 'state.json');
    await fs.writeFile(target, '{ not json');

    const file = createStateFile({ getPath: () => target, defaults, sanitise });
    assert.deepEqual(await file.read(), { value: 0 }, 'garbage sanitises to the default');
  });

  it('falls back to defaults when the file is valid JSON but wrong shape', async () => {
    const target = path.join(dir, 'state.json');
    await fs.writeFile(target, JSON.stringify({ wrong: true }));

    const file = createStateFile({ getPath: () => target, defaults, sanitise });
    assert.deepEqual(await file.read(), { value: 0 }, 'a record that fails sanitise reverts');
  });

  it('write returns the state that was written', async () => {
    const file = createStateFile({
      getPath: () => path.join(dir, 'state.json'),
      defaults,
      sanitise,
    });

    const result = await file.write({ value: 7 });
    assert.deepEqual(result, { value: 7 });
  });

  it('switches to a new path when getPath returns a different file', async () => {
    let current = path.join(dir, 'state.json');
    const file = createStateFile({ getPath: () => current, defaults, sanitise });

    await file.write({ value: 1 });
    assert.deepEqual(await file.read(), { value: 1 });

    // Same store object, different file — no restart needed.
    current = path.join(dir, 'other.json');
    assert.deepEqual(await file.read(), { value: 0 }, 'a fresh file falls back, not stale state');
    await file.write({ value: 2 });
    assert.deepEqual(await file.read(), { value: 2 });
  });

  it('read is safe to call concurrently', async () => {
    const file = createStateFile({
      getPath: () => path.join(dir, 'state.json'),
      defaults,
      sanitise,
    });

    await file.write({ value: 99 });
    const results = await Promise.all([file.read(), file.read(), file.read()]);
    for (const r of results) assert.deepEqual(r, { value: 99 });
  });
});
