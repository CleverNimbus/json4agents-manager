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

import { countOf, formatBytes, formatDuration, formatTime, lastOf, latestHash, shortHash, summariseList } from '../webapp/src/format.js';

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

describe('formatTime', () => {
  it('returns an empty string for falsy input', () => {
    assert.equal(formatTime(''), '');
    assert.equal(formatTime(undefined), '');
    assert.equal(formatTime(null), '');
  });

  it('returns the raw string when it cannot be parsed as a date', () => {
    assert.equal(formatTime('not a date'), 'not a date');
    assert.equal(formatTime('---'), '---');
  });

  it('formats a valid ISO string into locale date-time', () => {
    const formatted = formatTime('2026-10-16T19:04:31.469Z');
    assert.ok(typeof formatted === 'string' && formatted.length > 0);
    assert.ok(!formatted.includes('Invalid'), 'a valid ISO string must not produce "Invalid Date"');
    // Locale output varies, but must contain year, month, day separators.
    assert.match(formatted, /2026/);
    assert.match(formatted, /10/);
    assert.match(formatted, /16/);
  });

  it('pads single-digit months and days to two digits', () => {
    const formatted = formatTime('2026-01-05T08:09:10.000Z');
    // toLocaleString with month: '2-digit', day: '2-digit' → "01" and "05"
    assert.match(formatted, /01/);
    assert.match(formatted, /05/);
  });
});

describe('lastOf', () => {
  it('returns the last element of an array', () => {
    assert.equal(lastOf([1, 2, 3]), 3);
    assert.equal(lastOf(['a', 'b']), 'b');
  });

  it('returns empty string for an empty array', () => {
    assert.equal(lastOf([]), '');
  });

  it('returns empty string for non-array input', () => {
    assert.equal(lastOf(undefined), '');
    assert.equal(lastOf(null), '');
    assert.equal(lastOf('string'), '');
    assert.equal(lastOf(42), '');
  });
});