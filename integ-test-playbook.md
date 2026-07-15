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
