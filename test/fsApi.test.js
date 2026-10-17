/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * fsApi.js — unit-level coverage for the pure helpers.
 *
 * expandPath, parentOf, and resolveBrowsable are the parts that do not need
 * a running HTTP server. resolveBrowsable with the jail is covered via the
 * /api/fs route in api.test.js; here we pin down the pure helpers directly.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { expandPath, parentOf } from '../webapp/server/fsApi.js';
import { config } from '../webapp/server/config.js';

describe('expandPath', () => {
  it('returns home for empty string or ~', () => {
    assert.equal(expandPath(''), os.homedir());
    assert.equal(expandPath('~'), os.homedir());
  });

  it('expands ~/ to home', () => {
    assert.equal(expandPath('~/foo'), path.join(os.homedir(), 'foo'));
  });

  /**
   * Non-~ paths are made absolute with path.resolve. A relative path does NOT
   * become an absolute path under home — it becomes absolute under cwd. The
   * jail in resolveBrowsable is what keeps the user inside the allowed root.
   */
  it('resolves a plain path to absolute under cwd', () => {
    const result = expandPath('relative/path');
    assert.equal(result, path.resolve('relative/path'));
    assert.ok(path.isAbsolute(result));
  });

  it('leaves an already-absolute path untouched', () => {
    const abs = '/some/absolute/path';
    assert.equal(expandPath(abs), path.resolve(abs));
  });

  it('coerces non-string input via String()', () => {
    // null and undefined collapse to '' via the ?? '' guard → homedir
    assert.equal(expandPath(undefined), os.homedir());
    assert.equal(expandPath(null), os.homedir());
    // A numeric or other absolute-looking string resolves normally
    assert.equal(expandPath(12345), path.resolve('12345'));
  });

  it('trims whitespace', () => {
    assert.equal(expandPath('  '), os.homedir());
    assert.equal(expandPath('  ~/x  '), path.join(os.homedir(), 'x'));
  });
});

describe('parentOf', () => {
  it('returns the parent of an absolute path', () => {
    assert.equal(parentOf('/a/b'), '/a');
    assert.equal(parentOf('/a/b/c'), '/a/b');
  });

  it('returns null at the filesystem root', () => {
    assert.equal(parentOf('/'), null);
  });

  it('returns null when the parent would leave the jail', () => {
    const original = config.browseRoot;
    try {
      config.browseRoot = '/jail';
      assert.equal(parentOf('/jail/sub'), '/jail', 'jail itself is a valid parent');
      assert.equal(parentOf('/jail'), null, 'cannot go above the jail');
      assert.equal(parentOf('/jail/sub/deep'), '/jail/sub', 'nested paths walk up normally');
    } finally {
      config.browseRoot = original;
    }
  });

  it('allows any parent when no jail is set', () => {
    const original = config.browseRoot;
    try {
      config.browseRoot = null;
      assert.equal(parentOf('/a/b'), '/a');
      assert.equal(parentOf('/a'), '/');
      assert.equal(parentOf('/'), null);
    } finally {
      config.browseRoot = original;
    }
  });
});
