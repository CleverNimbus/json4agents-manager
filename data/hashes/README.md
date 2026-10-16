# Hash runs

Every hash run writes exactly one immutable file here, named after the time it
finished:

```
data/hashes/runs/2026-10-16T19-04-31-469Z_a200cd6c.json
```

A run file records the folder it hashed (`root`, an absolute path), the paths of
the files and folders it saw, and their SHA-256 hashes - **absolute local paths
included**. That is why this repository does not track them: a published
repository should never carry somebody's folder layout.

So the files here are git ignored. The app creates this folder on demand; an
empty store is a perfectly good store, and the first run you do fills it.

## If your team shares one store through git

The per-run layout exists so two people can hash at the same time without
colliding: separate files merge cleanly, and "which hash is current" is computed
from them rather than stored. For that to work, the run files have to be in git.

1. Remove the `data/hashes/runs/` line from `.gitignore`.
2. `git add -f data/hashes/runs` the first time.
3. Commit run files as you go; never merge `index.json` (it is derived and stays
   ignored either way).

Check before pushing that nothing local is about to leave the machine:

```bash
grep -l '"root": "/' data/hashes/runs/*.json
npm run doctor          # reports a stale index and leftover legacy files
```