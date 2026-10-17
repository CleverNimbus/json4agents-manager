# Execution receipts

An execution receipt is the shared record that an agent was run over a given set
of inputs and produced a given set of outputs. It is how a team avoids paying for
the same generation twice: before running an agent, look for a receipt whose
inputs match what is already committed.

Every recorded execution writes exactly one immutable file here, named after the
time it was recorded:

```
data/executions/2026-10-17T09-12-44-010Z_7f3a91cc.json
```

A receipt holds only paths and hashes - never the generated content, never an
absolute path, never the machine name:

```jsonc
{
  "id": "2026-10-17T09-12-44-010Z_7f3a91cc",
  "agent": "AG-001",
  "recordedAt": "2026-10-17T09:12:44.010Z",
  "inputs":  [{ "path": "config/root.json", "blob": "…40 hex…", "sha256": "…64 hex…" }],
  "outputs": [{ "path": "out/root-report.md", "blob": "…40 hex…", "sha256": "…64 hex…" }]
}
```

`blob` is the git object id of the content in the index, `sha256` the SHA-256 of
the same bytes. `inputs` is the agent's `source_dependant_files`; `outputs` is
the selection that was recorded.

## These files are tracked

Unlike `data/hashes/runs/`, receipts **are** committed. They contain no local
information, so they are safe to publish, and the whole point is that a teammate
pulls them. Do not add `data/executions/` to `.gitignore`.

## The rule

- A receipt describes content that is **staged or committed**, not a dirty
  working tree. Recording reads the git index; an unstaged change is refused.
- **Unpushed means nonexistent.** A receipt only helps a teammate once it is in
  git. A local receipt that was never pushed is invisible to everyone else.
- **Republishing the same outputs for unchanged inputs is refused** (`409`). That
  covers a hand-edited output as well: if the bytes changed while the inputs did
  not, the old receipt no longer matches, and the fix is to restore the recorded
  content or change the inputs and re-run the agent. A new receipt is only
  written when the inputs changed.

## Recording one

1. Commit the inputs, or stage them in the same commit as the outputs.
2. Run the agent outside this app.
3. In **Link Changes to Agent**, select the produced files and link them to the
   agent if you have not already.
4. Press **Record execution**. The app refuses anything untracked or dirty.
5. Commit the new receipt file **together with the staged outputs**. The banner
   names the exact paths that belong in that commit.
6. Push. Only now does the execution exist for anyone else.

## Checking

`npm run doctor` reads the receipts and reports a broken file, an unknown agent
code, an absolute path, an output published twice under unchanged inputs, and a
receipt that no longer matches the committed files.
