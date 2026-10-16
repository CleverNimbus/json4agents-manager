# JSON Manager

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
| `--data-dir /path` | where the data directory lives | `<repo>/data` |
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
  hashes.json           hash results
  state.json            UI state, e.g. the last folder used in the hashing tab
```

Writes go through a temporary file plus `rename()`, so an interrupted write can
never truncate a file.

`state.json` is machine specific, so it is git ignored. It is also optional: a
missing, empty or malformed one falls back to the defaults instead of breaking
the app.

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
- **Click a file or folder row** to open its hash history: every recorded hash
  with the date it was hashed, newest first, the newest one badged *latest*.
- **Rows in the Runs view are not clickable** - a run is a scan of a folder, not
  a file, so it has no hash history.
- **Identical hashes are not stored twice.** Re-hashing an unchanged tree leaves
  the history alone, so "3 hashes" means the content really changed three times
  rather than "scanned three times". The run itself is always recorded, with
  how many entries changed and how many were unchanged.
- **The folder is remembered.** Picking a folder, hashing it, or leaving a path
  in the text box stores it in `data/state.json`, and the next visit starts with
  it in the box. An interrupted hash run wins over the stored value, so a reload
  mid-run does not lose the target.

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

## hashes.json format

A superset of the file the old app produced, so an existing file loads as is:

```jsonc
{
  "sourceFolder": "/home/you/projects/thing",
  "generated": "2026-10-16T19:44:07.482Z",
  "runs":    [{ "root": "…", "startedAt": "…", "finishedAt": "…", "durationMs": 524, "files": 990, "bytes": 4190372, "errors": 0, "changed": 12, "unchanged": 1349 }],
  "folders": [{ "path": "src/lib", "hashes": [{ "datetime": "…", "hash": "…" }] }],
  "files":   [{ "path": "src/lib/main.js", "size": 2048, "mtime": "…", "hashes": [{ "datetime": "…", "hash": "…" }] }]
}
```

Re-hashing a path **appends** a timestamped hash to the existing entry, but only
when the hash actually changed - an unchanged hash is dropped, which keeps the
history meaningful. `files[].size` and `mtime` always describe the most recent
observation, even when the content did not change.

## API

| Method + path | Purpose |
| --- | --- |
| `GET /api/agents` | every record from `data/agents/`, sorted by code, plus its validation result |
| `GET /api/agents/:code` | one record |
| `POST /api/agents` | create `data/agents/<code>.json` (`409` if the code exists) |
| `PUT /api/agents/:code` | update that file; renames it when the code changed |
| `DELETE /api/agents/:code` | remove the file |
| `GET /api/schema` | the JSON Schema, used to build the edit form |
| `GET /api/hashes` | current `hashes.json` |
| `GET /api/state` | `state.json` (e.g. the last hashed folder) |
| `PUT /api/state` | merge a patch into `state.json` |
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
  agentsApi.js                CRUD for the agent files, GET /api/schema
  stateStore.js               data/state.json, tolerant of a broken file
  stateApi.js                 GET/PUT /api/state
  fsApi.js                    GET /api/fs, path resolution and root jail
  hashRunner.js               walk, parallel SHA-256, folder rollups
  hashApi.js                  POST /api/hash progress stream, GET /api/hashes
  hashesStore.js              merge a run into hashes.json
webapp/index.html             import map: "vue" -> /vendor/vue.esm-browser.prod.js
webapp/styles.css
webapp/src/                   browser app (no build step)
  main.js  api.js  store.js  format.js
  components/  App  AgentsTab  AgentModal  HashingTab  HashDetail
                FolderPicker  DataTable
```

## Dependencies

All MIT and actively maintained: [express](https://expressjs.com) 5.x (HTTP
server), [vue](https://vuejs.org) 3.5 (UI, served from `node_modules`, no
bundler), [ajv](https://ajv.js.org) 8.x + ajv-formats (schema validation).
Hashing uses `node:crypto`, so there is no hashing dependency.

Requires Node 22 or newer (developed against Node 24).