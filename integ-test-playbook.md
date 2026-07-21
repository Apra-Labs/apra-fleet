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
export REAL_HOME="$HOME"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
mkdir -p "$HOME"
cd "<repo-root>"
node dist/index.js install
node dist/index.js start
git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"
```

`REAL_HOME` preserves the runner's real (pre-sandbox) home directory for the
`## Test scenario` credential-provisioning step below -- it is the only place
downstream that still needs to read anything from outside `$SANDBOX`.

Before handing off to the test: verify `node dist/index.js status` exits 0
and reports the server listening on `18700`.

### Seed the sandbox beads DB (structural isolation, no bootstrap, no neutralize)

Adopts the e2e suite's own technique (see `vendor/apra-pm/e2e/run-e2e.mjs`):
seed the sandbox's local beads DB straight from the git-committed
`.beads/issues.jsonl` already sitting in the clone above, rather than the
retired local-DB-recovery path this file previously documented here
(apra-fleet-eft.18's repro), which pulled the local Dolt DB from the real
`fleet-e2e-toy` Dolt remote and required patching the result back to a safe
state afterward (apra-fleet-eft.25/eft.30's two-part remediation). This flow
wires every remote the sandbox will ever talk to as a sandbox-local
throwaway BEFORE the local Dolt DB is created, so there is nothing to fix up
after the fact: the real `fleet-e2e-toy` remote URL is never adopted into
the sandbox's git or beads config at any step below.

Point the sandbox clone's git `origin` at a sandbox-local bare mirror of its
own just-cloned content -- never the real `fleet-e2e-toy` URL -- before any
`bd` command runs in the clone. This is safety-invariant layer (1): even
though `bd init` below auto-provisions a Dolt remote from git `origin` as a
side effect (the known apra-fleet-eft.30 trap), it can now only ever derive
a sandbox-local remote, because `origin` no longer resolves to anything
real.

```bash
TOY_REPO="$HOME/toy-repo"
GIT_MIRROR="$HOME/.apra-fleet-toy-origin.git"
rm -rf "$GIT_MIRROR"
git clone --bare "$TOY_REPO" "$GIT_MIRROR"
git -C "$TOY_REPO" remote set-url origin "file://$GIT_MIRROR"
```

Seed the local beads DB from the git-tracked JSONL only (no Dolt history is
pulled from anywhere), wiring `sync.remote` in the same command to a second,
dedicated sandbox-local throwaway directory -- deliberately not
`$GIT_MIRROR` above, since Dolt's `file://` remote format writes its own
storage directly into its target directory and would otherwise collide with
`$GIT_MIRROR`'s git-bare-repo layout. This is safety-invariant layer (2):

```bash
cd "$TOY_REPO"
rm -rf .beads/embeddeddolt .beads/.local_version
DOLT_REMOTE="$HOME/.apra-fleet-toy-dolt-remote"
rm -rf "$DOLT_REMOTE"
bd init --from-jsonl --prefix gh-toy --remote "file://$DOLT_REMOTE" --non-interactive
bd dolt push
```

`bd init --from-jsonl` imports the issues committed in `.beads/issues.jsonl`
into a fresh local Dolt DB and refuses to run at all if the `--remote`
target already carries real Dolt history it would have to discard --
exactly the guard that makes this seed step safe to treat as a hard failure
rather than a silent overwrite. `--remote` persists as `sync.remote` in
`.beads/config.yaml` in the same command, so it is live from the start;
`bd dolt push` immediately after seeds that throwaway remote with the
freshly-initialized DB once, so the rest of the run's D-push/D-pull
brackets have real history to sync against.

Verify: `.beads/config.yaml`'s `sync.remote` and the sandbox clone's own
Dolt remote list (`bd dolt remote list --json`) must both resolve to the
`$DOLT_REMOTE` throwaway above, and the sandbox clone's `git remote get-url
origin` must resolve to `$GIT_MIRROR` -- none of the three may ever
reference `fleet-e2e-toy`. `scripts/check-sandbox-sync-remote.mjs`
(apra-fleet-eft.25.2, extended by apra-fleet-eft.30.1 and apra-fleet-eft.31)
still asserts the "no reference to `fleet-e2e-toy`" shape of those three
checks today; its fourth check (no outbound git commits ahead of
`origin/main`) targets a different, now-stale hazard shape from the retired
bootstrap/neutralize flow -- under this design `origin` is sandbox-local
from the start, so being ahead of it carries no real-remote exposure, and
retargeting all four checks to assert every git/Dolt remote resolves
*inside* the sandbox path (rather than merely `!= fleet-e2e-toy`) is
apra-fleet-eft.18.6's job, not this step's. Run it from `<repo-root>`,
after the steps above:

```bash
node "<repo-root>/scripts/check-sandbox-sync-remote.mjs" "$HOME/toy-repo"
```

## Reset

A faster alternative to Teardown + Setup between test runs in the same
session. It restores the toy repo and its beads state to pristine without
reinstalling or re-cloning, using the same e2e-pattern reset the e2e suite
uses on this toy repo (see `vendor/apra-pm/e2e/run-e2e.mjs`): reset the git
working tree to the sandbox-local mirror's `main`, then throw away and
re-seed the local beads DB from the git-tracked JSONL. The git `origin`
remote wired during `## Setup` (the sandbox-local `$GIT_MIRROR`) is
untouched by `git reset`/`git clean` -- remotes live in `.git/config`, not
the working tree -- so it stays sandbox-local across every Reset with no
re-wiring needed.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
cd "$HOME/toy-repo"
git fetch origin
git reset --hard origin/main
git clean -fdx
rm -rf .beads/embeddeddolt .beads/.local_version
bd init --from-jsonl --prefix gh-toy --non-interactive
```

`rm -rf .beads/embeddeddolt` (plus `.local_version`, so `bd` never tries to
forward-migrate a stale schema marker) throws away the local Dolt DB
entirely; `bd init --from-jsonl` re-seeds it fresh from the git-tracked
`.beads/issues.jsonl` the `git reset --hard` above just restored -- the same
JSONL-only seed `## Setup` uses, so the hardcoded canary `gh-toy-4ef` (see
`## Test scenario` step 2) reappears automatically with no separate
re-provisioning step. `bd init` here auto-derives a fresh Dolt remote from
git `origin` (the sandbox-local `$GIT_MIRROR`) the same way the first
`bd init` in `## Setup` did; since nothing is ever pushed into
`$GIT_MIRROR` itself (`## Setup`'s one throwaway push always targets the
separate `$DOLT_REMOTE` directory instead), that auto-derived remote never
accumulates real Dolt history, so this plain re-init succeeds every time
without needing `--discard-remote`.

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
2. The canary is fixed, not looked up: `gh-toy-4ef`, the toy repo's minimal
   "Add a --version flag to the CLI" issue, labeled `integ-canary` in the
   git-committed `.beads/issues.jsonl` that `## Setup` (and `## Reset`) seed
   the sandbox's local beads DB from directly (apra-fleet-eft.18.5) -- no
   Dolt-remote tag lookup, no `bd import` reconcile, and no self-
   provisioning fallback. Confirm it came through the seed and is open:

   ```bash
   cd "$HOME/toy-repo"
   bd show gh-toy-4ef
   ```

   If this fails (issue missing, or not open), the seeded fixture itself
   is broken -- fail loud per step 5/6 below rather than silently self-
   provisioning a replacement. The canary is deliberately the SIMPLEST
   possible issue -- the same scope-containment trick the e2e suite uses
   with this same toy repo (its sprint script pins exactly one minimal
   issue, "Add --version flag to CLI"). A concrete, tiny deliverable keeps
   the toy sprint's planner from inventing scope: there is exactly one
   obvious task, one obvious change, and one objectively checkable
   outcome.
3. Provision LLM credentials for the freshly-registered `toy-doer` member,
   so the real Planner dispatch in step 4 below can authenticate
   (apra-fleet-eft.48: `LocalStrategy` dispatches for local members run
   through a clean-env `env -i ... bash -l -c` exec path that strips the
   runner's ambient `CLAUDE_CODE_OAUTH_TOKEN`/macOS Keychain session, so an
   unprovisioned member fails every dispatch with "Authentication failed").
   That clean-env path always runs with `HOME` seeded from whatever `HOME`
   the fleet server process itself was started with -- the sandboxed
   `$SANDBOX` from `## Setup`, never the runner's real home -- so the
   credential must land under `$SANDBOX`, not the operator's real
   `~/.claude/.credentials.json`.

   This uses the single-machine CI-runner model documented in
   `docs/tools-infrastructure.md` ("apra-fleet auth (CLI)"), not the
   SSH-based `provision_llm_auth` MCP flow: `integ-test-runner` has only
   [Read, Bash, Grep, Glob] tools and cannot call MCP tools (see "Adding
   new features to this test" below), and this CLI path is exactly the
   one that model doc section designs for CI runners where the fleet PM
   and its members share one machine. The credential source is whichever
   ambient Claude Code credential the runner's own real session already
   has -- its `CLAUDE_CODE_OAUTH_TOKEN` env var if set, else the
   `claudeAiOauth.accessToken` field of its real, pre-sandbox
   `$REAL_HOME/.claude/.credentials.json` (see `REAL_HOME` in `## Setup`).
   That token is seeded into the sandbox's own **persistent** credential
   store as `secure.INTEG-TOY-DOER-TOKEN` (`node dist/index.js secret
   --set ... --persist`, per `docs/tools-infrastructure.md`'s `secure.<name>`
   convention) and then written into the sandboxed credentials file with
   `node dist/index.js auth --oauth`. Both commands run with the
   already-sandboxed `HOME=$SANDBOX` from `## Setup`, so the persistent
   store lands at `$SANDBOX/.apra-fleet/data/credentials.json` and the
   resulting OAuth file at `$SANDBOX/.claude/.credentials.json` --
   neither command touches `$HOME/toy-repo` or anything under its
   `.git`/`.beads`, so this step cannot reach or write to the real
   `fleet-e2e-toy` git remote or its Dolt remote.

   ```bash
   TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
   if [ -z "$TOKEN" ] && [ -f "$REAL_HOME/.claude/.credentials.json" ]; then
     TOKEN=$(node -e "
       const fs = require('fs');
       const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
       process.stdout.write((c.claudeAiOauth && c.claudeAiOauth.accessToken) || '');
     " "$REAL_HOME/.claude/.credentials.json")
   fi
   if [ -z "$TOKEN" ]; then
     echo "No ambient Claude credential found (CLAUDE_CODE_OAUTH_TOKEN unset" \
          "and $REAL_HOME/.claude/.credentials.json missing/empty). Run" \
          "'/login' in a real session first, or export" \
          "CLAUDE_CODE_OAUTH_TOKEN, then re-run this step." >&2
     exit 1
   fi
   echo "$TOKEN" | node dist/index.js secret --set INTEG-TOY-DOER-TOKEN --persist -y
   node dist/index.js auth --oauth --llm claude secure.INTEG-TOY-DOER-TOKEN
   ```

   Verify: `$SANDBOX/.claude/.credentials.json` exists and its
   `claudeAiOauth.accessToken` is non-empty (`node dist/index.js auth
   --oauth` prints the file path it wrote on success) -- this is the same
   file `toy-doer`'s clean-env dispatch reads, since `getCleanEnv()` seeds
   the clean shell's `HOME` from the fleet server process's own `HOME`
   (`$SANDBOX`) before sourcing login profiles under it.
4. Run `apra-fleet workflow auto-sprint` against the canary issue with
   `--max-cycles 1` and `--dispatch-timeout-s 900`. The timeout bound
   means a hung dispatch (member process alive but silent) costs at most
   15 minutes instead of the default hour -- right-sized for the canary's
   tiny scope. Dolt-remote isolation needs no flag: with the sandbox's
   `sync.remote` neutralized per `## Reset`, the engine's D-push pre-gate
   refuses to issue any `bd dolt push` at all (there is no
   `skip_dolt_push` arg -- an earlier revision of this playbook named one
   that never existed). The canary's tiny fixed scope (one flag, one
   file, one assertion) is what keeps this step inside the time budget --
   if the sprint plans more than a couple of tasks for it, that is itself
   suspicious and worth a bug bead.
5. Assert the canary issue is now closed and the toy repo's sprint branch
   has a commit. Because the canary's deliverable is concrete, also
   verify it functionally when the canary is the "--version flag" issue:
   run the toy CLI with `--version` from the sprint branch and confirm it
   prints a version string and exits 0. If any assertion fails, fail
   loud: file a bug bead. Do not silently reset and move on -- this repo
   treats sprint-run surprises as signal
   ([[project-goal-auto-sprint-ruggedization]]).
6. Hand off to Teardown regardless of the assertion's outcome.

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
