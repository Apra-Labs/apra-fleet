# Fleet Integration Test Playbook

This playbook is run by the `integ-test-runner` agent. (The `deployer`
agent is a different role: it follows `deploy.md` to install the software
on a target. It does not run this file.)

The playbook has two parts, and a full integration pass runs BOTH:

1. **Real functional tests** (`## Run the apra-fleet-se suite against real
   bd`): the full `apra-fleet-se` test suite, unmocked, against the real
   `bd` CLI. These are the real functional tests, and they grow over time.
2. **Smoke test** (`## Setup` / `## Reset` / `## Teardown` +
   `## Test scenario`): one tiny toy sprint end to end in a throwaway
   sandbox, proving every basic usage of apra-fleet-se works -- install,
   server boot, member registration, sprint, harvest.

Together they give stakeholders confidence in working functionality: the
first that the product's behavior is correct against the real backend, the
second that the product as installed actually runs.

The smoke test's sandbox is fully isolated: it never touches the real
`~/.apra-fleet` (production) install or its credentials/registry, and it
lives at a fixed, well-known path (not a random per-run directory) so no
hand-off file is needed between steps.

Conventions used below:
- Sandbox root: `~/temp/.apra-fleet-tests` (`$HOME/temp/.apra-fleet-tests`
  on POSIX, `%USERPROFILE%\temp\.apra-fleet-tests` on Windows).
- Scratch port: `18700` (`APRA_FLEET_PORT`) -- kept away from the default
  `7523` and the `18300`-series auto-sprint dashboard ports.
- `<repo-root>`: the root of this apra-fleet checkout -- the directory
  containing this playbook. The executing agent substitutes its actual
  checkout path.

Target time for the smoke test: under 10 minutes (Setup + one
`max_cycles:1` toy sprint + Teardown). Any single step over 2 minutes is a
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
  "Run the apra-fleet-se suite against real bd" section only)

## Run the apra-fleet-se suite against real bd

Part 1 of the pass. Runs the full `packages/apra-fleet-se` test suite
against the real `bd` CLI (not the recorded mock) and files `[integ]` bug
beads for any failure. It is Bash-only and independent of the smoke-test
sandbox below. Follow the step-by-step procedure in
`packages/apra-fleet-se/test/INTEG-SUITE.md`, which drives
`scripts/run-integ-suites.mjs` (start a background run, poll with bounded
waits, report the final summary). Never substitute a bare `npm test` here
-- that would test the mock.

Note (bd record/replay shim): plain `npm test` for this workspace now runs
in bd REPLAY mode by default (bd CLI responses served from recorded
fixtures under `packages/apra-fleet-se/test/fixtures/bd-recordings/`; see
the README there), so it completes in seconds. The unmocked, real-bd run
-- the pre-shim behavior, and the right lane for validating bd CLI
compatibility or re-measuring real-bd wall time -- is:

```bash
npm run test:integration --workspace=@apralabs/apra-fleet-se
```

## Setup

First of the three sandbox-lifecycle sections for the smoke test (part 2
of the pass). Brings the sandbox up from nothing: fresh HOME, fresh
install, server running on the scratch port, toy repo cloned. It does NOT
register a fleet member and does NOT start a sprint. Those are the first
steps of the test itself (see `## Test scenario`), because member
registration is one of the things under test.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
mkdir -p "$HOME"
cd "<repo-root>"
node dist/index.js install
node dist/index.js start
git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"
```

Before handing off to the test: verify `node dist/index.js status` exits 0
and reports the server listening on `18700`.

### Neutralize sandbox sync.remote after any `bd bootstrap --yes`

A fresh clone can hit a "no beads database found" error before the local
beads DB is materialized; the documented recovery is `bd bootstrap --yes` in
`$HOME/toy-repo` (see apra-fleet-eft.18's repro). Run this step immediately
after ANY `bd bootstrap --yes` invocation in the sandbox -- whether it is
needed once here during `## Setup`, or again later as an ad hoc recovery
action during a test session -- and always before the next auto-sprint run
(`## Test scenario` step 3).

Why: the pristine `fleet-e2e-toy` clone ships with `sync.remote` commented
out (`# sync.remote disabled -- no Dolt push for this toy project`), which is
what lets `## Test scenario` step 3 rely on `skip_dolt_push` semantics. But
`bd bootstrap --yes` rehydrates the local DB from the real `fleet-e2e-toy`
Dolt remote and, as a side effect, rewrites `.beads/config.yaml` to add a new
ACTIVE `sync.remote` block pointing at that same remote, leaving the old
disabled line stale below it. Left active, this is a latent hazard: it does
not break the immediately-following `bd bootstrap` call itself, but it means
the NEXT `bd dolt push` from a real auto-sprint run against this sandbox
(once a real doer/harvester commit lands) would push sandbox test mutations
to the shared external remote real users/CI depend on -- defeating the
playbook's isolation guarantee.

This step is idempotent and safe to run even if `bd bootstrap --yes` was
never invoked in this sandbox: it is a no-op when there is no active
`sync.remote` line to comment out.

```bash
CONFIG="$HOME/toy-repo/.beads/config.yaml"
if [ -f "$CONFIG" ]; then
  sed -i.bak -E '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}' "$CONFIG"
  rm -f "$CONFIG.bak"
fi
```

Verify: no uncommented line in `.beads/config.yaml` may reference
`fleet-e2e-toy` after this step, AND the sandbox clone must have 0 commits
ahead of `origin/main` (nothing has actually reached the real remote).
`scripts/check-sandbox-sync-remote.mjs` (apra-fleet-eft.25.2) asserts both in
one shell-drivable, sandbox-only, read-only step -- it exits non-zero (and
prints a `FAIL` line) if either check fails, and exits 0 (`OK` lines) when
both hold. Run it from `<repo-root>`:

```bash
node "<repo-root>/scripts/check-sandbox-sync-remote.mjs" "$HOME/toy-repo"
```

(Its own unit tests, `tests/check-sandbox-sync-remote.test.ts`, exercise both
the eft.25 hazard shape -- active `sync.remote` right after a bare `bd
bootstrap --yes` -- and the eft.25.1 remedy shape -- `sync.remote`
commented out -- entirely against local fixtures, so they never touch the
real remote either.)

## Reset

A faster alternative to Teardown + Setup between test runs in the same
session. It restores the toy repo and its beads state to pristine without
reinstalling or re-cloning.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
cd "$HOME/toy-repo"
git fetch origin
git reset --hard origin/main
git clean -fdx
```

If `.beads/config.yaml` is git-tracked in `fleet-e2e-toy`, the `git reset
--hard` above already restores its pristine, disabled `sync.remote` state.
But if `bd bootstrap --yes` needs to run again later in the same session
(e.g. recovering a corrupted local beads DB between Resets, per apra-fleet-
eft.18's repro) before the next `## Reset`, immediately re-run the
"Neutralize sandbox sync.remote after any `bd bootstrap --yes`" step from
`## Setup` above before proceeding to the next `## Test scenario` sprint run.

The toy repo keeps one permanent, always-open canary issue for exactly
this purpose, identified by its `integ-canary` tag in the repo's beads DB.
This file deliberately does not hard-code the issue's ID: the test looks
it up by tag at run time, and the `<canary-id>` token in `## Test
scenario` is a placeholder for whatever that lookup returns -- not a real
ID someone forgot to fill in. The `git reset --hard` above restores the
beads DB along with the rest of the tracked repo state, which re-opens the
canary, when that canary exists upstream.

If the tag lookup in `## Test scenario` step 2 returns zero matches (no
upstream `integ-canary` issue present, or it was renamed/removed), the
runner self-provisions a canary in the sandbox's LOCAL beads DB only --
this never writes to or pushes the real Dolt remote.

The canary is deliberately the SIMPLEST possible issue -- the same
scope-containment trick the e2e suite uses with this same toy repo (its
sprint script pins exactly one minimal issue, "Add --version flag to
CLI"). A concrete, tiny deliverable keeps the toy sprint's planner from
inventing scope: there is exactly one obvious task, one obvious change,
and one objectively checkable outcome.

```bash
cd "$HOME/toy-repo"
bd create "Add a --version flag to the CLI" \
  -d "Print the toy project version when the CLI is invoked with --version, then exit 0. Smallest possible change: no refactors, no extra features." \
  --acceptance "Running the CLI with --version prints a version string and exits 0." \
  --label integ-canary
```

This is local-only: it creates the issue in the sandbox clone's local
beads DB and does not push, preserving the same `skip_dolt_push`
semantics that `## Test scenario` step 3 uses for the sprint run itself.
Proceed using the newly-created issue's ID as `<canary-id>`.

Maintainer note (out-of-band; NOT a sandbox/runner step): to re-seed a
*permanent* canary upstream so future runs find it via the tag lookup
instead of self-provisioning, a maintainer with push access to
`git+https://github.com/Apra-Labs/fleet-e2e-toy` tags an issue of this
same minimal "--version flag" shape with `integ-canary` in that repo's
beads DB and pushes it from a real, non-sandbox checkout (the toy repo's
existing e2e issue of that exact shape is a natural candidate). This is a
one-time maintenance action on shared external infra performed by a human
maintainer -- it is not something `integ-test-runner` does automatically,
and it is separate from the automated self-provision path above.

## Teardown

Runs after every test run, pass or fail. It stops the server and deletes
the sandbox entirely, so no state accumulates or drifts from a fresh
install between runs.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
node dist/index.js stop
rm -rf "$SANDBOX"
```

## Test scenario (informational)

The smoke test itself: what `integ-test-runner` does with the environment
`## Setup` provides. Marked informational because it applies judgment and
assertions (find the canary, run a sprint, verify the outcome), not a fixed
copy-paste block like the three lifecycle sections. Every step is now
shell-drivable -- no MCP tool is required to run the scenario.

1. Register one member pointed at `$HOME/toy-repo`, using the isolated
   `HOME`/`APRA_FLEET_PORT` from Setup, via the `register-member` CLI
   subcommand (Bash, not the `register_member` MCP tool):

   ```bash
   node dist/index.js register-member --type local --name toy-doer \
     --path "$HOME/toy-repo" --llm claude
   ```
2. Find the canary issue by its `integ-canary` tag. If the lookup returns
   a match, confirm it is open (`bd show <canary-id>`, where
   `<canary-id>` is whatever ID the tag lookup returned). If the lookup
   returns zero matches, self-provision the minimal "--version flag"
   canary in the sandbox's local beads DB per `## Reset` above
   (`bd create "Add a --version flag to the CLI" ... --label
   integ-canary`, no push) and use its ID as `<canary-id>`. Neither path
   writes to `git+https://github.com/Apra-Labs/fleet-e2e-toy`.
3. Run `apra-fleet workflow auto-sprint` against the canary issue with
   `max_cycles: 1` and `skip_dolt_push: true` (never write to the real Dolt
   remote from a sandbox run). The canary's tiny fixed scope (one flag,
   one file, one assertion) is what keeps this step inside the time
   budget -- if the sprint plans more than a couple of tasks for it, that
   is itself suspicious and worth a bug bead.
4. Assert the canary issue is now closed and the toy repo's sprint branch
   has a commit. Because the canary's deliverable is concrete, also
   verify it functionally when the canary is the "--version flag" issue:
   run the toy CLI with `--version` from the sprint branch and confirm it
   prints a version string and exits 0. If any assertion fails, fail
   loud: file a bug bead. Do not silently reset and move on -- this repo
   treats sprint-run surprises as signal
   ([[project-goal-auto-sprint-ruggedization]]).
5. Hand off to Teardown regardless of the assertion's outcome.

One ~10-minute pass exercises fresh install, server boot, member
registration, git topology checks, planner/doer/reviewer dispatch, and
harvest -- the same layers a real sprint depends on -- without touching
production state.

## Adding new features to this test

When auto-sprint or the installer gains a capability that changes what "a
working install" means (a new required member role, a new pre-sprint gate,
a new CLI subcommand), extend this test rather than writing a separate
ad-hoc script:

1. Add the new step to the `## Test scenario` list above, numbered, in the
   order it actually runs.
2. If it needs its own fixture (e.g. a second toy issue with a specific
   dependency shape), add that to `fleet-e2e-toy` directly, tag it the
   same way as `integ-canary`, and note the new tag here.
3. If it needs a genuinely different environment (a second member, a
   different port, a different topology), add another `## Setup`-adjacent
   step here rather than forking this file -- separate playbook files
   would drift apart and defeat the point of one source of truth.
4. Keep the <10-minute budget. If the new step is inherently slow, gate it
   behind an opt-in flag documented here rather than making every run pay
   for it.
5. Keep every section shell-drivable: `## Setup` / `## Reset` /
   `## Teardown` are fixed copy-paste command blocks, and `## Test scenario`
   is also all Bash (member registration uses the `register-member` CLI
   subcommand, not the MCP tool). This matters because `integ-test-runner`
   has only [Read, Bash, Grep, Glob] tools and cannot call MCP tools -- if a
   step genuinely needs MCP, add a CLI entry point for it first rather than
   assuming the runner can reach the MCP tool.
