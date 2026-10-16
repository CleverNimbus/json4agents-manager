# JSON Manager (web app)

Local, browser-only web app for editing an agents JSON file. No backend, no
build step, no Node required.

## Stack

- **Vue 3** (MIT, open source) — vendored ESM browser build in
  `src/lib/vue.esm-browser.prod.js`. No npm install, no bundler.
- **File System Access API** — reads and writes a real `.json` file on disk
  from the browser. Chromium only (Chrome / Edge).
- Plain ES modules (JavaScript). TypeScript would require Node/deno to
  compile; none is installed on this machine.

## Run

```bash
./serve.sh          # or: python3 -m http.server 8000
```

Then open <http://localhost:8000> in **Chrome or Edge**.

> Must be served over `http://localhost` (a secure context). Opening
> `index.html` directly via `file://` disables the File System Access API.

## Tabs

- **Display** — agents from `agents.sample.json` shown as a grid. Click a row
  for a detail popup with Edit / Delete. `+ New Agent` adds a row. Add, edit
  and delete are written straight back to the JSON file.
- **Source Hash** — pick a folder (Explore), then hash the content of every
  deepest (leaf) subfolder. Results append to `hashes.json`, written next to
  the open agents JSON file. Same procedure as the agents file: the first run
  asks once for that folder (browser security), the handle is remembered in
  IndexedDB, and afterwards it saves there without any dialog. File name and
  location are fixed — the user never picks them.
- **App Configuration** — placeholder (not implemented yet).

## How file editing works

1. On first run the bundled `agents.sample.json` is shown.
2. Click **Open JSON file…** and pick a `.json` file. The browser asks for
   read/write permission.
3. The file handle is remembered in IndexedDB, so the app reopens the same
   file on the next visit (it will re-request permission).
4. Every add / edit / delete writes the file immediately.

Browsers without the File System Access API (Firefox / Safari) load the
bundled sample and save changes by downloading a file instead.
