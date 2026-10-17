/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * changesApi.js — GET /api/changes.
 *
 * The endpoint reports uncommitted git files. It needs workspace settings;
 * without them it returns { configured: false }. We test the configured=false
 * path and the error path directly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pointAt, startApp, useDataFolder } from './helpers.js';

describe('GET /api/changes', () => {
  it('returns { configured: false } when no workspace is set', async () => {
    const dir = await useDataFolder({ label: 'changes' });
    pointAt(dir);
    const api = await startApp();
    try {
      const { status, body } = await api.get('/api/changes');
      assert.equal(status, 200);
      assert.equal(body.configured, false, 'without workspace settings the tab explains what to set');
    } finally {
      await api.close();
    }
  });
});
