/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * store.js - reading and writing the JSON data files.
 *
 * The properties that matter: a missing file falls back instead of crashing, a
 * broken file says which file is broken, the fallback is a copy (so one caller
 * cannot poison another's defaults), and a write is atomic and leaves nothing
 * behind.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { fileExists, readJsonFile, writeJsonFile } from '../webapp/server/store.js';
import { listNames, tempDir, write } from './helpers.js';

describe('readJsonFile', () => {
  it('returns the parsed content', async () => {
    const dir = await tempDir('store');
    await write(path.join(dir, 'a.json'), { hello: 'world' });
    assert.deepEqual(await readJsonFile(path.join(dir, 'a.json'), null), { hello: 'world' });
  });

  it('returns the fallback when the file does not exist', async () => {
    const dir = await tempDir('store');
    assert.deepEqual(await readJsonFile(path.join(dir, 'missing.json'), { ok: true }), { ok: true });
  });

  it('throws when the file does not exist and no fallback was given', async () => {
    const dir = await tempDir('store');
    await assert.rejects(() => readJsonFile(path.join(dir, 'missing.json')), { code: 'ENOENT' });
  });

  it('throws for malformed JSON, naming the file, instead of silently using the fallback', async () => {
    const dir = await tempDir('store');
    await write(path.join(dir, 'broken.json'), '{ nope');
    await assert.rejects(
      () => readJsonFile(path.join(dir, 'broken.json'), { ok: true }),
      (err) => err.message.includes('broken.json') && err.status === 500,
    );
  });

  it('hands out a copy of the fallback, not the caller object', async () => {
    const dir = await tempDir('store');
    const fallback = { nested: { list: [1, 2] } };
    const first = await readJsonFile(path.join(dir, 'missing.json'), fallback);
    first.nested.list.push(3);
    const second = await readJsonFile(path.join(dir, 'missing.json'), fallback);
    assert.deepEqual(second.nested.list, [1, 2], 'the caller fallback must not be mutated');
  });
});

describe('writeJsonFile', () => {
  it('writes indented JSON with a trailing newline', async () => {
    const dir = await tempDir('store');
    const file = path.join(dir, 'a.json');
    await writeJsonFile(file, { a: 1 });
    const text = await fs.readFile(file, 'utf8');
    assert.equal(text, '{\n  "a": 1\n}\n');
  });

  it('replaces existing content completely', async () => {
    const dir = await tempDir('store');
    const file = path.join(dir, 'a.json');
    await writeJsonFile(file, { first: true, keepMe: 'x' });
    await writeJsonFile(file, { second: true });
    assert.deepEqual(await readJsonFile(file, null), { second: true });
  });

  it('leaves no temporary files behind', async () => {
    const dir = await tempDir('store');
    await writeJsonFile(path.join(dir, 'a.json'), { a: 1 });
    await writeJsonFile(path.join(dir, 'b.json'), { b: 2 });
    assert.deepEqual(await listNames(dir), ['a.json', 'b.json']);
  });

  it('round trips non-ASCII content without mangling it', async () => {
    const dir = await tempDir('store');
    const file = path.join(dir, 'a.json');
    const value = { note: 'café - ünïcode ✓ 日本語', emoji: '🚀' };
    await writeJsonFile(file, value);
    assert.deepEqual(await readJsonFile(file, null), value);
  });
});

describe('fileExists', () => {
  it('is true for a file and false for anything else', async () => {
    const dir = await tempDir('store');
    await write(path.join(dir, 'here.txt'), 'x');
    assert.equal(await fileExists(path.join(dir, 'here.txt')), true);
    assert.equal(await fileExists(path.join(dir, 'nope.txt')), false);
    assert.equal(await fileExists(dir), true, 'a directory exists as a path');
  });
});