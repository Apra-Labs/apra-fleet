# Real-bd unit-suite check (apra-fleet-se)

When to run: only when the sprint's changes touch
`packages/apra-fleet-se/test/**`. Runs from the repo checkout; needs no
sandbox. The runner forces real bd (`APRA_FLEET_BD_MOCK=off`) -- never
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
   long pole of the concurrent run: file a bug bead to split it (precedent:
   commit 72a929e).

Exit codes for `--status`: 0 complete+pass, 1 complete+failures, 3 still
running, 2 fail-loud (corrupt/stale state, or crashed with pending files).
