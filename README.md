# json4agents-manager

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

A local web app for keeping track of agents and the files they touch: browse and
edit agent records, hash a folder to see exactly what changed since the last run,
link uncommitted git files to the agent that produced them, and record an
execution so a teammate never pays for the same generation twice.

Built for anyone running multiple agents over the same workspace: the records
live as plain JSON in git, the hash store survives a two-user merge, and nothing
leaves your machine.

<!--
Add a screenshot or GIF here, e.g.:

  ![screenshot](docs/screenshots/app.png)

-->

```
npm install
npm start        # http://127.0.0.1:8000
```

Node 22 or newer. No build step, no bundler; the app keeps its runtime dependencies intentionally small and browser-native.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Options](#options)
- [Tests](#tests)
- [`npm run doctor`](#npm-run-doctor)
- [Data layout](#data-layout)
- [HTTP API](#http-api)
- [Project layout](#project-layout)
- [Dependencies](#dependencies)
- [Documentation](#documentation)
- [License](#license)

## Features

**Agents** - one JSON file per record under `data/agents/`, ordered by code. Add,
edit and delete from a schema-generated popup; changing a code renames the file.
A file whose content disagrees with its name is reported rather than loaded.

**Hashing** - point it at a folder and it writes SHA-256 for every file and a
rolled-up hash for every folder, with live progress and cancel. Yellow dot marks
rows whose content changed; click one for its full history. Re-hashing an
unchanged tree records almost nothing.

**Link Changes to Agent** - the uncommitted files in your workspace, from
`git status`, with checkboxes and an agent picker that writes the selection into
that agent's `result_generated_files`. The same selection can be recorded as an
execution.

**Execution plan** - after hashing, the app can rebuild an ordered run plan from
the changed paths and downstream dependencies. The plan is stored in
`data/execution-plan.json`, where each step records whether it is done and can
be regenerated at any time from the current hash view.

**Executions** - a receipt per published run: the git blob and SHA-256 of the
selected outputs and of the agent's `source_dependant_files`, in one immutable
file under `data/executions/` that you commit with the outputs. A teammate who
pulls it sees the work is done; a hand-edited output or an unpushed run is not a
receipt.

**Settings** - where the workspace is, where its git root is, and where the data
folder lives. Saving reloads everything that depends on it.

**`npm run doctor`** - read-only integrity checks over a data folder, exit code
`1` on error, so it can gate a commit.

## How it works

**One file per record.** Two agents can never overwrite each other, and a single
record diffs, reviews and merges on its own.

**One immutable file per hash run.** A run writes a new file under
`data/hashes/runs/` and never edits an old one; it records only the paths whose
hash changed, so a run over an unchanged tree is tiny and two people hashing at
once produce two files that git merges without a conflict. "Which hash is
current" is computed from the run files, never stored - so a merge cannot make
the grid show a stale hash as current.

**One immutable file per execution receipt.** Recording a run writes a new file
under `data/executions/` holding the git blob and SHA-256 of the outputs and of
the agent's inputs; it is committed with the outputs, so two people recording at
once add two files that merge cleanly instead of fighting over one document. The
content is read from the git index, never a dirty working tree, and republishing
the same outputs for unchanged inputs is refused - a hand-edited output is not a
new execution.

**Plain files, no lock-in.** Everything the app persists is JSON on disk
([data layout](#data-layout)); hashing uses `node:crypto`, and the browser UI
needs no file system permissions of its own. No account, no sync, no telemetry.

**A shared schema.** Every write is validated against `data/agents.schema.json`
(JSON Schema draft 2020-12), which also generates the edit form - fields, types
and required markers follow the schema, not hard-coded UI.

## Options

Also available as `PORT` / `HOST` / `JSONM_DATA_DIR`:

| Flag | Meaning | Default |
| --- | --- | --- |
| `--port 9000` | port to listen on | `8000` |
| `--host 0.0.0.0` | interface to bind | `127.0.0.1` |
| `--data-dir /path` | where the data files live | `<repo>/data` |
| `--root ~/projects` | jail: browsing and hashing stop at this folder | unrestricted |

`npm run dev` does the same with `node --watch`, so the server restarts when a
file in `server/` changes.

## Tests

```bash
npm test
```

`node:test`, ships with Node - no extra dependency. The suite runs the real
server on an ephemeral port against a throwaway data folder under the OS temp
dir; **nothing ever touches `data/`**. It also replays a real two-user
`git merge` - for the hash store and for execution receipts - inside real
repositories under the temp dir. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 12 for how the suite is
wired.

## `npm run doctor`

```bash
npm run doctor                              # check the data folder
npm run doctor -- --data-dir /path/to/data
npm run doctor -- --json                    # machine readable
```

Read only, reports with a severity for each finding. The failures worth catching
are not crashes but states that are still valid JSON and still wrong:

| Area | Checks |
| --- | --- |
| agents | file name matches the record's code, no duplicate or case-colliding codes, records parse and match the schema, set valued fields free of duplicates and sorted, no absolute or `..` paths, `parent` points at an agent that exists |
| hashes | run files parse, no two runs claiming one id, every path relative and inside the root, no repeated or out-of-order hashes, every folder hash equal to the rollup of its children, the index lists every run |
| executions | receipt files parse, no unknown agent code, every path relative and inside the git root, no output published twice under unchanged inputs, no receipt that no longer matches the committed files |
| data | `agents.schema.json` present, no leftover legacy `hashes.json`, incomplete workspace settings |

Exit code is `1` when anything is an error. A folder hash is recomputed with the
very function the runner used, so the check cannot drift from the writer.

## Data layout

`webapp/` holds only code; everything the app persists lives in `data/`:

```
data/
  agents.schema.json    JSON Schema (draft 2020-12) every write is validated against
  agents/
    AG-001.json         one file per agent record - the file name is the agent code
  hashes/
    runs/*.json         one immutable file per hash run   [git ignored]
    index.json          derived cache (git ignored, rebuildable)
  executions/
    README.md           what a receipt is, and the commit discipline
    <id>.json           one immutable receipt per published run (committed)
  execution-plan.json   saved run-order snapshot for the Hashing tab; user-authored, not committed
  state.json            UI state, e.g. the last folder used in the hashing tab
  settings.json         settings chosen in the Settings tab
```

Writes go through a temporary file plus `rename()`, so an interrupted write can
never truncate a file.

**Hash run files are not tracked.** They record the absolute path of the folder
that was hashed and the path of every file in it, which is local information by
nature - so this repository ships an empty store and your first run fills it. A
team that wants one shared store in git can opt in; see
[`data/hashes/README.md`](data/hashes/README.md).

**Execution receipts are tracked.** Unlike a hash run, a receipt holds only
git-relative paths and hashes - no absolute path, no machine name - so it is
meant to be committed and pulled by the rest of the team. See
[`data/executions/README.md`](data/executions/README.md).

`state.json`, `settings.json` and the data-folder location are machine specific
too, so they are git ignored, and a missing, empty or malformed one falls back to
the defaults instead of breaking the app.

### The agent store

- **The code is the file name.** Codes are checked against
  `[A-Za-z0-9][A-Za-z0-9._-]*` before they become a path, so a code can never
  escape the folder. Changing a code in the edit popup renames the file.
- **A file whose code disagrees with its name is refused**, with an error naming
  the file and both codes, instead of appearing as a row that would write to the
  wrong file. Codes that differ only in case are reported too: two files on
  Linux, one file on macOS or Windows.
- **Grid order is code order**, never the filesystem's.
- **A broken file is reported, not hidden** - an error badge next to the grid
  instead of a silent disappearance.
- An existing code returns `409`; every write is validated twice, once for the
  record and once for the collection it would belong to.

## HTTP API

| Method + path | Purpose |
| --- | --- |
| `GET /api/agents` | every record from `data/agents/`, sorted by code, plus its validation result |
| `GET /api/agents/:code` | one record |
| `POST /api/agents` | create `data/agents/<code>.json` (`409` if the code exists) |
| `PUT /api/agents/:code` | update that file; renames it when the code changed |
| `DELETE /api/agents/:code` | remove the file |
| `GET /api/schema` | the JSON Schema, used to build the edit form |
| `GET /api/changes` | uncommitted git files inside the workspace folder |
| `POST /api/agents/:code/link-files` | add paths to that agent's `result_generated_files` |
| `GET /api/agent-dependencies` | agents plus the edges where one agent's output feeds another's input |
| `GET /api/execution-plan` | the saved run order for the paths that changed, with per-step `done` flags |
| `POST /api/execution-plan/generate` | rebuild that plan from the current hash view |
| `PATCH /api/execution-plan` | toggle one or more step `done` flags |
| `GET /api/hashes` | hash history assembled from the run files |
| `POST /api/hashes/rebuild` | force a rebuild of the derived index |
| `GET /api/executions` | execution receipts, each with its status against git |
| `POST /api/executions` | record an execution from `{agent, paths}` (`409` if already published for the same inputs) |
| `GET /api/state` | `state.json` (e.g. the last hashed folder) |
| `PUT /api/state` | merge a patch into `state.json` |
| `GET /api/settings` | `settings.json` (workspace folder and git root) |
| `PUT /api/settings` | validate, then merge a patch into `settings.json` |
| `GET /api/data-folder` | the data folder setting and the folder in use |
| `PUT /api/data-folder` | switch data folder, carrying the schema over if needed |
| `GET /api/fs?path=…` | one directory listing for the folder browser |
| `POST /api/hash` | `{path, includeHidden, followSymlinks}` → newline delimited JSON progress stream |

## Project layout

```
package.json                  npm scripts and the runtime dependencies
data/                         everything the app persists (see above)
webapp/server.js              express app: static files + API
webapp/server/
  config.js                   CLI/env configuration, data paths
  store.js                    read/write JSON, atomic writes
  validate.js                 Ajv 2020-12: record and collection validators
  agentsStore.js              one JSON file per agent in data/agents/
  agentsApi.js                CRUD for the agent files, GET /api/schema,
                              POST /api/agents/:code/link-files
  agentsValidation.js         one agent record + its collection, shared by both
  agentDependencies.js        which agents' outputs feed other agents' inputs
  dependenciesApi.js          GET /api/agent-dependencies
  gitChanges.js               git status of the workspace folder, relative to the git root
  changesApi.js               GET /api/changes
  executionPlan.js            run order derived from the changed paths
  executionPlanStore.js       data/execution-plan.json, tolerant of a broken file
  executionPlanApi.js         GET/POST/PATCH /api/execution-plan
  executionsStore.js          execution receipts: git blob + SHA-256 of inputs and outputs
  executionsApi.js            GET/POST /api/executions
  stateFile.js                shared read/write/atomic-write helper for the two small files
  stateStore.js               data/state.json, tolerant of a broken file
  stateApi.js                 GET/PUT /api/state
  settingsStore.js            data/settings.json, tolerant of a broken file
  settingsValidation.js       workspace/git root rules enforced on save
  settingsApi.js              GET/PUT /api/settings
  dataFolderApi.js            GET/PUT /api/data-folder, switch + schema carry-over
  fsApi.js                    GET /api/fs, path resolution and root jail
  hashRunner.js               walk, parallel SHA-256, folder rollups
  hashApi.js                  POST /api/hash progress stream, GET /api/hashes
  hashesStore.js              run files, derived index, legacy migration
webapp/index.html             import map: "vue" -> /vendor/vue.esm-browser.prod.js
webapp/styles.css
webapp/src/                   browser app (no build step)
  main.js  api.js  store.js  format.js
  components/  App  AgentsTab  AgentModal  AgentDependenciesTab
                HashingTab  HashDetail  ExecutionPlanPanel  LinkChangesTab
                ExecutionsTab  FolderPicker  SettingsTab  DataTable
webapp/tools/
  doctor.js                   npm run doctor: read only integrity checks
test/                         npm test: node:test suite, temp data folders only
```

## Dependencies

All MIT and actively maintained: [express](https://expressjs.com) 5.x (HTTP
server), [vue](https://vuejs.org) 3.5 (UI, served from `node_modules`, no
bundler), [ajv](https://ajv.js.org) 8.x + ajv-formats (schema validation).
Hashing uses `node:crypto`, so there is no hashing dependency. Tests use
`node:test`, so there is no test dependency either.

## Documentation

| | |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how it is built and why - the file to read first |
| [`data/hashes/README.md`](data/hashes/README.md) | what a hash run file is, and how to share a store through git |
| [`data/executions/README.md`](data/executions/README.md) | what an execution receipt is, and the commit discipline around it |

## License

[Apache-2.0](LICENSE) - see the `LICENSE` and `NOTICE` files.
