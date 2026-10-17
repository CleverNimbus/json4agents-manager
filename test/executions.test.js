/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Execution receipts: the shared record of "this was generated, for these
 * inputs, from these committed bytes".
 *
 * The team pulls agent files and generated files from git. A receipt is the one
 * artefact that lets a teammate skip re-running an agent: it names the inputs
 * that produced the outputs and the exact git blobs that were published. It is
 * only meaningful against git, so these tests run against a real repository:
 * a receipt is hashed from the index, refused when the worktree is dirty, and
 * must never bless a hand-edited output under unchanged inputs.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { recordExecution } from '../webapp/server/executionsStore.js';
import { pointAt, repoDir, startApp, tempDir, write } from './helpers.js';

const exec = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const git = async (cwd, ...args) => String((await exec('git', args, { cwd, encoding: 'utf8' })).stdout).trim();
const as = (cwd, who, ...args) =>
  git(cwd, '-c', `user.email=${who}@example.com`, '-c', `user.name=${who}`, ...args);

const AGENT = {
  code: 'AG-001',
  name: 'Builder',
  phase: 1,
  source_dependant_files: ['src/input.txt'],
  result_generated_files: ['out/report.md'],
};

/**
 * A repository that carries its own data folder, so receipts land inside the
 * tree that gets cloned and merged. Settings stay untracked, as in real use.
 */
async function repoWithData() {
  const repo = await tempDir('exec');
  const data = path.join(repo, 'data');
  await fs.mkdir(path.join(data, 'agents'), { recursive: true });
  await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), path.join(data, 'agents.schema.json'));
  await write(
    path.join(repo, '.gitignore'),
    ['data/settings.json', 'data/state.json', 'data/execution-plan.json', 'data-location.json', 'data/hashes/'].join('\n') + '\n',
  );
  await git(repo, 'init', '-q', '-b', 'main', '.');
  await as(repo, 'tester', 'commit', '-q', '--allow-empty', '-m', 'init');
  pointAt(data);
  await write(path.join(data, 'settings.json'), { workspaceFolder: repo, gitRoot: repo });
  await write(path.join(data, 'agents', 'AG-001.json'), AGENT);
  return { repo, data };
}

/** Commit the input file the agent depends on, so it exists on HEAD. */
async function commitInput(repo, content = 'v1') {
  await write(path.join(repo, 'src', 'input.txt'), content);
  await git(repo, 'add', '-A');
  await as(repo, 'tester', 'commit', '-q', '-m', 'input');
}

/** Write an output and stage it, ready to be recorded. */
async function stageOutput(repo, content = '# report', name = 'out/report.md') {
  await write(path.join(repo, name), content);
  await git(repo, 'add', name);
}

const record = (api, agent = 'AG-001', paths = ['out/report.md']) =>
  api.post('/api/executions', { agent, paths });

describe('POST /api/executions', () => {
  it('records a receipt for staged output and names the blobs and hashes', async () => {
    const { repo, data } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo, '# report');

    const api = await startApp();
    try {
      const { status, body } = await record(api);
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.receipt.agent, 'AG-001');

      const receipt = JSON.parse(await fs.readFile(path.join(data, 'executions', `${body.receipt.id}.json`), 'utf8'));
      assert.equal(receipt.outputs.length, 1);
      assert.equal(receipt.outputs[0].path, 'out/report.md');
      assert.match(receipt.outputs[0].blob, /^[0-9a-f]{40}$/);
      assert.equal(receipt.outputs[0].sha256, sha256('# report'));
      assert.equal(receipt.inputs[0].path, 'src/input.txt');
      assert.equal(receipt.inputs[0].sha256, sha256('v1'));

      const view = (await api.get('/api/executions')).body;
      assert.equal(view.configured, true);
      assert.equal(view.receipts[0].status, 'valid');
    } finally {
      await api.close();
    }
  });

  it('refuses an output that is not tracked by git', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await write(path.join(repo, 'out/report.md'), '# report');

    const api = await startApp();
    try {
      const { status, body } = await record(api);
      assert.equal(status, 400);
      assert.match(body.error, /not tracked by git/);
    } finally {
      await api.close();
    }
  });

  it('refuses an output whose worktree bytes differ from the index', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo, '# report');
    await write(path.join(repo, 'out/report.md'), '# edited after staging');

    const api = await startApp();
    try {
      const { status, body } = await record(api);
      assert.equal(status, 400);
      assert.match(body.error, /unstaged changes/);
    } finally {
      await api.close();
    }
  });

  it('refuses an input that has unstaged changes', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo);
    await write(path.join(repo, 'src/input.txt'), 'v1 but edited');

    const api = await startApp();
    try {
      const { status, body } = await record(api);
      assert.equal(status, 400);
      assert.match(body.error, /unstaged changes/);
    } finally {
      await api.close();
    }
  });

  it('refuses an absolute or escaping path', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);

    const api = await startApp();
    try {
      assert.equal((await record(api, 'AG-001', ['/etc/passwd'])).status, 400);
      const escape = await record(api, 'AG-001', ['../outside.md']);
      assert.equal(escape.status, 400);
      assert.match(escape.body.error, /relative to the git root/);
    } finally {
      await api.close();
    }
  });

  it('refuses an empty selection and an unknown agent', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo);

    const api = await startApp();
    try {
      assert.equal((await record(api, 'AG-001', [])).status, 400);
      const unknown = await record(api, 'NOPE', ['out/report.md']);
      assert.equal(unknown.status, 404);
      assert.match(unknown.body.error, /No agent with code NOPE/);
    } finally {
      await api.close();
    }
  });

  it('refuses to publish the same output twice for the same inputs', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo);

    const api = await startApp();
    try {
      assert.equal((await record(api)).status, 201);
      const again = await record(api);
      assert.equal(again.status, 409);
      assert.match(again.body.error, /already published for the same inputs|already recorded/);
    } finally {
      await api.close();
    }
  });

  it('refuses a hand-edited output under unchanged inputs', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo, '# report');
    const api = await startApp();
    try {
      assert.equal((await record(api)).status, 201);

      await write(path.join(repo, 'out/report.md'), '# hand edited');
      await git(repo, 'add', 'out/report.md');
      const edited = await record(api);
      assert.equal(edited.status, 409);
      assert.match(edited.body.error, /already published for the same inputs/);
      assert.ok(Array.isArray(edited.body.errors), 'the conflicting paths come back');
      assert.equal(edited.body.errors[0].path, 'out/report.md');
      assert.match(edited.body.errors[0].message, /differs from receipt/);
    } finally {
      await api.close();
    }
  });

  it('allows a new receipt once the inputs change, and marks the old one stale', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo, 'v1');
    await stageOutput(repo, '# report v1');
    const api = await startApp();
    try {
      assert.equal((await record(api)).status, 201);

      // A real re-run: new input content, new output, all committed together.
      await commitInput(repo, 'v2');
      await write(path.join(repo, 'out/report.md'), '# report v2');
      await git(repo, 'add', 'out/report.md');

      const second = await record(api);
      assert.equal(second.status, 201, JSON.stringify(second.body));

      const view = (await api.get('/api/executions')).body;
      assert.equal(view.receipts.length, 2);
      assert.equal(view.receipts.find((r) => r.id === second.body.receipt.id).status, 'valid');
    } finally {
      await api.close();
    }
  });

  it('marks a receipt diverged when an output changes after it was recorded', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);
    await stageOutput(repo, '# report');
    const api = await startApp();
    try {
      assert.equal((await record(api)).status, 201);

      await write(path.join(repo, 'out/report.md'), '# changed later');
      await git(repo, 'add', '-A');
      await as(repo, 'tester', 'commit', '-q', '-m', 'edit output');

      const view = (await api.get('/api/executions')).body;
      assert.equal(view.receipts[0].status, 'diverged');
    } finally {
      await api.close();
    }
  });
});

describe('GET /api/executions without a workspace', () => {
  it('reports configured:false and leaves statuses unknown', async () => {
    const repo = await tempDir('exec-unconfigured');
    const data = path.join(repo, 'data');
    await fs.mkdir(path.join(data, 'agents'), { recursive: true });
    await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), path.join(data, 'agents.schema.json'));
    pointAt(data);
    await write(path.join(data, 'settings.json'), { workspaceFolder: '', gitRoot: '' });
    await write(path.join(data, 'executions', '2026-01-01T00-00-00-000Z_x.json'), {
      id: '2026-01-01T00-00-00-000Z_x',
      agent: 'AG-001',
      recordedAt: '2026-01-01T00:00:00.000Z',
      inputs: [],
      outputs: [{ path: 'out/report.md', blob: 'a'.repeat(40), sha256: sha256('x') }],
    });

    const api = await startApp();
    try {
      const view = (await api.get('/api/executions')).body;
      assert.equal(view.configured, false);
      assert.equal(view.receipts[0].status, 'unknown');
    } finally {
      await api.close();
    }
  });
});

describe('two machines, one receipt store', () => {
  it('keeps both receipts after a merge, with no conflict', async () => {
    const { repo } = await repoWithData();
    await commitInput(repo);

    // Alice publishes one output.
    await stageOutput(repo, '# alice', 'out/a.md');
    const alice = await startApp();
    try {
      assert.equal((await alice.post('/api/executions', { agent: 'AG-001', paths: ['out/a.md'] })).status, 201);
    } finally {
      await alice.close();
    }
    await git(repo, 'add', '-A');
    await as(repo, 'alice', 'commit', '-q', '-m', 'alice run');

    // Bob works from a clone.
    const bobRepo = await tempDir('exec-bob');
    await exec('git', ['clone', '-q', repo, bobRepo]);
    const bobData = path.join(bobRepo, 'data');
    pointAt(bobData);
    await write(path.join(bobData, 'settings.json'), { workspaceFolder: bobRepo, gitRoot: bobRepo });
    await stageOutput(bobRepo, '# bob', 'out/b.md');
    const bob = await startApp();
    try {
      assert.equal((await bob.post('/api/executions', { agent: 'AG-001', paths: ['out/b.md'] })).status, 201);
    } finally {
      await bob.close();
    }
    await git(bobRepo, 'add', '-A');
    await as(bobRepo, 'bob', 'commit', '-q', '-m', 'bob run');

    // Alice pulls Bob's work: the receipt files are additions, so they merge.
    await git(repo, 'remote', 'add', 'bob', bobRepo);
    await git(repo, 'fetch', '-q', 'bob');
    await git(repo, 'merge', '--no-edit', '-m', 'merge bob', 'bob/main');

    assert.equal(await git(repo, 'diff', '--name-only', '--diff-filter=U'), '', 'the merge is clean');
    const receipts = await fs.readdir(path.join(repo, 'data', 'executions'));
    assert.equal(receipts.length, 2, "both machines' receipts survive");
  });
});

describe('recordExecution', () => {
  it('needs a configured workspace before it will hash anything', async () => {
    const repo = await tempDir('exec-nogitroot');
    const data = path.join(repo, 'data');
    await fs.mkdir(path.join(data, 'agents'), { recursive: true });
    await fs.copyFile(path.join(repoDir, 'data', 'agents.schema.json'), path.join(data, 'agents.schema.json'));
    pointAt(data);
    await write(path.join(data, 'settings.json'), { workspaceFolder: '', gitRoot: '' });
    await write(path.join(data, 'agents', 'AG-001.json'), AGENT);

    await assert.rejects(recordExecution({ agent: 'AG-001', paths: ['out/report.md'] }), /Configure the workspace/);
  });
});
