/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Reading and writing the JSON data files.
 *
 * Writes go to a temporary file next to the target and are then renamed, so a
 * crash mid-write can never leave a half written agents.json behind.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
    wrapped.status = 500;
    throw wrapped;
  }
}

export async function writeJsonFile(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}