/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The agent store: one markdown file per agent in the configured folder, with
 * the file name stem as the agent's identity.
 *
 * The rules under test are the ones that keep hand-written files honest: a code
 * must be safe to turn into a path, a file whose frontmatter does not satisfy
 * the schema is reported as an issue instead of becoming a row, and the grid
 * order is the code order no matter what the filesystem hands back. The store
 * never writes: there is nothing here to create, update or delete.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import {
  AgentStoreError,
  agentsDir,
  assertValidCode,
  fileNameFor,
  listAgents,
  readAgent,
  scanAgents,
} from '../webapp/server/agentsStore.js';
import { defaultAgentsDir } from '../webapp/server/config.js';
import { agent, agentMd, useDataFolder, write } from './helpers.js';

let dir;
let agentsPath;

beforeEach(async () => {
  dir = await useDataFolder();
  agentsPath = path.join(dir, 'agents');
});

const md = agentMd;

describe('assertValidCode', () => {
  it('accepts ordinary agent codes', () => {
    for (const code of ['AG-001', 'a', 'A1', 'agent.01', 'agent_01', 'x-1-2-3']) {
      assert.equal(assertValidCode(code), code);
    }
  });

  it('refuses anything that could escape the folder or is not a plain name', () => {
    const rejected = [
      '',
      '.',
      '..',
      '../etc/passwd',
      '..\\windows',
      'a/b',
      '/abs',
      '-leading-dash',
      '.hidden',
      'has space',
      'quote"',
      `null${String.fromCharCode(0)}byte`,
      'ünïcode',
    ];
    for (const code of rejected) {
      assert.throws(() => assertValidCode(code), AgentStoreError, `expected ${JSON.stringify(code)} to be refused`);
    }
  });

  it('refuses values that are not strings', () => {
    for (const code of [undefined, null, 42, {}, []]) {
      assert.throws(() => assertValidCode(code), AgentStoreError);
    }
  });

  it('carries the code into the file name it allows', () => {
    assert.equal(fileNameFor('AG-001'), 'AG-001.md');
  });
});

describe('agentsDir', () => {
  it('follows the agentsFolder setting', async () => {
    assert.equal(await agentsDir(), agentsPath);
  });

  it('falls back to the repo agents folder when the setting is empty', async () => {
    await write(path.join(dir, 'settings.json'), { agentsFolder: '' });
    assert.equal(await agentsDir(), defaultAgentsDir);
  });
});

describe('scanAgents - validity', () => {
  it('loads a file whose frontmatter matches the schema', async () => {
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001')));
    const { records, issues } = await scanAgents();
    assert.deepEqual(issues, []);
    assert.equal(records.length, 1);
    assert.equal(records[0].code, 'AG-001');
    assert.equal(records[0].agent.execution_mode, 'full_input_processing');
  });

  it('uses the file name as the code, whatever the frontmatter claims', async () => {
    await write(path.join(agentsPath, 'AG-777.md'), md(agent('AG-001')));
    const { records, issues } = await scanAgents();
    assert.deepEqual(issues, [], 'a stray code key is not a disagreement to report');
    assert.equal(records[0].code, 'AG-777');
    assert.equal(records[0].agent.code, 'AG-777');
  });

  it('reports frontmatter that does not match the schema and drops the row', async () => {
    await write(path.join(agentsPath, 'AG-002.md'), md(agent('AG-002', { execution_mode: 'sometimes' })));
    const { records, issues } = await scanAgents();
    assert.deepEqual(records, []);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, 'AG-002.md');
    assert.match(issues[0].message, /schema/);
  });

  it('reports a file with no frontmatter', async () => {
    await write(path.join(agentsPath, 'AG-003.md'), '# just a heading\n');
    const { records, issues } = await scanAgents();
    assert.deepEqual(records, []);
    assert.equal(issues.length, 1);
  });

  it('reports broken YAML without taking the whole folder down', async () => {
    await write(path.join(agentsPath, 'AG-004.md'), md(agent('AG-004')));
    await write(path.join(agentsPath, 'AG-005.md'), '---\n: : :\n---\nbody\n');
    const { records, issues } = await scanAgents();
    assert.deepEqual(records.map((r) => r.code), ['AG-004'], 'the good file must still be listed');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, 'AG-005.md');
  });

  it('reports codes that collide when case is ignored', async () => {
    await write(path.join(agentsPath, 'AG-006.md'), md(agent('AG-006')));
    await write(path.join(agentsPath, 'ag-006.md'), md(agent('ag-006')));
    const { issues } = await scanAgents();
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /collides/i);
  });

  it('reports a file name that is not a valid code', async () => {
    await write(path.join(agentsPath, 'has space.md'), md(agent('AG-001')));
    const { records, issues } = await scanAgents();
    assert.deepEqual(records, []);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /valid agent code/);
  });

  it('ignores files that are not .md', async () => {
    await write(path.join(agentsPath, 'notes.txt'), 'hello');
    await write(path.join(agentsPath, 'AG-001.json'), '{}');
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001')));
    const { records, issues } = await scanAgents();
    assert.deepEqual(records.map((r) => r.code), ['AG-001']);
    assert.deepEqual(issues, []);
  });

  it('ignores sub folders', async () => {
    await fs.mkdir(path.join(agentsPath, 'archive.md'), { recursive: true });
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001')));
    const { records, issues } = await scanAgents();
    assert.deepEqual(records.map((r) => r.code), ['AG-001']);
    assert.deepEqual(issues, []);
  });
});

describe('scanAgents - order and missing folder', () => {
  it('orders by code, whatever order the files were created in', async () => {
    for (const code of ['M-003', 'A-001', 'Z-009', 'B-002']) {
      await write(path.join(agentsPath, `${code}.md`), md(agent(code)));
    }
    const { records } = await scanAgents();
    assert.deepEqual(records.map((r) => r.code), ['A-001', 'B-002', 'M-003', 'Z-009']);
  });

  it('returns an empty list when the agents folder is empty', async () => {
    const { records, issues } = await scanAgents();
    assert.deepEqual(records, []);
    assert.deepEqual(issues, []);
  });

  it('reports a missing agents folder instead of throwing', async () => {
    await fs.rm(agentsPath, { recursive: true, force: true });
    const { records, issues } = await scanAgents();
    assert.deepEqual(records, []);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, agentsPath);
    assert.match(issues[0].message, /does not exist/);
  });
});

describe('readAgent', () => {
  it('returns the frontmatter, the code and the body', async () => {
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001'), 'read me'));
    const { file, agent: record } = await readAgent('AG-001');
    assert.equal(file, path.join(agentsPath, 'AG-001.md'));
    assert.equal(record.code, 'AG-001');
    assert.equal(record.execution_mode, 'full_input_processing');
    assert.match(record.body, /read me/);
  });

  it('reports a missing record as 404', async () => {
    await assert.rejects(() => readAgent('AG-404'), { status: 404 });
  });

  it('reports a broken file as a server error naming the file', async () => {
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001', { execution_mode: 'sometimes' })));
    await assert.rejects(
      () => readAgent('AG-001'),
      (err) => err.status === 500 && err.message.includes('AG-001.md'),
    );
  });

  it('refuses a code that cannot be turned into a path', async () => {
    await assert.rejects(() => readAgent('../escape'), AgentStoreError);
  });
});

describe('listAgents', () => {
  it('returns plain records plus the issues, sorted by code', async () => {
    await write(path.join(agentsPath, 'AG-002.md'), md(agent('AG-002')));
    await write(path.join(agentsPath, 'AG-001.md'), md(agent('AG-001')));
    await write(path.join(agentsPath, 'AG-003.md'), '# no frontmatter\n');
    const { records, issues } = await listAgents();
    assert.deepEqual(records.map((r) => r.code), ['AG-001', 'AG-002']);
    assert.equal(records[0].body !== undefined, true, 'the list must carry full records');
    assert.equal(issues.length, 1, 'the bad file is reported, not loaded');
  });
});
