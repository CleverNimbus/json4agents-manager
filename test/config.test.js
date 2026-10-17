/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Configuration: where the data folder comes from, and the folder browser's
 * path rules.
 *
 * The precedence is decided once, when config.js is first imported, so these run
 * config.js in a child process with a given argv and environment. This file also
 * owns the repository's data-location.json: pointing the app at another folder
 * writes it, so it is always restored afterwards.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { config, defaultDataDir, files, resolveDataFolder } from '../webapp/server/config.js';
import { expandPath, parentOf, resolveBrowsable } from '../webapp/server/fsApi.js';
import {
  dataFolderPointerFile,
  repoDir,
  resolvedDataDir,
  tempDir,
  useDataFolder,
  withDataFolderPointerPreserved,
  write,
} from './helpers.js';

after(async () => {
  // The pointer must never survive a test run.
  const pointer = await readPointer();
  assert.equal(pointer, null, 'a test left data-location.json behind');
});

async function readPointer() {
  try {
    return JSON.parse(await fs.readFile(dataFolderPointerFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

describe('which data folder is used', () => {
  it('defaults to the data folder in the repository', async () => {
    await withDataFolderPointerPreserved(async () => {
      const { dataDir, locked } = await resolvedDataDir({});
      assert.equal(dataDir, defaultDataDir);
      assert.equal(dataDir, path.join(repoDir, 'data'));
      assert.equal(locked, false);
    });
  });

  it('lets --data-dir win over everything else', async () => {
    await withDataFolderPointerPreserved(async () => {
      const target = await tempDir('flag');
      await write(dataFolderPointerFile, { dataFolder: '/somewhere/else', resolved: '/somewhere/else' });

      const { dataDir, locked } = await resolvedDataDir({
        argv: ['--data-dir', target],
        env: { JSONM_DATA_DIR: '/from/the/environment' },
      });
      assert.equal(dataDir, target);
      assert.equal(locked, true, 'and the folder is then fixed for the run');
    });
  });

  it('lets the environment win over the remembered pointer', async () => {
    await withDataFolderPointerPreserved(async () => {
      const target = await tempDir('env');
      await write(dataFolderPointerFile, { dataFolder: '/somewhere/else', resolved: '/somewhere/else' });

      const { dataDir, locked } = await resolvedDataDir({ env: { JSONM_DATA_DIR: target } });
      assert.equal(dataDir, target);
      assert.equal(locked, true);
    });
  });

  it('uses the remembered pointer when nothing else says otherwise', async () => {
    await withDataFolderPointerPreserved(async () => {
      const target = await tempDir('pointer');
      await write(dataFolderPointerFile, { dataFolder: target, resolved: target });

      const { dataDir } = await resolvedDataDir({});
      assert.equal(dataDir, target);
    });
  });

  it('falls back to the default when the pointer is unreadable', async () => {
    await withDataFolderPointerPreserved(async () => {
      await write(dataFolderPointerFile, 'not json at all');
      assert.equal((await resolvedDataDir({})).dataDir, defaultDataDir);
    });
  });

  it('falls back to the default when the pointer names nothing', async () => {
    await withDataFolderPointerPreserved(async () => {
      await write(dataFolderPointerFile, { dataFolder: '   ' });
      assert.equal((await resolvedDataDir({})).dataDir, defaultDataDir);
    });
  });
});

describe('resolveDataFolder', () => {
  it('treats an empty value as "the default"', () => {
    assert.equal(resolveDataFolder(''), defaultDataDir);
    assert.equal(resolveDataFolder('   '), defaultDataDir);
    assert.equal(resolveDataFolder(undefined), defaultDataDir);
  });

  it('makes a relative path absolute against the repository', () => {
    assert.equal(resolveDataFolder('data'), path.join(repoDir, 'data'));
  });

  it('keeps an absolute path as it is', async () => {
    const target = await tempDir('abs');
    assert.equal(resolveDataFolder(target), target);
  });

  it('expands a leading ~', () => {
    assert.equal(resolveDataFolder('~/somewhere'), path.join(os.homedir(), 'somewhere'));
    assert.equal(resolveDataFolder('~'), os.homedir());
  });
});

describe('the files map follows the data folder', () => {
  it('is computed on access, so switching folders switches every path', async () => {
    const first = await useDataFolder({ label: 'first' });
    assert.equal(files.agentsDir, path.join(first, 'agents'));
    assert.equal(files.schema, path.join(first, 'agents.schema.json'));
    assert.equal(files.hashesRunsDir, path.join(first, 'hashes', 'runs'));
    assert.equal(files.hashesIndex, path.join(first, 'hashes', 'index.json'));

    const second = await useDataFolder({ label: 'second' });
    assert.equal(files.agentsDir, path.join(second, 'agents'), 'no stale value is held anywhere');
    assert.equal(config.dataDir, second);
  });
});

describe('expandPath', () => {
  it('treats an empty value as the home folder', () => {
    assert.equal(expandPath(''), os.homedir());
    assert.equal(expandPath('  '), os.homedir());
    assert.equal(expandPath('~'), os.homedir());
    assert.equal(expandPath(undefined), os.homedir());
  });

  it('expands ~/ and resolves the rest', () => {
    assert.equal(expandPath('~/projects'), path.join(os.homedir(), 'projects'));
    assert.equal(expandPath('/tmp'), path.resolve('/tmp'));
  });
});

describe('resolveBrowsable', () => {
  it('accepts an existing folder', async () => {
    const dir = await tempDir('browse');
    assert.equal(await resolveBrowsable(dir), dir);
  });

  it('reports a missing folder as 404, saying so', async () => {
    await assert.rejects(
      () => resolveBrowsable('/tmp/definitely-not-here-42'),
      (err) => err.status === 404 && /No such folder/.test(err.message),
    );
  });

  it('reports a file as 400', async () => {
    const dir = await tempDir('browse');
    const file = path.join(dir, 'a.txt');
    await fs.writeFile(file, 'x');
    await assert.rejects(() => resolveBrowsable(file), (err) => err.status === 400 && /Not a folder/.test(err.message));
  });

  it('refuses to leave the jail when one is configured', async () => {
    const dir = await tempDir('jail');
    const inner = path.join(dir, 'inner');
    await fs.mkdir(inner, { recursive: true });
    config.browseRoot = dir;
    try {
      assert.equal(await resolveBrowsable(dir), dir, 'the jail itself is allowed');
      assert.equal(await resolveBrowsable(inner), inner);
      await assert.rejects(
        () => resolveBrowsable('/'),
        (err) => err.status === 403 && /outside the allowed root/.test(err.message),
      );
    } finally {
      config.browseRoot = null;
    }
  });

  it('refuses a folder that only looks like it is inside the jail', async () => {
    const parent = await tempDir('lookalike');
    const jail = path.join(parent, 'root');
    await fs.mkdir(jail, { recursive: true });
    await fs.mkdir(path.join(parent, 'root-other'), { recursive: true });

    config.browseRoot = jail;
    try {
      await assert.rejects(() => resolveBrowsable(path.join(parent, 'root-other')), { status: 403 });
    } finally {
      config.browseRoot = null;
    }
  });
});

describe('parentOf', () => {
  it('walks up to the filesystem root and stops there', () => {
    assert.equal(parentOf('/tmp/a/b'), path.resolve('/tmp/a'));
    assert.equal(parentOf('/'), null);
  });

  it('stops at the jail boundary', async () => {
    const jail = await tempDir('boundary');
    const inner = path.join(jail, 'inner', 'deeper');
    await fs.mkdir(inner, { recursive: true });

    config.browseRoot = jail;
    try {
      assert.equal(parentOf(inner), path.join(jail, 'inner'), 'one level up');
      assert.equal(parentOf(path.join(jail, 'inner')), jail, 'up to the jail itself');
      assert.equal(parentOf(path.join(jail, 'file.txt')), jail, 'a file directly inside it');
      assert.equal(parentOf(jail), null, 'and no further: the jail has no parent to offer');
    } finally {
      config.browseRoot = null;
    }
  });
});