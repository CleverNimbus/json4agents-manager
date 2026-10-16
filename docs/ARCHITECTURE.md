# JSON Manager - development guide

Everything a new agent needs to continue working on this repository without an
exploratory pass over the code. Written against commit `5992e97` plus the
changes described in the last section.

---

## 1. What this project is

A local, single-user web app for managing two kinds of data on the developer's
own machine:

1. **Agent records** - one JSON file per agent in `data/agents/`, validated
   against a JSON Schema.
2. **Hash history** - SHA-256 hashes of files and folders, kept in
   `data/hashes.json`, used to see what changed since the last run.

The Node server owns all file access. The browser is a pure view: it never asks
for filesystem permissions and works in any current browser. The previous
implementation was a static page using the File System Access API, which
required Chromium and permission prompts; it was removed in `5992e97`.

## 2. Running it

Node must be on `PATH`. On this machine:

```bash
export PATH=/home/sefe/local-sources/00_frameworks/node-v24.15.0-linux-x64/bin:$PATH
# Node 24.18.0, npm 12.2.0
```

```bash
npm install     # 94 packages, no build step
npm start       # http://127.0.0.1:8000
npm run dev     # same with node --watch
```

Server flags (also `PORT` / `HOST` / `JSONM_DATA_DIR` environment variables):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `8000` | listen port |
| `--host` | `127.0.0.1` | interface; the loopback guard is only active for loopback hosts |
| `--data-dir` | `<repo>/data` | where all data files live |
| `--root` | unrestricted | jail: browsing and hashing cannot leave this folder |

**Testing pattern that matters:** never exercise write paths against the real
`data/`. Start a second instance with `--data-dir /tmp/some-copy` and point the
tests at it. Twice in this project's history a test run wrote junk into the real
`data/hashes.json` and into real agent files; recovery was done by restoring a
`cp -r data /tmp/backup` snapshot taken beforehand. Keep taking that snapshot.

## 3. Architecture

```
browser (Vue 3 ESM, no bundler)
   |  fetch JSON
   v
Express 5 server  ->  filesystem (agents/, hashes.json, state.json, settings.json)
   |                     + child_process git (changes tab)
   v
node:crypto (SHA-256), child_process (git status)
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
package.json                  scripts + the four dependencies
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
  agentsStore.js              one JSON file per agent; code<->filename rules
  agentsValidation.js         checkAgent(agent, previousCode) - shared by CRUD and linking
  agentsApi.js                CRUD for agent files, GET /api/schema, POST link-files
  gitChanges.js               git status of the workspace folder
  changesApi.js               GET /api/changes
  fsApi.js                    GET /api/fs (folder browser backend), path jail
  hashRunner.js               tree walk, parallel SHA-256, folder rollups
  hashApi.js                  POST /api/hash (NDJSON stream), GET /api/hashes
  hashesStore.js              merge a run into hashes.json
  stateFile.js                shared read/write helper for the two small state files
  stateStore.js               data/state.json
  stateApi.js                 GET/PUT /api/state
  settingsStore.js            data/settings.json
  settingsValidation.js       workspace + git root rules
  settingsApi.js              GET/PUT /api/settings
webapp/src/
  main.js                     createApp(...).mount('#app')
  api.js                      fetch wrappers; hashFolder() reads the NDJSON stream
  store.js                    all shared reactive state + actions
  format.js                   bytes / duration / time / shortHash / latestHash helpers
  components/
    App.js                    tab strip + banner; mounts the four tabs
    DataTable.js              generic sortable grid with per-column slots
    AgentsTab.js              agent grid + row actions
    AgentModal.js             schema-driven add/edit/delete popup
    HashingTab.js             path box, folder picker, hash grid, progress line
    HashDetail.js             hash history popup (newest first)
    LinkChangesTab.js         uncommitted git files -> agent linking
    FolderPicker.js           in-app folder browser modal
    SettingsTab.js            workspace folder + git root settings
```

## 5. Data files

```
data/
  agents.schema.json    JSON Schema draft 2020-12 - the contract for agent files
  agents/<CODE>.json    one agent per file; the file name IS the code
  hashes.json           file and folder hash history
  state.json            last hashed folder (session memory)      [gitignored]
  settings.json         workspace folder + git root (config)     [gitignored]
```

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

### hashes.json

```jsonc
{
  "sourceFolder": "/abs/path",
  "generated":    "ISO timestamp",
  "runs":    [{ "root", "startedAt", "finishedAt", "durationMs", "files", "bytes", "errors", "changed", "unchanged" }],
  "folders": [{ "path", "hashes": [{ "datetime", "hash" }] }],
  "files":   [{ "path", "size", "mtime", "hashes": [{ "datetime", "hash" }] }]
}
```

Folder hashes roll up bottom-up:

```
folderHash = sha256( concat over children sorted by name of  name + "\0" + childHash + "\u001e" )
```

This is the algorithm the old browser implementation used, verified to
reproduce all 311 folder hashes that shipped in the original file byte for byte.
An empty folder therefore hashes to `e3b0c442…b855` (digest of the empty
string).

**Identical hashes are never stored twice.** `hashesStore.appendHash` compares
against the entry's last stored hash and skips the write when they match, so
"3 hashes" means the content changed three times, not that the folder was
scanned three times. `files[].size` and `mtime` always reflect the most recent
observation even when content is unchanged.

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
| `GET /api/fs?path=` | one directory listing for the folder browser |
| `POST /api/hash` | NDJSON progress stream, see below |
| `GET /api/hashes` | current hashes.json |
| `GET`/`PUT /api/state` | session memory (last hashed folder) |
| `GET`/`PUT /api/settings` | workspace folder + git root |

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
`AbortController` and the hashing loop stops without touching `hashes.json`.
Verified: after abort the process drops to 0% CPU and the file's md5 is
unchanged.

## 7. The four tabs

### Agents

Grid, one row per agent, sorted by code. Add / edit / delete write the single
file each. The edit popup is generated from `agents.schema.json` - fields, types
(required markers, hints, `string[]` editors) all follow the schema, so
changing the schema changes the form. Required-field checks run client-side for
instant feedback; the authoritative validation is server-side, and its error list
is displayed in the popup with nothing written.

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

### Link Changes to Agent

First consumer of the Settings values. Runs `git status --porcelain -z
--untracked-files=all` at the git root, keeps entries inside the workspace
folder, and skips deleted/unmerged paths and non-files. Rows carry the path
relative to the **git root** (what gets stored), status, workspace-relative path
and size. Checkboxes with *Select all* / *Select none*; a dropdown lists agents
as `CODE - Name`; the button appends the selected paths to that agent's
`result_generated_files`, skipping paths already listed.

### Settings

Two fields configured as a pair - **workspace folder** and **workspace git root
location** - validated in `server/settingsValidation.js`:

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
| Dedupe identical hashes | repeated scans of unchanged trees otherwise fill the file with noise |
| Shared `stateFile` / `agentsValidation` | two callers, one implementation |
| Settings separate from state | `state.json` is what the app remembers *about* a session; `settings.json` is what a human configured |

## 10. Known gaps

- `data/hashes.json` is tracked and grows on every run; each hash run makes a
  large diff. Gitignoring it was offered and never taken up.
- Linked files stay in the Link Changes list after linking - they are still
  uncommitted. Intended, not a bug, but easy to mistake for one.
- Pre-existing duplicate hashes from before the dedupe rule was added (rows with
  two identical stored hashes) remain in `data/hashes.json`; they show no yellow
  dot. A one-off cleanup was offered and never taken up.
- No automated test suite. Everything is verified by hand with curl plus a real
  browser; keep that up for new features.
- `--root` is a CLI flag only; the workspace git root is not enforced as a jail.

## 11. Where to add things

| Task | Touch |
| --- | --- |
| new agent field | `data/agents.schema.json` only - the form is schema-driven |
| new setting | `settingsStore.DEFAULTS` + `sanitise`, optional rule in `settingsValidation.js`, then `SettingsTab` |
| new hash view | a column set and a branch in `HashingTab.rows` |
| new grid | reuse `DataTable` with a `#cell-<key>` slot |
| new API route | a `Router` in `webapp/server/`, mounted in `server.js`, wrapper in `src/api.js` |
| new persisted file | add to `config.files`, read via `store.js`, write atomically |