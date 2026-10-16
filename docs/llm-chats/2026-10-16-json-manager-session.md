# Session: json-manager, agents + hashing + merge safety

- **When:** 2026-10-16 → 2026-10-17
- **Repo:** `json-manager` (published as `json4agents-manager`)
- **Commits covered:** `74efb77` → `2fcd405`
- **Why this file exists:** an agent picking this project up should know what was
  decided, what was measured, and which failures were already paid for - without
  reading the whole history.

---

## 1. What was asked for, in order

1. A local Node/Express web app: grid of agent records from `agents.json` +
   `agents.schema.json`, add/edit/delete with an edit popup.
2. A second tab: folder path box + browse, hash a folder into `hashes.json`, a
   single progress line showing the last file hashed, and a grid of the results.
3. Restructure: one JSON file per agent under `data/agents/`; delete the
   collection file.
4. Hashing behaviour: click a row → popup of its hashes newest first; yellow dot
   for changed rows; an identical hash is never stored twice.
5. `state.json` remembers the last hashed folder; `settings.json` holds settings;
   saving settings refreshes the Link Changes tab; a new "Data folder" setting
   reloads every tab.
6. A new tab "Link Changes to Agent": uncommitted git files in the workspace
   folder, checkbox selection, select all/none, agent dropdown, button writing
   into `result_generated_files` relative to the git root. Workspace/git-root
   pair validation.
7. `docs/*.md` dev guide, LLM friendly; commit locally, never push.
8. Analysis of the hard-to-merge problems in the data files, with options.
9. Option 1 implemented: per-run immutable files.
10. Agent identity enforcement + a `doctor` command.
11. A test suite built from everything learned, with the bugs found avoided.
12. Prepare for GitHub publication: no local folder information published.

## 2. Decisions and why

| Decision | Reason |
| --- | --- |
| Express 5 + Vue 3 through an import map, no build step | edit a file, refresh the browser; nothing to install or bundle |
| Ajv 8 + ajv-formats, draft 2020-12 | the existing schema already declared 2020-12 and used `format: date-time` |
| `node:crypto` for SHA-256 | no dependency for something the platform does better |
| Grid order = agent code, not filesystem order | filesystem order is not stable and differs between machines |
| File name **is** the agent code, enforced on read | see §5, bug 1 |
| One immutable file per hash run, derived index | see §4 |
| Identical hashes never stored twice | "3 hashes" then means the content changed three times |
| `state.json` / `settings.json` / `data-location.json` / hash runs git ignored | they contain machine-specific absolute paths |
| Test suite on `node:test` | the runner ships with Node; nothing new to install or audit |

## 3. Measured facts that shaped the design

These came out of actually running git and the app, not from reasoning:

- The old single `hashes.json` was 1.1 MB / 33 867 lines / 1 697 files /
  738 folders / 4 runs.
- **Two users, two files each, `git merge`: 3 conflict hunks** - including a
  conflict between entries for *different* files that merely sat next to each
  other in the sorted array.
- After a union merge the app's "current hash" was whatever sat **last in the
  array**, not the newest: a stale hash shown as current with a yellow dot, and
  no error anywhere.
- 1 696 files already carried **duplicate identical hashes** (an artefact of the
  old writer, before the dedupe rule).
- 2 of the 4 runs had no `changed` / `unchanged` counters at all - format drift.
- Entry order was ICU-collation based; 1 450 of 4 000 positions differed from a
  byte sort, so folder hash *values* were locale dependent (still open, §7).
- Re-hashing the same tree reproduced all 311 legacy folder hashes byte for
  byte, which is how the rollup algorithm was pinned down.
- 20 000 files / 79 MB hashed in ~4.5 s.
- After cancelling mid-run: 0 % CPU and `hashes.json`'s md5 unchanged.

## 4. The hash store, before and after

**Before** - one document, rewritten in full by every run:

```jsonc
{ "sourceFolder": "…", "generated": "…",
  "runs": [ … ],
  "files":   [{ "path", "size", "mtime", "hashes": [{ "datetime", "hash" }] }],
  "folders": [{ "path", "hashes": [{ "datetime", "hash" }] }] }
```

Every run appended to and re-sorted the same file, so any two people collided,
and "current" was positional.

**After** - one immutable file per run, plus a cache that is never committed:

```
data/hashes/runs/<finishedAt>_<random>.json   written once, never edited
data/hashes/index.json                        derived, git ignored, rebuilt
```

A run file is a **delta**: only the paths whose hash changed. Effects measured
here: a run over an unchanged tree writes a **345 byte** file instead of
rewriting 1.1 MB; the four existing runs came to 540 KB; the 1 696 legacy
duplicate histories disappeared, because the delta rule is applied oldest-first
when converting.

Current state is **computed, never stored**: `rebuildIndex()` walks the run files
newest first and assembles each path's history. That is the whole point - the
ordering is a property of the data, not of a file layout, so an interleaved
merge cannot corrupt it.

Replaying the original scenario against the new store: two clones, one run file
each, `git merge` → **zero conflicts**, and "newest by timestamp == shown as
current" held for every path both machines touched.

The API kept its old flat shape, assembled from the run files on read, so **not
one browser component had to change** for the storage rewrite. The one component
that did change was wrong in the other direction - see §5, bug 2.

Migration (`migrateLegacyHashes`, once, at startup): entries are attributed to the
run that stamped them, the delta rule is applied oldest first, every legacy run
is kept even when it changed nothing (so the Runs view still shows the scan), and
the original file is preserved as `hashes.migrated.json`.

## 5. Bugs the work found

Recorded because each one was silent - valid JSON, no error, wrong answer.

1. **Impostor agent files.** `agents/AG-777.json` containing `"code": "AG-001"`
   loaded as a valid record and produced two AG-001 rows, both of which wrote to
   the same file. Fixed by `scanAgents()`: a file is kept only when its name stem
   equals its `code`; the rest are reported as issues through the existing
   `GET /api/agents` error channel, so the grid's error badge showed them with no
   client change. Codes colliding when case is folded are reported too (two files
   on Linux, one on macOS/Windows).
2. **Stale hash as current, on the read side.** After the storage rewrite the
   server sent histories newest first, but `latestHash()` still took the **last**
   element and `HashDetail` reversed a list that was already ordered. The popup
   labelled the *oldest* hash "latest" and the yellow dot compared the two oldest
   - reintroducing the exact failure the rewrite existed to remove. Caught by
   writing `latestHash`'s test as "the newest hash is the **first** element", and
   confirmed in the browser: a history ending 21:04:31 was labelled 20:55:13.
3. **Root folder hash rolled up before its children existed.** Depth was
   `''.split('/').length`, which is `1` for the root *and* `1` for its direct
   children, so the stable sort left the root first and every child hash entered
   the digest as the string `undefined`. The root hash then depended only on the
   names and **never changed again**. Caught by the test "notices a changed file
   in that file and in its ancestors only".
4. **One unreadable run file 500'd the store.** `readAllRuns()` let a JSON parse
   error escape, so a single damaged file made `GET /api/hashes` fail and the tab
   unusable. Damaged runs are skipped; `readBrokenRunFiles()` lets the doctor
   report them.
5. **A rejected schema stayed rejected forever.** A failing Ajv compile used to be
   cached as a failure, so fixing the file needed a restart. Now the cache is
   cleared on failure - and there is a test for it.
6. **`--root` made the folder browser a one-way trip.** `parentOf()` refused the
   jail as a parent, so browsing into `<root>/sub` offered no way back up.
7. **A test helper re-initialised the repository.** `git init` ran without
   `cwd`. It was idempotent and the repo was verified intact, but it is exactly
   the hazard the docs warn about, so the helper now asserts the repository it
   created.

Also fixed along the way: "Use default" wrongly disabled, a stale error banner,
duplicate "Select none" buttons, an empty SHA-256 column.

## 6. The test suite

`npm test` → 235 tests, `node:test` only, ~16 s. Rules that made it useful:

- Every test that touches data gets its own temp folder (`useDataFolder()`), so
  nothing can reach `data/`. The suite also asserts it left no
  `data-location.json` behind.
- `server.js` exports `createApp()` and only calls `listen()` when it is the
  program being run, so tests mount the real app on an ephemeral port.
- `merge.test.js` builds two **real** clones with this project's `.gitignore`,
  hashes from each side through the real store and runs a **real** `git merge`.
  That is how "the derived index must never be committed" stopped being an
  assumption and became an assertion - when the `.gitignore` line is missing, the
  test fails with a conflict in `index.json`.
- A test states the expected result first. When one failed, either the
  expectation was wrong (then the *documented* behaviour decides, not the code's
  current output) or the code was wrong (then the code was fixed). A test was
  never relaxed to accept behaviour nobody intended. Bugs 2, 3 and 4 above were
  found this way.

## 7. Open items

- **Folder hashes are locale dependent.** Children are sorted with
  `localeCompare`, so two machines with different ICU data can compute different
  folder hashes for an identical tree. Making it byte-stable invalidates every
  recorded folder hash once. The doctor flags the mismatch; the fix has not been
  taken up.
- **No retention policy.** Run files accumulate; a workspace hashing daily grows
  a file per run.
- **The Vue components have no DOM test.** They are still verified by hand in a
  browser; `format.js` is covered because it is pure.
- **`--root` is CLI only.** The workspace git root is not enforced as a jail.
- **The suite serialises** (`--test-concurrency=1`) because `data-location.json`
  lives in the repository root and two test files touching it race.
- **`docs/llm-chats/` is a growing folder.** Each session gets one file, named
  for its date, written the same way as this one.

## 8. Publication

This repository is published, so anything that identifies the machine or the
people's folder layouts was removed before the first push. Concretely:

- **Hash run files** - every one of them recorded the absolute path of the folder
  that had been hashed, plus the path of each of the 1 697 files inside it,
  including three personal project names and their `.git` internals. They are now
  git ignored, and `data/hashes/README.md` explains the opt-in for a team that
  does want one shared store in git. A test asserts a fresh clone stages no run
  file, so this cannot regress by accident.
- **The pre-migration backup** of the old single-file store, which held the same
  paths, was deleted from the working tree (kept outside the repository).
- **The one machine-specific line in the docs** - a Node `PATH` export naming the
  developer's home directory - replaced with "Node 22 or newer must be on
  `PATH`".

Kept, because it is what makes the repository useful as a starting point: the
schema, three example agent records whose paths are all relative, and the app
itself. `data/state.json` and `data/settings.json` stay local and ignored - note
that `state.json` is exactly the file that remembers the last hashed folder, so it
is worth remembering what it holds before pushing anything.

The general rule this established: **before the first push, grep the tracked
tree for the absolute paths you type most often.** A hash store, a settings file
and a log line are the three places they hide.