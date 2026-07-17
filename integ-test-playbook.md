# Fleet Integration Test Playbook

Brings up a throwaway, fully isolated `apra-fleet` install for integration
testing. Never touches the real `~/.apra-fleet` (production) install or its
credentials/registry. Uses a fixed, well-known sandbox path (not a random
per-run directory) so `integ-test-runner` can reference the same location
without any hand-off file.

Sandbox root: `~/temp/.apra-fleet-tests` (i.e. `$HOME/temp/.apra-fleet-tests`
on POSIX, `%USERPROFILE%\temp\.apra-fleet-tests` on Windows).
Scratch port: `18700` (`APRA_FLEET_PORT`), chosen off the beaten path from
the default `7523` and from the `18300`-series auto-sprint dashboard ports.

Target end-to-end time: under 10 minutes (Setup + one `max_cycles:1` toy
sprint + Teardown). If any single step exceeds 2 minutes, treat that as a
bug in its own right, not just a slow test.

## Permissions

Commands below require these prefixes in `.claude/settings.json` under
`permissions.allow`:
- `Bash(mkdir *)`
- `Bash(rm -rf ~/temp/.apra-fleet-tests*)`
- `Bash(node dist/index.js *)`
- `Bash(git clone *)`
- `Bash(git -C ~/temp/.apra-fleet-tests* *)`
- `Bash(node scripts/run-integ-suites.mjs *)` (for the
  "Unit-suite timing check" section only)

## Setup

Brings the sandbox up from nothing: fresh HOME, fresh install, server
running on the scratch port, toy repo cloned. Does NOT register a fleet
member and does NOT seed/trigger a sprint -- that is the first step of the
actual test, run separately by `integ-test-runner` (member registration is
itself one of the things under test).

```bash
export HOME=~/temp/.apra-fleet-tests
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
mkdir -p "$HOME"
cd "<repo-root>"
node dist/index.js install
node dist/index.js start
git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"
```

Verify before proceeding to the actual test: `node dist/index.js status`
exits 0 and reports the server listening on `18700`.

## Reset

Faster path between consecutive test runs in the same session: restores the
toy repo and beads state to pristine without a full reinstall/re-clone.

```bash
export HOME=~/temp/.apra-fleet-tests
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
cd "$HOME/toy-repo"
git fetch origin
git reset --hard origin/main
git clean -fdx
```

The toy repo maintains a permanent, always-open canary issue
(convention: tagged `integ-canary` in its beads DB) for exactly this
purpose -- `git reset --hard` plus `bd` being reset along with the rest of
the tracked repo state re-opens it. If the canary issue has been
renamed/removed, re-seed one before continuing and update this file's
"Test scenario" section below with the new ID.

## Teardown

Runs after every integration test run, regardless of pass/fail. Full
cleanup -- stops the server and deletes the sandbox entirely so it never
accumulates state or drifts from a fresh install across runs.

```bash
export HOME=~/temp/.apra-fleet-tests
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
node dist/index.js stop
rm -rf ~/temp/.apra-fleet-tests
```

## Test scenario (informational -- not a deployer.md-executed section)

This section documents what `integ-test-runner` does with the environment
`## Setup` hands it. It is not one of the three contractual sections above
and the deployer agent does not execute it -- record it here purely so the
sandbox's purpose stays legible to whoever maintains this file.

1. Register one member (`register_member` MCP tool, not a shell command)
   pointed at `$HOME/toy-repo`, using the isolated `HOME`/`APRA_FLEET_PORT`
   from Setup.
2. Confirm the canary issue is open (`bd show <canary-id>`).
3. Run `apra-fleet workflow auto-sprint` against the canary issue with
   `max_cycles: 1` and `skip_dolt_push: true` (never write to the real Dolt
   remote from a sandbox run).
4. Assert the canary issue closed and the toy repo's sprint branch has a
   commit. Fail loud (file a bug bead) if not -- do not silently reset and
   move on, per this repo's [[project-goal-auto-sprint-ruggedization]]
   convention of treating sprint-run surprises as signal.
5. Hand off to Teardown regardless of the assertion's outcome.

This exercises, in one ~10-minute pass: fresh install, server boot, member
registration, git topology checks, planner/doer/reviewer dispatch, and
harvest -- the same layers a real sprint depends on, without touching
production state.

## Unit-suite timing check (apra-fleet-se)

A separate, optional Bash-only step -- run this in addition to the
`## Test scenario` above whenever this sprint's own changes touch
`packages/apra-fleet-se/test/**` (e.g. a test-suite performance/redundancy
refactor). It does not require the sandbox from `## Setup` and does not
touch the sandbox's HOME/port -- run it from the repo checkout directly.

The full suite is ~38 files and takes ~6.5-8 minutes wall clock at
`--test-concurrency=8` (per `packages/apra-fleet-se/test/TEST-VALUE-ANALYSIS.md`;
cumulative per-file time is much larger, ~48 min, which is why concurrency
matters). Do NOT run it as one blocking
`npm test --workspace=@apralabs/apra-fleet-se` call: that is exactly the
failure mode `integ-test-runner.md` warns about under "Waiting on a
long-running test run" (a long silent Bash call looks like a hang to the
dispatch watchdog and gets the whole run killed), except worse -- a timeout
partway through the monolithic call loses ALL prior progress with no record
of which suites already passed.

**Real bd, not the mock**: this step MUST run against real `bd`, not the
mocked default. The bd-mock-shim work makes the mocked bd the DEFAULT for
plain `npm test` (`APRA_FLEET_BD_MOCK` unset = mock/replay), so bare
`npm test` is the WRONG command here -- it would silently test the mock
instead of the real integration path. The helper script below already
forces the real mode by setting `APRA_FLEET_BD_MOCK=off` (the confirmed
contract: unset/default = mock/replay; `0`/`false`/`off`/`real` = real bd;
`record` = real bd + refresh fixtures). Do not copy-paste a bare `npm test`
invocation into this step.

**No fail-fast**: `node --test` continues past a failure in any one file by
default and this runner keeps it that way -- a failing file is recorded and
every other file still runs. Do not add `--test-fail-fast` (or any
equivalent) to the runner or the package's test script for this step.

Instead, run the suite via the helper script `scripts/run-integ-suites.mjs`:
it launches ONE detached background `node --test --test-concurrency=8` run
over all pending files (keeping the full concurrency wall-clock win), while
a checkpoint reporter (`scripts/integ-file-results-reporter.mjs`) streams
each file's result into the durable status file `integ-suite-status.json`
at the repo root (gitignored throwaway state -- never commit it) the instant
that file finishes. Every calling-agent-facing invocation is short: `--start`
returns immediately and `--status --wait=N` is a bounded poll. (The
detached-background design was smoke-tested in the dispatch environment on
2026-07-17: a detached+unref'd Node child survives the spawning tool call
returning. If a future environment kills detached children, the fallback is
bounded foreground batches per call -- see the script header.)

1. Check state first: `node scripts/run-integ-suites.mjs --status`
   This enumerates every `packages/apra-fleet-se/test/*.test.mjs` file and
   prints one summary line (`discovered= done= pending= failed= inflight=
   elapsedWall= cumFileTime= live=`), then FAILED files only with their
   captured failure detail, then in-flight files if a run is live. It
   detects a live prior run (exit 3 -- poll it, do not start another) or a
   crashed one (exit 2 with pending files -- resume via step 2). If
   discovery finds zero test files, or the status file is corrupt or
   records results for files that no longer exist, it also exits 2: fail
   loud, file a bug bead, do not continue.
2. Start (or resume) the run: `node scripts/run-integ-suites.mjs --start`
   Returns immediately after spawning the detached supervisor. It computes
   pending = discovered files minus files with a recorded result, so after
   a crash the same command reruns ONLY the pending files (every scenario
   uses an isolated temp dir, so rerunning a file that was in flight during
   a crash is safe). It refuses (exit 3) if a run is already live.
3. Poll with bounded waits, narrating between polls:
   `node scripts/run-integ-suites.mjs --status --wait=45`
   Each call waits at most 45 seconds, returning early the moment the
   recorded state changes. Between every poll, narrate progress explicitly
   ("N/M files done, K in flight") -- same liveness discipline as
   `integ-test-runner.md`'s "Waiting on a long-running test run" guidance,
   at least once a minute; never replace the polls with one long silent
   call. Exit 3 = still running, poll again. Exit 2 mid-run = the
   background run crashed (infra failure, not a test failure): narrate it
   and run `--start` again to resume from the checkpoints.
4. Completion check: the pass is complete ONLY when `--status` prints
   `pass COMPLETE` and exits 0 (all pass) or 1 (failures recorded). A state
   with `pending > 0` is a partial pass -- resume it or report it as
   interrupted; never report it as a completed pass.
5. Report the final summary line verbatim in your notes back to the
   orchestrator -- both `elapsedWall=` (wall clock) and `cumFileTime=`
   (summed per-file time) are the concrete before/after evidence a
   test-suite-speedup sprint needs, not just "tests still pass."
6. A recorded failure in any file is a real regression: file an `[integ]`
   bug bead using the captured failure detail from `--status` (failing
   file, failing test name(s), first error), do not silently continue, and
   do not re-run hoping it goes green without first recording the failure.
   `--fresh` (which clears the status/heartbeat/log files for a brand-new
   measured pass) is for starting a new measured run, NEVER for erasing an
   inconvenient result.
7. If any single file takes more than ~5 minutes (per its recorded
   `durationMs`), that file is the long pole for the whole concurrent run:
   file a bug bead to split it (precedent: the four slowest files were
   already split once, commit 72a929e).

## Adding new features to this test

When auto-sprint or the installer gains a new capability that changes what
"a working install" means (e.g. a new required member role, a new
pre-sprint gate, a new CLI subcommand), extend the test scenario rather
than writing a separate ad-hoc script:

1. Add the new precondition/step to the "Test scenario" list above, keeping
   it numbered and in the order it actually executes.
2. If the new feature needs its own fixture (e.g. a second toy issue with
   specific dependency shape), add it to `fleet-e2e-toy` directly, tagged
   consistently with the existing `integ-canary` convention, and note the
   new tag/ID here.
3. If the new feature needs a genuinely different environment shape (a
   second member, a different port, a different topology), prefer adding a
   second `## Setup`-adjacent step over forking this file -- multiple
   playbook files would drift independently and defeat the point of having
   one source of truth.
4. Keep the <10-minute budget. If a new feature's test step is inherently
   slow, gate it behind an opt-in flag documented here rather than making
   every run pay for it.
5. Never modify `## Setup` / `## Reset` / `## Teardown` to include MCP tool
   calls -- the deployer agent executing this file only has Bash/Read
   access. Anything requiring MCP tools belongs in the "Test scenario"
   section, run by `integ-test-runner`.
