# JSON Manager - development guide

Everything a new agent needs to continue working on this repository without an
exploratory pass over the code. Written against commit `5992e97` plus the
changes described in the last section.

---

## 1. What this project is

A local, single-user web app for managing three kinds of data on the developer's
own machine:

1. **Agent records** - one JSON file per agent in `data/agents/`, validated
   against a JSON Schema.
2. **Hash history** - SHA-256 hashes of files and folders, kept in
   `data/hashes/runs/`, used to see what changed since the last run.
3. **Execution receipts** - one immutable file per published run in
   `data/executions/`, committed to git, so a teammate can see which work is
   already done without running the agent again.

The Node server owns all file access. The browser is a pure view: it never asks
for filesystem permissions and works in any current browser. The previous
implementation was a static page using the File System Access API, which
required Chromium and permission prompts; it was removed in `5992e97`.

## 2. Running it

Node 22 or newer must be on `PATH`:

```bash
node --version   # v22 or newer
```

```bash
npm install     # install the runtime dependencies
npm start       # http://127.0.0.1:8000
npm run dev     # same with node --watch
npm test        # node:test suite, real filesystem + git integration checks
npm run doctor  # read only integrity checks, exit 1 if anything is an error
```

Server flags (also `PORT` / `HOST` / `JSONM_DATA_DIR` environment variables):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `8000` | listen port |
| `--host` | `127.0.0.1` | interface; the loopback guard is only active for loopback hosts |
| `--data-dir` | `<repo>/data` | where all data files live |
| `--root` | unrestricted | jail: browsing and hashing cannot leave this folder |

**Testing pattern that matters:** never exercise write paths against the real
`data/`. The test suite enforces this - `test/helpers.js` hands every test its own
folder under the OS temp dir and the suite asserts it left no `data-location.json`
behind - but a manual experiment should do the same: start a second instance with
`--data-dir /tmp/some-copy`. Twice in this project's history a manual test wrote
junk into the real `data/hashes.json` and into real agent files; recovery was done
by restoring a `cp -r data /tmp/backup` snapshot taken beforehand.
`npm run doctor -- --data-dir /tmp/some-copy` is safe for the same reason.

## 3. Architecture

```
browser (Vue 3 ESM, no bundler)
   |  fetch JSON
   v
Express 5 server  ->  filesystem (agents/, hashes/runs/, executions/, state.json, settings.json)
   |                     + child_process git (changes tab, execution receipts)
   v
node:crypto (SHA-256), child_process (git status, git ls-files / ls-tree)
```

No framework on the server beyond Express, no validation library beyond Ajv, no
hashing library beyond `node:crypto`. Dependencies are all MIT and actively
maintained:

| Package | Version | Role |
| --- | --- | --- |
| `express` | 5.3.0 | HTTP server, routing |
| `vue` | 3.5.44 | UI, served from `node_modules` |
| `ajv` | 8.20.0 | JSON Schema draft 2020-12 validation |
| `ajv-formats` | 3.0.1 | `format: date-time` support |

### Why there is no build step

`webapp/index.html` contains an import map:

```html
<script type="importmap">
  { "imports": { "vue": "/vendor/vue.esm-browser.prod.js" } }
</script>
```

`server.js` serves that URL from `require.resolve('vue/dist/vue.esm-browser.prod.js')`.
Source files are plain ES modules using template strings for templates, loaded
straight by the browser. Consequence: **templates use the full Vue build with
its compiler**, so `template: \`...\`` works, and there is no TS/JSX step.

## 4. File map

```
package.json                  scripts + the runtime dependencies
README.md                     user documentation
docs/ARCHITECTURE.md          this file
data/                         all persisted data (see below)
webapp/server.js              express app, static routes, error handler, loopback guard
webapp/index.html             import map, mounts #app
webapp/styles.css             all styling
webapp/server/
  config.js                   CLI/env parsing; exports appDir, repoDir, config, files
  store.js                    readJsonFile / writeJsonFile (atomic) / fileExists
  validate.js                 Ajv setup; validateAgentRecord, validateAgentCollection
  agentsStore.js              one JSON file per agent; code<->filename rules, scanAgents()
  agentsValidation.js         checkAgent(agent, previousCode) - shared by CRUD and linking
  agentsApi.js                CRUD for agent files, GET /api/schema, POST link-files
  agentDependencies.js        entriesOverlap / findDependencies: which outputs feed which inputs
  dependenciesApi.js          GET /api/agent-dependencies
  gitChanges.js               git status of the workspace folder
  changesApi.js               GET /api/changes
  executionPlan.js            buildExecutionPlan: changed paths -> ordered steps
  executionPlanStore.js       data/execution-plan.json, tolerant of a broken file
  executionPlanApi.js         GET/POST/PATCH /api/execution-plan
  executionsStore.js          receipts: git blob + SHA-256 lookup, recordExecution, receiptsView
  executionsApi.js            GET/POST /api/executions
  fsApi.js                    GET /api/fs (folder browser backend), path jail
  hashRunner.js               tree walk, parallel SHA-256, folder rollups
  hashApi.js                  POST /api/hash (NDJSON stream), GET /api/hashes
  hashesStore.js              run files, derived index, legacy migration
  stateFile.js                shared read/write helper for the two small state files
  stateStore.js               data/state.json
  stateApi.js                 GET/PUT /api/state
  settingsStore.js            data/settings.json
  settingsValidation.js       workspace + git root rules
  settingsApi.js              GET/PUT /api/settings
  dataFolderApi.js            GET/PUT /api/data-folder, switch + schema carry-over
webapp/src/
  main.js                     createApp(...).mount('#app')
  api.js                      fetch wrappers; hashFolder() reads the NDJSON stream
  store.js                    all shared reactive state + actions
  format.js                   bytes / duration / time / shortHash / latestHash helpers
  components/
    App.js                    tab strip + banner; mounts the tabs
    DataTable.js              generic sortable grid with per-column slots
    AgentsTab.js              agent grid + row actions
    AgentModal.js             schema-driven add/edit/delete popup
    AgentDependenciesTab.js   output/input graph between agents
    HashingTab.js             path box, folder picker, hash grid, progress line
    HashDetail.js             hash history popup (newest first)
    ExecutionPlanPanel.js     ordered run plan for the changed paths
    LinkChangesTab.js         uncommitted git files -> agent linking, record execution
    ExecutionsTab.js          execution receipts grid, status against git
    FolderPicker.js           in-app folder browser modal
    SettingsTab.js            workspace folder + git root settings
webapp/tools/
  doctor.js                   npm run doctor - read only integrity checks, exit 1 on errors
test/                         npm test - node:test suite; every test gets its own
                              temp data folder, nothing touches the real data/
```

## 5. Data files

```
data/
  agents.schema.json    JSON Schema draft 2020-12 - the contract for agent files
  agents/<CODE>.json    one agent per file; the file name IS the code
  hashes/
    README.md           why the run files are not tracked
    runs/<runId>.json   one immutable file per hash run         [gitignored]
    index.json          derived cache, rebuilt on demand        [gitignored]
  executions/
    README.md           what a receipt is, and the commit discipline
    <id>.json           one immutable receipt per published run [tracked]
  execution-plan.json   saved run-order snapshot for the Hashing tab [gitignored]
  state.json            last hashed folder (session memory)      [gitignored]
  settings.json         workspace folder + git root (config)     [gitignored]
data-location.json      which folder is the data folder          [gitignored]
```

**Nothing under `data/hashes/runs/` is published.** A run file records the
absolute path of the folder it hashed and the path of every file in it, so it is
local information by nature. The repository ships an empty store; the app creates
the folder on demand and the first run fills it. A team that wants one shared
store in git opts in by dropping that line from `.gitignore` - see
`data/hashes/README.md`.

An old single `hashes.json` is converted once at startup into run files (see
`migrateLegacyHashes`); the original is kept as `hashes.migrated.json`, which is
ignored as well.

**Execution receipts are the opposite: they are tracked.** A receipt holds no
absolute path and no machine name - only paths relative to the git root, each
with the git blob id and the SHA-256 of the content - so it is safe to publish,
and publishing it is the whole point. `data/executions/` must stay out of
`.gitignore`.

The data folder itself is a setting, so it cannot be stored inside the data
folder - it lives in `data-location.json` next to `package.json`. Startup
precedence is `--data-dir` / `JSONM_DATA_DIR` > that file > `<repo>/data`.

**Everything that touches a data path resolves it lazily.** `config.files`
exposes getters and `createStateFile` takes a `getPath()` function, so
`setDataDir()` in the Settings tab changes where the whole app reads and writes
without a restart. One cache does not follow automatically: the compiled Ajv
schema, cleared through `resetSchemaCache()` on every switch. It is also cleared
when compilation *fails*, so fixing a broken schema does not require a restart.

Switching is all-or-nothing (`server/dataFolderApi.js`): the target folder is
created, a missing `agents.schema.json` is copied over from the current folder,
and only then does the app move. A failure leaves the previous folder in use.

`state.json` and `settings.json` are gitignored because they hold absolute paths
from this machine. Both are optional at runtime: a missing, empty or malformed
file falls back to defaults instead of breaking the app (see `stateFile.js`
and the `sanitise` functions).

### Agent files

`data/agents/<CODE>.json` holds exactly one agent object. The code is the file
name and must match `[A-Za-z0-9][A-Za-z0-9._-]*` - checked before it becomes a
path, so a code can never escape the folder. Editing a code renames the file.
Grid order is code order, sorted in memory, never filesystem order.

Validation runs twice per write: once against `$defs/agent` for the record
itself (gives precise per-field errors), once against the root schema for the
collection the record would join (catches cross-record problems). See
`agentsValidation.js`.

**Identity is enforced on read, not only on write.** `scanAgents()` keeps a file
only when its name stem equals its `code`. A file that disagrees cannot be
addressed, renamed or deleted without creating a second copy of the record, so
it is reported as an issue and left out of the list rather than shown as a row
that would write to the wrong file. Codes that collide when case is folded are
also reported: two files on Linux, one file on macOS or Windows. Every issue is
surfaced through `GET /api/agents` as an entry in `errors`, so the grid's error
badge and `npm run doctor` report the same findings.

### Hash run files

```jsonc
// data/hashes/runs/2026-10-16T19-04-31-469Z_a200cd6c.json - written once, never edited
{
  "id": "2026-10-16T19-04-31-469Z_a200cd6c",  // finishedAt + random suffix, so it sorts by time
  "host": "laptop",
  "root": "/abs/path",
  "startedAt": "…", "finishedAt": "…", "durationMs": 524,
  "stats": { "files": 990, "bytes": 4190372, "errors": 0, "changed": 3, "unchanged": 2425 },
  "files":   [{ "path", "size", "mtime", "hash" }],   // only what changed
  "folders": [{ "path", "hash" }]
}
```

A run file is a **delta**: `saveHashRun` compares each result against the index
and records only paths whose hash differs. An unchanged tree therefore produces a
run file of a few hundred bytes containing run metadata and empty arrays, rather
than a rewrite of the whole store. Nothing that exists is ever edited, which is
what makes two people hashing at the same time produce two files that git merges
without a conflict.

`data/hashes/index.json` is derived, git ignored and rebuilt whenever a run file
appears or changes (the fingerprint is `name:size:mtime` for each run file). The
API serves the old flat shape assembled from it - `files`/`folders` rows with a
`hashes[]` history newest first - so no browser component knows about run files.

Folder hashes roll up bottom-up:

```
folderHash = sha256( concat over children sorted by name of  name + "\0" + childHash + "\u001e" )
```

This is the algorithm the old browser implementation used, verified to
reproduce all 311 folder hashes that shipped in the original file byte for byte.
An empty folder therefore hashes to `e3b0c442…b855` (digest of the empty
string). `rollupHash()` in `hashRunner.js` is the single implementation, used by
both the runner and the doctor's rollup check so the two cannot drift.

`size` and `mtime` come from the newest run that mentions the path. Whether a
path "changed" is likewise computed, by comparing consecutive hashes in its
assembled history - never stored, so a merge cannot corrupt it.

### Execution receipts

```jsonc
// data/executions/2026-10-17T09-12-44-010Z_7f3a91cc.json - written once, never edited
{
  "id": "2026-10-17T09-12-44-010Z_7f3a91cc",
  "agent": "AG-001",
  "recordedAt": "2026-10-17T09:12:44.010Z",
  "inputs":  [{ "path": "config/root.json", "blob": "…40 hex…", "sha256": "…64 hex…" }],
  "outputs": [{ "path": "out/root-report.md", "blob": "…40 hex…", "sha256": "…64 hex…" }]
}
```

A receipt answers one question across a team that shares the workspace through
git: *has this agent already been run over these inputs, and are the outputs
that came out of it committed?* `inputs` is the agent's
`source_dependant_files`; `outputs` is the selection the user recorded. `blob`
is the git object id **from the index**, `sha256` the hash of the same bytes -
the record is written from the index, never a dirty working tree, so a receipt
describes what the commit will actually contain.

Rules the writer enforces (`server/executionsStore.js`):

- **Nothing untracked or dirty.** Every input and output must be staged or
  committed; an unstaged change is refused, because the receipt would not match
  the commit.
- **Republishing the same outputs for unchanged inputs is refused** with `409`,
  and the same holds when the bytes changed but the inputs did not: that is a
  hand-edited output, not a new run. A new receipt is only written when the
  inputs changed. Comparing inputs uses `sameEntrySet` (same paths, same blobs).
- **One immutable file per recording**, so two people recording at the same time
  add two files that merge cleanly. The app never runs `git commit`; the banner
  names the receipt and the staged paths that belong in the same commit.
- **Unpushed means nonexistent.** Until the receipt is pushed, no teammate can
  see the execution - which is exactly the intended semantics.

`receiptsView()` computes each receipt's status against git: `valid` (inputs and
outputs match the committed content), `stale-inputs` (an input moved on),
`diverged` (an output no longer matches while the inputs are unchanged), or
`unknown` when no workspace/git root is configured. The status is computed on
read, never stored.

The execution flow the browser uses is: build a hash change set, generate or
reload the saved plan at `data/execution-plan.json`, mark steps as done in the
Hashing tab, and later record a receipt with the selected generated files in the
Link Changes tab. The plan is local state for the workspace and is intentionally
not part of the shared receipt stream.

### npm run doctor

`webapp/tools/doctor.js` is read only and exits `1` when it finds an error, so
it can gate a commit. It reuses the server modules rather than reimplementing
them (`scanAgents`, `validateAgentRecord`, `readAllRuns`, `rollupHash`,
`validateWorkspaceSettings`, `readAllReceipts`, `receiptsView`, `sameEntrySet`)
and prints `ERROR` / `WARNING` / `INFO` groups, or `--json`. Checks are listed in
the README.

Two checks are guards against tampering rather than reachable states: a history
that repeats a hash, and one that goes out of order. With deltas the writer
cannot produce either, but a hand-edited or third-party run file can.

## 6. HTTP API

| Method + path | Purpose |
| --- | --- |
| `GET /api/agents` | every record sorted by code, plus validation errors |
| `GET /api/agents/:code` | one record |
| `POST /api/agents` | create a file; `409` if the code exists |
| `PUT /api/agents/:code` | update; renames the file when the code changed |
| `DELETE /api/agents/:code` | remove the file |
| `POST /api/agents/:code/link-files` | add paths to `result_generated_files` |
| `GET /api/schema` | the schema the edit form is generated from |
| `GET /api/changes` | uncommitted git files in the workspace folder |
| `GET /api/agent-dependencies` | agents plus the output→input edges between them |
| `GET` / `POST /api/execution-plan` | the saved run order, and rebuilding it from the hash view |
| `PATCH /api/execution-plan` | toggle a step's `done` flag |
| `GET /api/executions` | execution receipts with their status against git |
| `POST /api/executions` | record `{agent, paths}`; `409` if already published for the same inputs |
| `GET /api/fs?path=` | one directory listing for the folder browser |
| `POST /api/hash` | NDJSON progress stream, see below |
| `GET /api/hashes` | hash history assembled from the run files |
| `POST /api/hashes/rebuild` | force a rebuild of the derived index |
| `GET`/`PUT /api/state` | session memory (last hashed folder) |
| `GET`/`PUT /api/settings` | workspace folder + git root |
| `GET`/`PUT /api/data-folder` | the data folder, and switching it |

All errors are JSON: `{ error, errors?: [{ field \| path, message }] }`.
Unknown routes return `404` as JSON, not HTML.

### The hash stream

`POST /api/hash` responds with `application/x-ndjson`, one JSON event per line:

```
{"type":"start","root":"/abs/path"}
{"type":"scan-done","total":990}
{"type":"file","path":"…","size":1,"mtime":"…","hash":"…","done":118,"total":990,"bytes":727000}
{"type":"folder","path":"…","hash":"…"}
{"type":"writing"}
{"type":"done","summary":{…,"changed":12,"unchanged":1349,…}}
{"type":"cancelled"}   // client disconnected
{"type":"error","message":"…"}
```

The browser consumes it with `api.hashFolder()`, reading `response.body` as a
stream. Closing the connection aborts the server side: `res.on('close')` fires an
`AbortController` and the hashing loop stops before anything is written - no run
file, no index rebuild.
Verified: after abort the process drops to 0% CPU and the run directory is
unchanged.

## 7. The tabs

### Agents

Grid, one row per agent, sorted by code. Add / edit / delete write the single
file each. The edit popup is generated from `agents.schema.json` - fields, types
(required markers, hints, `string[]` editors) all follow the schema, so
changing the schema changes the form. Required-field checks run client-side for
instant feedback; the authoritative validation is server-side, and its error list
is displayed in the popup with nothing written.

### Agent Dependencies

A Mermaid `flowchart LR` where every agent is a node and an arrow from A to B
means A produces something B reads. The matching rule (file vs folder wildcard,
folder over file, nested folders - `entriesOverlap` in `agentDependencies.js`) is
the server's job; the tab only renders the graph it returns. Mermaid is loaded
once through the import map from `node_modules/mermaid/dist/`.

### Hashing

Path box + *Explore…* (in-app folder browser, no native dialog). *Hash folder*
streams progress into a single status line that includes the last file hashed.
*Cancel* aborts. The grid has three views - **Files**, **Folders**, **Runs** -
sortable and filterable.

- **Yellow dot** in the first column: the row's newest hash differs from the
  previously recorded one.
- **The `● N changed` badge is a filter switch**: clicking it hides unchanged
  rows so only the dotted ones remain (`changedOnly` in `HashingTab.js`). It is
  hidden in the Runs view, where rows are scans and carry no change flag.
- **Click a row** (Files/Folders only; Runs rows are not clickable) to open
  `HashDetail`, listing every hash newest-first with its date.

Below the grid, `ExecutionPlanPanel` turns the paths whose hash changed into an
ordered list of agents to run: phase 1 are the agents whose outputs overlap a
changed path, phase 2 the downstream closure, sorted by phase then code. Each
step has a `done` flag the user can tick; the plan is user-authored state in
`data/execution-plan.json` and is never committed.

### Link Changes to Agent

First consumer of the Settings values. Runs `git status --porcelain -z
--untracked-files=all` at the git root, keeps entries inside the workspace
folder, and skips deleted/unmerged paths and non-files. Rows carry the path
relative to the **git root** (what gets stored), status, workspace-relative path
and size. Checkboxes with *Select all* / *Select none*; a dropdown lists agents
as `CODE - Name`; the button appends the selected paths to that agent's
`result_generated_files`, skipping paths already listed.

**Record execution** uses the same selection and the same agent picker: it posts
`{agent, paths}` to `POST /api/executions`, which reads the inputs from that
agent's saved `source_dependant_files`, refuses anything untracked or dirty, and
writes one receipt file. The button never runs `git commit`; on success the
banner names `data/executions/<id>.json` and the staged paths that must ride the
same commit. A `409` means the outputs are already published for these inputs -
shown with the per-path reason from `err.body.errors`.

### Executions

A grid over `data/executions/`, newest first, one row per receipt: when it was
recorded, which agent, how many inputs and outputs, and a status badge computed
against git - `valid`, `inputs changed`, `diverged` or `unknown`. The status
comes from `GET /api/executions`; the tab only displays it. With no workspace
configured the statuses cannot be checked and the tab says so.

### Settings

Three blocks. Two of them configure the workspace, one of them configures the app.

**Workspace folder** and **workspace git root location** - configured as a pair,
validated in `server/settingsValidation.js`:

- both empty: allowed
- only one set: refused, naming the missing field
- git root must be a folder containing `.git` (a directory **or** a file, as in
  a worktree or submodule checkout)
- workspace folder must be the git root itself or a folder inside it

The patch is merged with what is stored *before* validation, so saving one
field is checked against the other. Saves happen on blur, Enter, picker
selection or *Save*; *Clear both* empties the pair.

Every successful save bumps `store.settings.revision`, and `LinkChangesTab`
watches that counter to re-run `git status`. Tabs are mounted once and toggled
with `v-show`, so a folder change refreshes the dependent tab even while the
user is on another one. Follow that pattern for any view derived from settings.

**Data folder** - where the app keeps its JSON files, defaulting to
`<repo>/data`. Saving it calls `reloadAll()` in `src/store.js`, which drops the
client caches, re-reads agents / schema / hashes / state / settings and bumps
both `store.revision` and `store.settings.revision`, so every open tab shows the
new folder. `HashingTab` watches `store.revision` to pick up the remembered
folder from the new `state.json`. A loader that fails during the reload is
reported in the banner rather than silently leaving the previous folder's rows
on screen.

## 8. Conventions worth keeping

- **Atomic writes everywhere.** `store.writeJsonFile` writes `<file>.<pid>.tmp`
  then renames. Any new persistent file must go through it.
- **Tolerant reads for the small state files.** Use `createStateFile({ file,
  defaults, sanitise })` so a hand-edited or truncated file cannot break a tab.
- **Validate against the schema, never trust the client.** Both the agents CRUD
  and the link endpoint run `checkAgent` before writing.
- **Codes become paths.** Validate the pattern in `agentsStore.assertValidCode`
  before joining; this is the only thing standing between the URL and the disk.
- **Paths in agent files are relative to the git root.** The link endpoint
  rejects absolute paths and `..` segments.
- **Loopback guard.** When `--host` is loopback, `server.js` rejects foreign
  `Host` and `Origin` headers so a web page cannot reach the app through DNS
  rebinding. Keep it if routing is touched.
- **Vue components** are Options API objects with `setup()` returning refs and
  `template` as a template string. Column definitions are plain objects
  (`{ key, label, value, text, title, sortable, className }`); `value` feeds
  sorting, `text` the cell, `title` the tooltip, and a `#cell-<key>` slot
  overrides a cell when buttons or checkboxes are needed.
- **Shared state** lives in `src/store.js` as one `reactive()` object. Tabs keep
  local-only state (selection, folder typing) as refs inside `setup()`.

## 9. History: why things are the way they are

| Decision | Reason |
| --- | --- |
| Express over a hand-rolled http server | routing, JSON body parsing, static files out of the box |
| Ajv 2020-12 | the schema already declares draft 2020-12 and uses `format: date-time` |
| No bundler | avoids a build step; edit a file, refresh the browser |
| One file per agent | parallel edits cannot clobber each other; each record diffs alone |
| Sorted by code | filesystem order is not stable |
| Server-side validation | single source of truth; browser stays thin |
| NDJSON for hashing | progress must arrive while the server is still working |
| Delta run files | two users hashing at the same time used to collide on one shared document, and a merge could reorder a history so a stale hash looked current. Separate immutable files merge cleanly, and "current" is computed, never stored |
| Identity checked on read | a file whose code disagrees with its name cannot be addressed without duplicating the record; reporting it beats showing a row that writes to the wrong file |
| Dedupe identical hashes | repeated scans of unchanged trees otherwise fill the store with noise |
| Execution receipts as immutable files, not one current-state document | a single mutable "which outputs are current" file would be a merge hotspot - the same problem delta run files already solved; one file per recording merges cleanly |
| Receipts written from the git index, not the worktree | the receipt has to describe what the commit will contain; a dirty worktree would record bytes no teammate ever receives |
| Republishing the same outputs for unchanged inputs is refused | a hand-edited output must not be published as a new run; only changed inputs make a new execution |
| `executions` timestamps dropped from the agent record | an array of runs inside the shared agent JSON was a merge hotspot and could not say who ran what; one receipt file per run carries the fact and merges cleanly |
| Receipts tracked while hash runs are ignored | a receipt holds only git-relative paths and hashes, so publishing it is safe and is the point; a run file holds absolute local paths |
| `npm run doctor` reuses server modules | a second implementation of the checks could disagree with the code it checks |
| Shared `stateFile` / `agentsValidation` | two callers, one implementation |
| Settings separate from state | `state.json` is what the app remembers *about* a session; `settings.json` is what a human configured |
| Tests use `node:test` | it ships with Node, so the suite adds no dependency to install or audit |

## 10. Known gaps

- Folder hashes sort children with `localeCompare`, which is ICU-dependent. Two
  machines with different locales can order differently and therefore compute
  different folder hashes for an identical tree. Making it byte-stable would
  invalidate every recorded folder hash once; the doctor flags the mismatch, but
  the fix has not been taken up.
- Linked files stay in the Link Changes list after linking - they are still
  uncommitted. Intended, not a bug, but easy to mistake for one.
- Hash run files accumulate forever. There is no retention policy or compaction;
  a busy workspace that hashes daily will grow a file per run.
- The suite covers the server, the pure client helpers and the merge behaviour.
  The Vue components themselves are still verified by hand in a browser; there is
  no DOM test.
- `--root` is a CLI flag only; the workspace git root is not enforced as a jail.
- The doctor and the test suite both serialise on `data-location.json`, which
  lives in the repository root. `npm test` therefore runs with
  `--test-concurrency=1`.

## 11. Where to add things

| Task | Touch |
| --- | --- |
| new agent field | `data/agents.schema.json` only - the form is schema-driven |
| new setting | `settingsStore.DEFAULTS` + `sanitise`, optional rule in `settingsValidation.js`, then `SettingsTab` |
| new hash view | a column set and a branch in `HashingTab.rows` |
| new grid | reuse `DataTable` with a `#cell-<key>` slot |
| new API route | a `Router` in `webapp/server/`, mounted in `server.js`, wrapper in `src/api.js` |
| new persisted file | add to `config.files`, read via `store.js`, write atomically |
| new integrity check | `webapp/tools/doctor.js`; reuse the server module so the check cannot drift, and list it in the README |
| change behaviour | add a test to the matching `test/*.test.js` first, see *Testing* below |

## 12. Testing

`npm test` runs `node --test` over `test/*.test.js` - no test framework to
install, and the runner is already there with Node.

**Where the data comes from.** Every test that reads or writes data calls
`useDataFolder()` from `test/helpers.js`, which creates a temp folder, copies the
schema in, and points `config.dataDir` at it. Nothing in the suite can reach
`data/`. The repo-level `data-location.json` is the one shared file a test can
touch, so it is removed before and after each such test, and the suite asserts it
was not left behind - which is also why `--test-concurrency=1`.

**How the HTTP tests work.** `server.js` exports `createApp()` and only calls
`listen()` when it is the program being run, so a test can mount the real app on
an ephemeral port and talk to it with `fetch`. The loopback Host guard needs a
`Host` header `fetch` will not send, so that one test uses raw `node:http`.

**How git tests work.** `test/merge.test.js` builds two real clones in temp
folders, with this project's `.gitignore`, hashes a tree from each side through
the real store, and runs a real `git merge`. `test/executions.test.js` does the
same for receipts: it makes a real repository (with its own `data/`), stages and
commits inputs, records executions over HTTP, and merges two clones to prove the
receipt files survive additively.

**The rule for a failing test.** A test states the expected result. If it fails,
either the expectation was wrong - in which case the expectation is rewritten to
match the documented behaviour, and the documentation is what is wrong first - or
the code is wrong, and the code gets fixed. A test is never relaxed to accept a
behaviour nobody intended. Three real bugs were found this way while the suite was
written: the root folder hash being rolled up before its children existed,
`latestHash()` reading a newest-first history from the wrong end, and one
unreadable run file failing the entire hash store.