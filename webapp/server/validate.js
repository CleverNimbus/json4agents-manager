/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Frontmatter validation for the markdown agent store.
 *
 * The schema is bundled with the app (webapp/server/schemas/
 * agent.frontmatter.schema.json), compiled once per process with Ajv's draft
 * 2020-12 dialect, so the browser needs no validator of its own. Because the
 * schema is part of the code rather than the data folder, switching the data
 * folder cannot invalidate the compiled validator.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const schemaFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'schemas',
  'agent.frontmatter.schema.json',
);

let compiled = null;

/** The bundled frontmatter schema, compiled and cached per process. */
function validator() {
  if (!compiled) {
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = { schema, validate: ajv.compile(schema) };
  }
  return compiled;
}

/**
 * Validate the frontmatter of one agent file on its own.
 * @param {unknown} data the parsed YAML frontmatter
 */
export function validateFrontmatter(data) {
  const { validate } = validator();
  const valid = validate(data);
  const errors = (validate.errors ?? []).map((err) => ({
    path: err.instancePath || '/',
    message: err.message ?? 'is invalid',
  }));
  return { valid: Boolean(valid), errors };
}
