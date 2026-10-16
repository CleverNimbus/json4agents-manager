# json4agents-manager

Local web app for viewing and editing the agent records in `data/agents/` and
for hashing folders into `data/hashes.json`. Node does all the work on this
machine: the server reads and writes the JSON files directly and hashes files
with `node:crypto`. The browser is only the UI - it needs no file system
permissions of its own and works in any current browser.

## Run

```bash
npm install
npm start                 # http://127.0.0.1:8000
```

Options (also available as `PORT` / `JSONM_DATA_DIR` / `HOST`):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--port 9000` | port to listen on | `8000` |
| `--host 0.0.0.0` | interface to bind | `127.0.0.1` |
| `--data-dir /path` | see *Data folder* below | `<repo>/data` |
| `--root ~/projects` | jail: browsing and hashing stop at this folder | unrestricted |

`npm run dev` does the same with `node --watch`, so the server restarts when a
file in `server/` changes.

## Data layout

`webapp/` holds only code; everything the app persists lives in `data/`:

```
data/
  agents.schema.json    JSON Schema (draft 2020-12) every write is validated against
  agents/
    AG-001.json         one file per agent record - the file name is the agent code
    AG-002.json
    AG-003.json
  hashes/
    runs/*.json         one immutable file per hash run
    index.json          derived cache (git ignored, rebuildable)
  state.json            UI state, e.g. the last folder used in the hashing tab
  settings.json         settings chosen in the Settings tab
```

Writes go through a temporary file plus `rename()`, so an interrupted write can
never truncate a file.

`state.json` and `settings.json` are machine specific, so they are git ignored.
Both are also optional: a missing, empty or malformed one falls back to the
defaults instead of breaking the app.

### The agent store

- **One file per agent.** `data/agents/<code>.json` holds exactly that agent
  object. No file holds the collection, so two agents can never overwrite each
  other and a single record can be edited, diffed or version controlled alone.
- **The code is the file name.** Codes are checked against
  `[A-Za-z0-9][A-Za-z0-9._-]*` before they become a path, so a code can never
  escape the folder. Changing a code in the edit popup renames the file.
- **Grid order is code order.** Files are read in any order and sorted by agent
  code, so the grid never depends on the filesystem.
- **A broken file is reported, not hidden.** A file that cannot be parsed, or
  that does not match the schema, shows up as an error badge next to the grid
  instead of silently disappearing.
- An existing code returns `409`. Every write is validated against the schema
  twice: once for the record (`$defs/agent`) and once for the collection it
  would belong to.

## Tabs

**Agents** - grid with one row per agent, ordered by code. Add, edit and delete
write the matching file in `data/agents/` straight away. `+ Add agent` and the
row *Edit* button both open the edit popup; the form is generated from
`agents.schema.json`, so fields, types and required markers follow the schema.
Saving posts the record to the server, which validates it and writes
`data/agents/<code>.json`; a rejected record shows the list of errors in the
popup and nothing is written. Editing the code renames the file.

**Hashing** - text box with a folder path plus an *Explore* button that opens an
in-app folder browser (no native dialog, no browser permission prompt). *Hash
folder* walks the tree, streams progress and writes the result into
`hashes.json`. One line under the toolbar always shows the state, including the
last file that was hashed, so a long run is visibly moving:

```
Hashing 118/990 files · 727 KB · last: noiselabyrinth_shared/.dart_tool/…/vs_code.json
```

*Cancel* aborts the run: the server stops hashing and `hashes.json` is left
untouched. Below the toolbar the same file can be viewed as **Files**,
**Folders** or **Runs**, sortable and filterable.

### Reading the hash grids

- **Yellow dot** - the row's newest hash differs from the one recorded before
  it. Click a row to see the history behind it.
- **`● N changed` is a switch** - click it to hide unchanged rows and leave only
  the yellow-dotted ones, click again to show everything. The `N rows` badge
  follows. The switch is hidden in the Runs view, where rows are scans rather
  than files and carry no change flag.
- **Click a file or folder row** to open its hash history: every recorded hash
  with the date it was hashed, newest first, the newest one badged *latest*.
- **Rows in the Runs view are not clickable** - a run is a scan of a folder, not
  a file, so it has no hash history.
- **Identical hashes are not stored twice.** Re-hashing an unchanged tree leaves
  the history alone, so "3 hashes" means the content really changed three times
  rather than "scanned three times". The run itself is always recorded as a run
  file - even an empty one, so the Runs view still shows that the scan happened.
- **The folder is remembered.** Picking a folder, hashing it, or leaving a path
  in the text box stores it in `data/state.json`, and the next visit starts with
  it in the box. An interrupted hash run wins over the stored value, so a reload
  mid-run does not lose the target.

**Settings** - configuration that outlives a session, kept in
`data/settings.json`:

- **Workspace folder** - the folder this workspace works in.
- **Workspace git root location** - the git repository the workspace belongs to.

Both are stored in `data/settings.json`. The *Link Changes to Agent* tab reads
them, and they are only accepted as a valid pair:

- both empty - nothing configured, allowed
- only one filled in - refused; the two are configured together
- the git root must be a folder containing a git repository (`.git`, either a
  folder or a file as in a worktree checkout)
- the workspace folder must be that git root itself or a folder inside it

The rules live in `server/settingsValidation.js` and are enforced on save; the
field that caused the refusal is highlighted in the tab. Pick a folder with
*Browse…*; changes are saved when you leave a box, press Enter or press *Save*,
and *Clear both* empties the pair. Saving either field refreshes the
*Link Changes to Agent* tab immediately, since its file list depends on both.

- **Data folder** - where the app keeps its JSON files. Empty means
  `<repo>/data`. A folder that does not exist yet is created, and a missing
  `agents.schema.json` is copied over from the current folder so the new one can
  validate anything. Changing it reloads every tab, so the other tabs show the
  new folder's agents, hashes and state at once.
  The value cannot live inside the data folder - moving the folder would move
  the setting that points at it - so it is remembered in `data-location.json`
  next to `package.json` (git ignored). Startup precedence is
  `--data-dir` / `JSONM_DATA_DIR` > this setting > `<repo>/data`; when the flag
  is used the setting shows as *locked* and refuses to change.

**Link Changes to Agent** - the files git still reports as changed inside the
workspace folder, linked to an agent in one click. This tab is the first
consumer of the two settings above.

- Reads `git status --porcelain --untracked-files=all` at the workspace git
  root. Modified, staged, added, renamed and untracked files are listed;
  deleted and unmerged paths are skipped, as is anything outside the workspace
  folder.
- The grid shows the path **relative to the git root** (what actually gets
  stored), the git status, the path relative to the workspace folder and the
  size. Each row has a checkbox, with *Select all* and *Select none* always
  available and an `N changed / N selected` badge.
- Pick an agent from the dropdown (`CODE - Name`, read from the agent store)
  and press **Link changes to agent**. Every checked file is appended to that
  agent's `result_generated_files`, skipping paths already listed; the agent is
  validated and written exactly like an edit from the agents tab.
- Paths must be relative to the git root - absolute paths and `..` segments are
  rejected. Linked files stay in the list, because they are still uncommitted;
  commit them and they disappear on the next refresh.
- Without a workspace configured the tab explains what to set instead of
  showing an empty grid.

## Hashing details

- SHA-256, streamed per file, 8 files in parallel. Throughput on this machine:
  ~20 000 files / 79 MB in ~4.5 s.
- Hidden files are included by default (tick *hidden* off to skip them).
  Symlinks are skipped unless *follow symlinks* is ticked, which also prevents
  symlink loops.
- Folder hashes are rolled up bottom up: the hash of a folder is the SHA-256 of
  `name \0 childHash \u001e` for each of its children (folders and files, sorted
  by name). This is the same algorithm the previous browser-only version used,
  so the 311 folder hashes already in `hashes.json` are reproduced exactly by
  this server, and an empty folder still hashes to
  `e3b0c442…b855` (the digest of an empty string).
- Hashing the folder that contains `hashes.json` is self-referential - the file
  is written after the walk, so its own hash describes the pre-write content.
  Hash something outside `webapp/` if that matters.

## Hash storage: one immutable file per run

```
data/hashes/runs/2026-10-16T19-04-31-469Z_e6962ad2.json
```

```jsonc
{
  "id": "2026-10-16T19-04-31-469Z_e6962ad2",  // finishedAt + random suffix
  "host": "laptop",                          // which machine hashed
  "root": "/home/you/projects/thing",
  "startedAt": "…", "finishedAt": "…", "durationMs": 524,
  "stats": { "files": 990, "bytes": 4190372, "errors": 0, "changed": 3, "unchanged": 2425 },
  "files":   [{ "path": "src/lib/main.js", "size": 2048, "mtime": "…", "hash": "…" }],
  "folders": [{ "path": "src/lib", "hash": "…" }]
}
```

A run file is **written once and never edited**. It records only the paths whose
hash *changed*, so a run over an unchanged tree produces a tiny file, and two
people who hashed at the same time produce two files that git merges without a
conflict.

`data/hashes/index.json` is derived from the run files, is git ignored, and is
rebuilt automatically whenever a run file appears or changes.

Current state is **computed, never stored**: a path's history is assembled from
every run file, newest first. That is what makes the store safe to share - with a
single shared `hashes.json` two users hashing anything collided on the same
sorted document, and a merge could reorder a history so the grid showed a stale
hash as current with no error anywhere.

An old single `hashes.json` is converted once at startup into run files, and the
original is kept as `data/hashes.migrated.json`.

## API

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
| `GET /api/hashes` | hash history assembled from the run files |
| `GET /api/state` | `state.json` (e.g. the last hashed folder) |
| `PUT /api/state` | merge a patch into `state.json` |
| `GET /api/settings` | `settings.json` (workspace folder and git root) |
| `PUT /api/settings` | validate, then merge a patch into `settings.json` |
| `GET /api/data-folder` | the data folder setting and the folder in use |
| `PUT /api/data-folder` | switch data folder, carrying the schema over if needed |
| `GET /api/fs?path=…` | one directory listing for the folder browser |
| `POST /api/hash` | `{path, includeHidden, followSymlinks}` → newline delimited JSON progress stream |

## Layout

```
package.json                  npm scripts and the four dependencies
data/                         everything the app persists (see above)
webapp/server.js              express app: static files + API
webapp/server/
  config.js                   CLI/env configuration, data paths
  store.js                    read/write JSON, atomic writes
  validate.js                 Ajv 2020-12: record and collection validators
  agentsStore.js              one JSON file per agent in data/agents/
  agentsApi.js                CRUD for the agent files, GET /api/schema,
                              POST /api/agents/:code/link-files
  agentsValidation.js          one agent record + its collection, shared by both
  gitChanges.js               git status of the workspace folder, relative to the git root
  changesApi.js               GET /api/changes
  stateFile.js                shared read/write/atomic-write helper for the two small files
  stateStore.js               data/state.json, tolerant of a broken file
  stateApi.js                 GET/PUT /api/state
  settingsStore.js            data/settings.json, tolerant of a broken file
  settingsValidation.js        workspace/git root rules enforced on save
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
  components/  App  AgentsTab  AgentModal  HashingTab  HashDetail
                LinkChangesTab  FolderPicker  SettingsTab  DataTable
```

## Dependencies

All MIT and actively maintained: [express](https://expressjs.com) 5.x (HTTP
server), [vue](https://vuejs.org) 3.5 (UI, served from `node_modules`, no
bundler), [ajv](https://ajv.js.org) 8.x + ajv-formats (schema validation).
Hashing uses `node:crypto`, so there is no hashing dependency.

Requires Node 22 or newer (developed against Node 24).
