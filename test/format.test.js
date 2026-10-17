/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Display helpers in webapp/src/format.js.
 *
 * These are pure and shared by every grid, so they are cheap to pin down. The
 * one that matters most is latestHash: the API sends a path's history newest
 * first, so "current" is the FIRST element. Getting that backwards shows a
 * stale hash as current with no error anywhere - the failure the per-run hash
 * store exists to prevent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countOf, formatBytes, formatDuration, latestHash, shortHash, summariseList } from '../webapp/src/format.js';

describe('formatBytes', () => {
  it('uses bytes below 1 KB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('steps up to KB, MB, GB', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  });

  it('rounds to whole units from 10 up', () => {
    assert.equal(formatBytes(10 * 1024), '10 KB');
    assert.equal(formatBytes(1023 * 1024), '1023 KB');
  });

  it('returns an empty string for values it cannot format', () => {
    assert.equal(formatBytes(undefined), '');
    assert.equal(formatBytes(null), '');
    assert.equal(formatBytes(Number.NaN), '');
    assert.equal(formatBytes(Infinity), '');
  });
});

describe('formatDuration', () => {
  it('uses milliseconds below a second', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(999), '999 ms');
  });

  it('uses seconds below a minute', () => {
    assert.equal(formatDuration(1000), '1.0 s');
    assert.equal(formatDuration(1500), '1.5 s');
    assert.equal(formatDuration(59_999), '60.0 s');
  });

  it('uses minutes and seconds from a minute up', () => {
    assert.equal(formatDuration(60_000), '1 min 0 s');
    assert.equal(formatDuration(65_000), '1 min 5 s');
    assert.equal(formatDuration(3_600_000), '60 min 0 s');
  });

  it('returns an empty string for values it cannot format', () => {
    assert.equal(formatDuration(undefined), '');
    assert.equal(formatDuration(Number.NaN), '');
  });
});

describe('shortHash', () => {
  it('shows the first 12 characters', () => {
    assert.equal(shortHash('0123456789abcdef0123'), '0123456789ab');
  });

  it('is empty for anything that is not a non-empty string', () => {
    assert.equal(shortHash(''), '');
    assert.equal(shortHash(undefined), '');
    assert.equal(shortHash(null), '');
    assert.equal(shortHash(12345), '');
  });
});

describe('latestHash', () => {
  it('returns the newest hash, which is the first element', () => {
    const entry = {
      hashes: [
        { datetime: '2026-10-16T19:04:31.469Z', hash: 'newest' },
        { datetime: '2026-10-16T18:56:47.919Z', hash: 'middle' },
        { datetime: '2026-10-16T18:55:13.525Z', hash: 'oldest' },
      ],
    };
    assert.equal(latestHash(entry), 'newest');
  });

  it('handles a bare string history', () => {
    assert.equal(latestHash({ hashes: ['newest', 'oldest'] }), 'newest');
  });

  it('is empty when there is no history', () => {
    assert.equal(latestHash({ hashes: [] }), '');
    assert.equal(latestHash({}), '');
    assert.equal(latestHash(undefined), '');
    assert.equal(latestHash({ hashes: 'not an array' }), '');
  });
});

describe('list helpers', () => {
  it('counts arrays and is empty otherwise', () => {
    assert.equal(countOf([1, 2, 3]), 3);
    assert.equal(countOf([]), 0);
    assert.equal(countOf(undefined), 0);
  });

  it('summarises a list and marks the overflow', () => {
    assert.equal(summariseList([]), '');
    assert.equal(summariseList(['a']), '1 · a');
    assert.equal(summariseList(['a', 'b']), '2 · a, b');
    assert.equal(summariseList(['a', 'b', 'c']), '3 items · a, b …');
  });
});