/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integrity checks for the data folder.
 *
 *   npm run doctor              check the default data folder
 *   npm run doctor -- --data-dir /path/to/data
 *   npm run doctor -- --json    machine readable output
 *
 * The store is plain files in git, so the interesting failures are not crashes
 * but states that are valid text and still wrong: an agent file whose
 * frontmatter does not match the schema, a hash history that repeats itself, a
 * folder hash that no longer matches its children. Everything here is read only.
 *
 * Exit code is 1 when anything is an error, so it can gate a commit or a build.
 */
import path from 'node:path';
import { config, files } from '../server/config.js';
import { agentsDir, scanAgents } from '../server/agentsStore.js';
import { getIndex, listRunFiles, readAllRuns, readBrokenRunFiles } from '../server/hashesStore.js';
import { rollupHash } from '../server/hashRunner.js';
import { readState } from '../server/stateStore.js';
import { readSettings as readSettingsFile } from '../server/settingsStore.js';
import { validateWorkspaceSettings } from '../server/settingsValidation.js';
import { fileExists } from '../server/store.js';

const MAX_LISTED = 8;

const findings = [];
const add = (level, area, message, detail) => findings.push({ level, area, message, detail });

// ------------------------------------------------------------------- agents

async function checkAgents() {
  const { records, issues } = await scanAgents();
  // scanAgents already rejects files whose frontmatter does not match the
  // bundled schema; everything it could not use arrives as an issue.
  for (const issue of issues) add('error', 'agents', issue.message, issue.file);
  return { count: records.length };
}

// -------------------------------------------------------------------- hashes

async function checkHashes() {
  if (!(await fileExists(files.hashesRunsDir))) {
    add('info', 'hashes', 'No runs recorded yet');
    return 0;
  }

  const runFiles = await listRunFiles();
  const runs = await readAllRuns();

  // Run files the store skipped: the app carries on without them, but silently
  // losing a record is exactly the kind of thing this command is for.
  for (const broken of await readBrokenRunFiles()) {
    add('error', 'hashes', `Run file ${broken.file} cannot be read`, broken.message);
  }

  const seenIds = new Map();

  for (const run of runs) {
    const previous = seenIds.get(run.id);
    if (previous) add('error', 'hashes', `Two run files claim the id ${run.id}`, path.basename(previous));
    else seenIds.set(run.id, run.file ?? run.id);

    if (!run.root) add('warning', 'hashes', `Run ${run.id} has no root folder recorded`);
    if (run.files.length === 0 && run.folders.length === 0) {
      add('info', 'hashes', `Run ${run.id} changed nothing`, run.finishedAt);
    }
    for (const entry of [...run.files, ...run.folders]) {
      if (path.isAbsolute(entry.path)) add('error', 'hashes', `Run ${run.id} holds an absolute path`, entry.path);
      else if (entry.path.split('/').includes('..')) add('error', 'hashes', `Run ${run.id} escapes the git root`, entry.path);
    }
  }

  // Assemble histories the same way the API does, then check them.
  const files_ = new Map();
  const folders = new Map();
  for (const run of runs) {
    for (const entry of run.files) push(files_, entry, run);
    for (const entry of run.folders) push(folders, entry, run);
  }

  let duplicates = 0;
  let unordered = 0;
  for (const [list, kind] of [[files_, 'file'], [folders, 'folder']]) {
    for (const [entryPath, history] of list) {
      for (let i = 1; i < history.length; i += 1) {
        if (history[i].hash === history[i - 1].hash) {
          duplicates += 1;
          if (duplicates <= MAX_LISTED) {
            add('warning', 'hashes', `${kind} ${entryPath} repeats a hash in its history`, `${history[i - 1].datetime} and ${history[i].datetime}`);
          }
        }
        // Histories are assembled newest first, so an entry that is *older*
        // than the one before it breaks the order.
        if (history[i].datetime > history[i - 1].datetime) {
          unordered += 1;
          if (unordered <= MAX_LISTED) {
            add('error', 'hashes', `${kind} ${entryPath} has history out of order`, `${history[i - 1].datetime} then ${history[i].datetime}`);
          }
        }
      }
    }
  }
  if (duplicates > MAX_LISTED) add('warning', 'hashes', `… and ${duplicates - MAX_LISTED} more repeated hashes`);
  if (unordered > MAX_LISTED) add('error', 'hashes', `… and ${unordered - MAX_LISTED} more out-of-order entries`);

  // A folder hash must be the rollup of its children's current hashes.
  const current = (list, entryPath) => list.get(entryPath)?.[0]?.hash;
  let mismatches = 0;
  for (const [folderPath, history] of folders) {
    const children = [];
    const prefix = folderPath === '.' ? './' : `${folderPath}/`;
    for (const [entryPath] of files_) {
      if (entryPath.startsWith(prefix) && !entryPath.slice(prefix.length).includes('/')) {
        children.push({ name: entryPath.slice(prefix.length), hash: current(files_, entryPath) });
      }
    }
    for (const [childPath] of folders) {
      if (childPath.startsWith(prefix) && !childPath.slice(prefix.length).includes('/')) {
        children.push({ name: childPath.slice(prefix.length), hash: current(folders, childPath) });
      }
    }
    if (children.length === 0) continue;

    const expected = rollupHash(children);
    const actual = history[0].hash;
    if (expected !== actual) {
      mismatches += 1;
      if (mismatches <= MAX_LISTED) {
        add('warning', 'hashes', `Folder ${folderPath} does not match its children`, 'expected ' + expected.slice(0, 12) + ', recorded ' + actual.slice(0, 12));
      }
    }
  }
  if (mismatches > MAX_LISTED) {
    add('warning', 'hashes', `… and ${mismatches - MAX_LISTED} more folder rollups that do not match their children`);
  }

  // The index is derived; if it is stale it is only a performance problem.
  const index = await getIndex();
  if (runs.length > 0 && index.runs.length !== runs.length) {
    add('warning', 'hashes', 'The index does not list every run file', `${index.runs.length} of ${runs.length}`);
  }

  return runFiles.length;
}

const push = (list, entry, run) => {
  const history = list.get(entry.path) ?? [];
  history.push({ datetime: run.finishedAt, runId: run.id, hash: entry.hash, size: entry.size, mtime: entry.mtime });
  list.set(entry.path, history);
};

// -------------------------------------------------------------- data folder

async function checkDataFolder() {
  const legacy = await fileExists(files.hashes);
  if (legacy) {
    add('warning', 'data', 'A legacy hashes.json is still present and is no longer read', 'remove it once you are happy with the run files');
  }
  const backup = await fileExists(files.hashes.replace(/\.json$/, '.migrated.json'));
  if (backup) add('info', 'data', 'The pre-migration hashes.json backup is still here', 'safe to delete');

  const state = await readState();
  const settings = await readSettingsFile();
  const workspace = await validateWorkspaceSettings(settings);
  if (!workspace.valid && (settings.workspaceFolder !== '' || settings.gitRoot !== '')) {
    add('warning', 'settings', 'The workspace settings are incomplete', workspace.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  }
  return { lastFolder: state.hashTab.lastFolder, settings };
}

// ------------------------------------------------------------------- report

async function main() {
  const asJson = process.argv.includes('--json');
  const agents = await checkAgents();
  const runs = await checkHashes();
  const meta = await checkDataFolder();

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');
  const infos = findings.filter((f) => f.level === 'info');

  if (asJson) {
    console.log(JSON.stringify({ dataDir: config.dataDir, agents: agents.count, runs, findings }, null, 2));
    return errors.length === 0 ? 0 : 1;
  }

  console.log(`data folder : ${config.dataDir}`);
  console.log(`agents      : ${agents.count}`);
  console.log(`hash runs   : ${runs}`);
  console.log(`last hashed : ${meta.lastFolder || '(none)'}`);
  console.log('');

  if (findings.length === 0) {
    console.log('No problems found.');
    return 0;
  }

  for (const level of ['error', 'warning', 'info']) {
    for (const finding of findings.filter((f) => f.level === level)) {
      console.log(`${level.toUpperCase().padEnd(7)} ${finding.area}: ${finding.message}`);
      if (finding.detail) console.log(`        ${finding.detail}`);
    }
  }
  console.log('');
  console.log(`${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} note(s).`);
  return errors.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`doctor failed: ${err.stack || err.message}`);
    process.exit(2);
  });