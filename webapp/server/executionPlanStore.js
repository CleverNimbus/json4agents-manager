/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Read and write the persisted execution plan at
 * `<dataFolder>/execution-plan.json`. The plan is what the Hashing tab shows
 * in its left rail: a snapshot of the changed paths that triggered it, and
 * the ordered list of steps with a per-step `done` flag the user toggles.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { files } from './config.js';
import { readJsonFile, writeJsonFile } from './store.js';

const PLAN_VERSION = 1;

function emptyPlan() {
  return { version: PLAN_VERSION, generatedAt: '', changedPaths: [], steps: [] };
}

function normaliseStep(step) {
  return {
    code: String(step?.code ?? ''),
    name: String(step?.name ?? ''),
    phase: typeof step?.phase === 'number' ? step.phase : 0,
    reason: step?.reason === 'changed' ? 'changed' : 'downstream',
    triggers: Array.isArray(step?.triggers) ? step.triggers : [],
    done: step?.done === true,
  };
}

function normalise(plan) {
  if (!plan || typeof plan !== 'object') return emptyPlan();
  return {
    version: PLAN_VERSION,
    generatedAt: typeof plan.generatedAt === 'string' ? plan.generatedAt : '',
    changedPaths: Array.isArray(plan.changedPaths) ? plan.changedPaths.map(String) : [],
    steps: Array.isArray(plan.steps) ? plan.steps.map(normaliseStep) : [],
  };
}

/**
 * Read the saved plan. Returns the empty shape when the file is missing or
 * unreadable, so the panel can render a friendly "no plan yet" state.
 */
export async function readPlan() {
  const raw = await readJsonFile(files.executionPlan, null);
  if (raw === null) return emptyPlan();
  return normalise(raw);
}

/** Write the plan to disk, creating the data folder if necessary. */
export async function writePlan(plan) {
  const clean = normalise(plan);
  await fs.mkdir(path.dirname(files.executionPlan), { recursive: true });
  await writeJsonFile(files.executionPlan, clean);
  return clean;
}

/**
 * Apply a patch describing which steps are done. The patch is `{ steps: [{code, done}, ...] }`.
 * Unknown codes are ignored; missing steps in the patch are left untouched.
 * The returned plan is also written to disk.
 */
export async function patchPlanDone(patch) {
  const current = await readPlan();
  const updates = new Map();
  for (const entry of patch?.steps ?? []) {
    if (entry && typeof entry.code === 'string') updates.set(entry.code, entry.done === true);
  }
  let touched = 0;
  for (const step of current.steps) {
    if (!updates.has(step.code)) continue;
    const next = updates.get(step.code);
    if (step.done !== next) {
      step.done = next;
      touched += 1;
    }
  }
  if (touched > 0) await writePlan(current);
  return current;
}
