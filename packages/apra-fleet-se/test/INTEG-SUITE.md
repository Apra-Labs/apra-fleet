# Real-bd unit-suite check (apra-fleet-se)

When to run: part 1 of every full integration pass (see
`integ-test-playbook.md`). Runs from the repo checkout; needs no sandbox. The runner forces real bd (`APRA_FLEET_BD_MOCK=off`) -- never
substitute a bare `npm test`, which would test the mock. Expect ~7 min wall
clock for the full suite. Script internals, flag contract, and design
rationale: header of `scripts/run-integ-suites.mjs`.

Procedure (all commands from the repo root):

1. `node scripts/run-integ-suites.mjs --status`
   Exit 3 = a run is already live: skip to step 3. Exit 2 = crashed or
   stale state: read the message; if it says resume, go to step 2; if the
   status file is corrupt/stale, fail loud and file a bug bead.
2. `node scripts/run-integ-suites.mjs --start`
   Returns immediately; starts (or resumes) one detached background run of
   all pending files. State persists in `integ-suite-status.json` at the
   repo root (gitignored -- never commit it).
3. `node scripts/run-integ-suites.mjs --status --wait=45`
   Repeat, narrating progress between every poll ("N/M files done, K in
   flight"), at least once a minute. Exit 3 = poll again. Exit 2 mid-run =
   infra crash: narrate it, then `--start` again to resume.
4. Complete ONLY when `--status` prints `pass COMPLETE` and exits 0 (all
   pass) or 1 (failures). `pending > 0` is a partial pass -- resume or
   report as interrupted, never as done.
5. Report the final summary line verbatim (`elapsedWall=` and
   `cumFileTime=` are the before/after evidence for test-speed work).
6. Any recorded failure is a real regression: file an `[integ]` bug bead
   with the captured detail (file, failing test names, first error) before
   anything else. `--fresh` starts a new measured pass -- NEVER use it to
   erase a recorded failure.
7. Any single file over ~5 minutes (`durationMs` in the status file) is the
   long pole of the concurrent run: file a bug bead to split it. Run
   `node scripts/check-integ-suite-budget.mjs` after
   step 4 to check this automatically instead of eyeballing durationMs by
   hand -- it reads `integ-suite-status.json` and reports/exits non-zero
   with the offending file(s) named. Exit 2 means no completed run was
   found yet (finish steps 1-4 first).

Exit codes for `--status`: 0 complete+pass, 1 complete+failures, 3 still
running, 2 fail-loud (corrupt/stale state, or crashed with pending files).

## Reproducing on a pre-fix commit (before/after evidence)

When a timeout/perf bead needs to PROVE a "before" measurement (not just
assert one from memory), you need this suite runnable at an OLD commit, not
just at branch HEAD. Two tempting shortcuts do not work:

- `git worktree add <dir> <old-sha>` -- the worktree has no workspace
  `node_modules` of its own (those live only in the primary checkout's root),
  so any apra-fleet-se test aborts immediately with
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@apralabs/apra-fleet-workflow'`.
- Symlinking the primary checkout's root `node_modules` into the worktree --
  on Windows Git Bash, `ln -s <primary>/node_modules <wt>/node_modules`
  resolves INSIDE the existing directory as `node_modules/node_modules`
  instead of replacing it, so the `@apralabs` scope visible from the
  worktree still only contains `apra-fleet-client` (whatever the worktree's
  own partial `node_modules` already had), not the other workspace packages.

The recipe that works is a full scratch clone plus its own `npm install`,
which materializes real `node_modules` (and the npm workspace's `@apralabs/*`
symlinks) for that exact checkout instead of trying to borrow the primary
checkout's:

```bash
# 1. Clone from the LOCAL primary checkout (fast, gets every SHA), into a
#    scratch path OUTSIDE the primary repo tree so it never shows up in the
#    primary checkout's `git status` or gets swept by a `git clean` there.
SCRATCH="$HOME/temp/apra-fleet-prefix-check"
rm -rf "$SCRATCH"
git clone <path-to-primary-checkout> "$SCRATCH"

# 2. Check out the exact pre-fix commit (the fix commit's own parent, or
#    whatever SHA the "before" measurement needs).
cd "$SCRATCH"
git checkout <pre-fix-sha>

# 3. Install. This is the step that materializes node_modules/@apralabs/*
#    for THIS checkout -- no worktree/symlink trick needed.
npm install

# 4. Run the suite exactly like `test:integration` does (real bd, not the
#    mock), scoped to the file(s) under investigation:
cd packages/apra-fleet-se
APRA_FLEET_BD_MOCK=0 node scripts/run-tests.mjs real test/<file>.test.mjs [test/<file2>.test.mjs ...]
```

Notes on why each step is what it is:

- A plain `git clone` of the local primary checkout carries every tracked
  file including `packages/apra-fleet-se/apra-pm` (not a submodule, so no
  `--recurse-submodules` is needed).
- `npm install` in the scratch clone is what populates
  `node_modules/@apralabs/{apra-fleet-client,apra-fleet-se,apra-fleet-workflow,fleet-api-contract}`;
  without it every apra-fleet-se test dies at module resolution.
- When you need to reproduce a concurrency-dependent timeout rather than a
  single file's runtime, run the same narrow set of bd-touching files
  together at the same `--test-concurrency` the real pass uses. A file that
  passes alone can still be cancelled at the runner's hard cap under
  concurrent load, and that contention is usually the thing being measured.
- Expect measured "before" numbers to land close to, but not exactly on, any
  previously recorded figure; report the discrepancy rather than smoothing it
  over. Machine load and concurrency both move these numbers.

The recipe has been exercised on Windows Git Bash. It is POSIX-shell-only
(no Windows-specific commands), so it should be symmetric on macOS/Linux,
but that has not been separately run.

This does NOT need (and must not use) `regression-test-playbook.md`'s
`## Setup`/`## Reset`/`## Teardown` sandbox -- that stands up an installed
server, a registered member, and a toy-repo sprint; this recipe only needs
a scratch checkout to run unit tests against real bd, with no server and no
member registration.
