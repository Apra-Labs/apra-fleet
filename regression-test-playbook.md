# Fleet Regression Test Playbook

Run by `regression-test-runner` to prove EXISTING functionality still works.
It is NOT a gate on the current sprint's new work: feature-closure testing
for the current cycle's features lives in `integ-test-playbook.md` instead.
(The `deployer` agent is a different role: it follows `deploy.md` to install
the software on a target. It does not run this file.)

Run BOTH parts for a full regression pass:

- **Part 1 -- real functional tests.** Section `## Run the apra-fleet-se
  suite against real bd`. The full `apra-fleet-se` test suite, unmocked,
  against the real `bd` CLI, at branch HEAD.
- **Part 2 -- smoke test.** Sections `## Setup`, `## Test scenario`,
  `## Reset`, `## Teardown`. One toy sprint end to end in a throwaway
  sandbox it provisions fresh for itself: install, server boot, member
  registration, sprint, harvest.

The smoke test's sandbox never touches the real `~/.apra-fleet`
(production) install or its credentials/registry. It lives at a fixed,
well-known path (not a random per-run directory) so no hand-off file is
needed between steps.

Conventions used below:
- Sandbox root: `~/temp/.apra-fleet-tests` (`$HOME/temp/.apra-fleet-tests`
  on POSIX, `%USERPROFILE%\temp\.apra-fleet-tests` on Windows).
- Scratch port: `18700` (`APRA_FLEET_PORT`) -- kept away from the default
  `7523` and the `18300`-series fleet-sprint dashboard ports.
- `<repo-root>`: the root of this apra-fleet checkout -- the directory
  containing this playbook. The executing agent substitutes its actual
  checkout path.

Target time for the smoke test: under 10 minutes (Setup + one
`max_cycles:1` toy sprint + Teardown). Any single step over 2 minutes is a
bug in its own right, not just a slow test.

## Permissions

Commands below require coverage for these prefixes by SOME entry in
`permissions.allow` of EITHER `.claude/settings.json` OR
`.claude/settings.local.json` (where the fleet's compose_permissions tool
delivers). A broader prefix entry counts as coverage -- e.g. `Bash(node:*)`
covers `node dist/index.js`, `Bash(git:*)` covers `git clone`, and
`Bash(bd:*)` covers `bd`. Only report a permissions block if a prefix has
no covering entry in either file, or a command is actually denied at
runtime:
- `Bash(mkdir *)`
- `Bash(rm -rf ~/temp/.apra-fleet-tests*)`
- `Bash(node dist/index.js *)`
- `Bash(git clone *)`
- `Bash(git -C ~/temp/.apra-fleet-tests* *)`
- `Bash(node scripts/run-integ-suites.mjs *)` (for the
  "Run the apra-fleet-se suite against real bd" section only)
- `Bash(npm run test:slow*)` (same section, the slow-lane run)
- `Bash(bd *)` (for "Reporting failures" below -- `bd search` to dedupe and
  `bd create` to file the parent-less carry-over beads; also the sandbox
  `bd show`/`bd dolt` steps in `## Setup` and `## Test scenario`)

## Run the apra-fleet-se suite against real bd

Part 1 of the pass. Runs the full `packages/apra-fleet-se` test suite
against the real `bd` CLI (not the recorded mock), against branch HEAD, and
files failures per "Reporting failures" below. It is Bash-only and
independent of the smoke-test sandbox below. Follow the step-by-step
procedure in `packages/apra-fleet-se/test/INTEG-SUITE.md`, which drives
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

Also run the slow lane (`test/slow/`): two real-time watchdog regression
tests (~8 minutes total) excluded from the default `test` script and from
CI, but still owned by this once-per-sprint pass -- they prove Node's
event-loop keep-alive and full retry-exhaustion timing for the dispatch
watchdog, which cannot be faked with mock timers (see the file-level
comments in each for why).

```bash
npm run test:slow --workspace=@apralabs/apra-fleet-se
```

## Setup

First of the three sandbox-lifecycle sections for the smoke test (part 2
of the pass). Brings the sandbox up from nothing: fresh HOME, fresh
install, server running on the scratch port, toy repo cloned. It does NOT
register a fleet member and does NOT start a sprint. Those are the first
steps of the test itself (see `## Test scenario`), because member
registration is one of the things under test.

Prerequisites (a fresh checkout fails without these; a sprint workspace
normally has all three already):
<!-- history: apra-fleet stabilization Issue 43 -->
- `<repo-root>` cloned normally (`git clone`) -- `install`
  fails at its fleet-skill step if `packages/apra-fleet-se/apra-pm` is empty.
- `npm install && npm run build` has been run -- every step below invokes
  `node dist/index.js`.
- The runner's real session has a live Claude credential (see the
  credential-provisioning step in `## Test scenario`).

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

Seed a git identity into the sandbox HOME immediately after the override
above: a fresh `$SANDBOX` has no `.gitconfig`, so without this `bd init`'s
seed commit fails (exit 128, surfaced as a "failed to commit beads files"
warning) and the toy sprint's doer fails at its very first `git commit`.

```bash
git config --global user.name "integ-smoke-runner"
git config --global user.email "integ-smoke-runner@apra-fleet.invalid"
```

`REAL_HOME` preserves the runner's real (pre-sandbox) home directory for the
`## Test scenario` credential-provisioning step below -- it is the only place
downstream that still needs to read anything from outside `$SANDBOX`.

Before handing off to the test: verify `node dist/index.js status` exits 0
and reports the server listening on `18700`.

### Seed the sandbox beads DB (structural isolation, no bootstrap, no neutralize)

Adopts the e2e suite's own technique (see
`packages/apra-fleet-se/apra-pm/e2e/run-e2e.mjs`): seed the sandbox's local
beads DB straight from the git-committed `.beads/issues.jsonl` already
sitting in the clone above, rather than pulling from the real
`fleet-e2e-toy` Dolt remote. This wires every remote the sandbox will ever
talk to as sandbox-local throwaway BEFORE the local Dolt DB is created, so
the real `fleet-e2e-toy` remote URL is never adopted into the sandbox's git
or beads config.

First, point the sandbox clone's git `origin` at a sandbox-local bare
mirror of its own just-cloned content -- never the real `fleet-e2e-toy`
URL -- so `bd init`'s auto-provisioned Dolt remote (a side effect of the
next step) can only ever derive a sandbox-local remote:

```bash
TOY_REPO="$HOME/toy-repo"
GIT_MIRROR="$HOME/.apra-fleet-toy-origin.git"
rm -rf "$GIT_MIRROR"
git clone --bare "$TOY_REPO" "$GIT_MIRROR"
git -C "$TOY_REPO" remote set-url origin "file://$GIT_MIRROR"
```

Then seed the local beads DB from that git-tracked JSONL (no Dolt history
pulled from anywhere) via the guarded script below -- NOT `bd init` / `bd
dolt remote` by hand. It wires `sync.remote` to a second, dedicated
sandbox-local directory (kept separate from `$GIT_MIRROR` above, since
Dolt's `file://` remote writes its own storage into its target directory)
and hard-asserts every path resolves inside the sandbox root before
mutating anything, refusing outright (a named `[sandbox-seed guard]`
failure, zero mutations) if not: an earlier ad-hoc inline seed once
rewired the HOST repo's `sync.remote` to a sandbox path and aborted the
sprint when the sandbox was deleted -- this guard exists specifically to
make that impossible.

```bash
node "<repo-root>/scripts/sandbox-seed-beads.mjs" --sandbox-root "$HOME" --toy-repo "$TOY_REPO"
```

Verify none of the three remotes (`.beads/config.yaml`'s `sync.remote`,
the sandbox clone's `bd dolt remote list --json`, its `git remote get-url
origin`) ever resolve outside the sandbox root or reference
`fleet-e2e-toy`:

```bash
node "<repo-root>/scripts/check-sandbox-sync-remote.mjs" "$HOME/toy-repo"
```

## Reset

A faster alternative to Teardown + Setup between test runs in the same
session. It restores the toy repo and its beads state to pristine without
reinstalling or re-cloning, using the same e2e-pattern reset the e2e suite
uses on this toy repo (see `packages/apra-fleet-se/apra-pm/e2e/run-e2e.mjs`): reset the git
working tree to the sandbox-local mirror's `main`, then throw away and
re-seed the local beads DB from the git-tracked JSONL. The git `origin`
remote wired during `## Setup` (the sandbox-local `$GIT_MIRROR`) is
untouched by `git reset`/`git clean` -- remotes live in `.git/config`, not
the working tree -- so it stays sandbox-local across every Reset with no
re-wiring needed.

Before the git reset, this also kills any process still bound to the toy
app's dev-server port (3001, from `npm run start:test` / `cross-env
PORT=3001`): a prior abandoned attempt's background dev server (started by
that attempt's own toy-repo fleet-sprint Deploy phase) can otherwise
survive a Reset into the next attempt and cause `listen EADDRINUSE :::3001`
in the next Deploy phase. The kill step polls with a bounded
deadline (re-killing anything still bound each pass) and fails loud before
the git reset ever runs if the port is still occupied once the deadline
elapses -- a single fire-and-forget kill (the original approach) does not
reliably free a port a resumed/interrupted-attempt process is still
holding.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
DEADLINE=$(( $(date +%s) + 5 ))
while :; do
  PIDS="$(lsof -ti tcp:3001 2>/dev/null || true)"
  if [ -z "$PIDS" ]; then
    break
  fi
  kill -9 $PIDS 2>/dev/null || true
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    break
  fi
  sleep 1
done
if [ -n "$(lsof -ti tcp:3001 2>/dev/null || true)" ]; then
  echo "Reset: port 3001 is still bound after 5s of kill retries -- a stray" \
       "toy-app dev server survived cleanup. Manually run" \
       "'lsof -ti tcp:3001 | xargs kill -9' before continuing." >&2
  exit 1
fi
cd "$HOME/toy-repo"
git fetch origin
git reset --hard origin/main
git clean -fdx
node "<repo-root>/scripts/sandbox-seed-beads.mjs" --sandbox-root "$HOME" --toy-repo "$HOME/toy-repo" --mode reset
```

`--mode reset` re-seeds through the same `[sandbox-seed guard]` path
assertions as `## Setup` -- it is the ONLY sanctioned entry point for beads
seeding/rewiring in this playbook. It wipes the local Dolt DB and re-inits
it from the git-tracked `.beads/issues.jsonl` the `git reset --hard` above
just restored, so the canary `gh-toy-4ef` (`## Test scenario` step 2)
reappears with no separate re-provisioning step, and the re-init succeeds
every time with no `--discard-remote` needed.

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

The smoke test itself: what `regression-test-runner` does with the
environment `## Setup` provides. Marked informational because it applies
judgment and assertions (find the canary, run a sprint, verify the
outcome), not a fixed copy-paste block like the three lifecycle sections.
Every step is now shell-drivable -- no MCP tool is required to run the
scenario.

1. Register one member pointed at `$HOME/toy-repo`, using the isolated
   `HOME`/`APRA_FLEET_PORT` from Setup, via the `register-member` CLI
   subcommand (Bash, not the `register_member` MCP tool).

   ORDER MATTERS: run step 3a's credential FILE write BEFORE this
   registration. `register-member` launches the member's live interactive
   claude session immediately; if credentials do not exist yet, that
   session comes up "Not logged in" and stays that way -- writing the
   credentials file afterward does not heal it. Step 3b (member-scoped
   provisioning) requires the member to already be registered, so it runs
   after this step. Execute in this order: 3a -> 1 -> 2 -> 3b -> 4.

   ```bash
   node dist/index.js register-member --type local --name toy-doer \
     --path "$HOME/toy-repo" --llm claude
   ```
2. The canary is fixed, not looked up: `gh-toy-4ef`, the toy repo's minimal
   "Add a --version flag to the CLI" issue, labeled `integ-canary` in the
   git-committed `.beads/issues.jsonl` that `## Setup` (and `## Reset`) seed
   the sandbox's local beads DB from directly -- no Dolt-remote tag lookup,
   no `bd import` reconcile, and no self-provisioning fallback. Confirm it
   came through the seed and is open:

   ```bash
   cd "$HOME/toy-repo"
   bd show gh-toy-4ef
   ```

   If this fails (issue missing, or not open), the seeded fixture itself
   is broken -- fail loud per step 5/6 below rather than silently self-
   provisioning a replacement. The canary is deliberately the simplest
   possible issue: one obvious task, one obvious change, one objectively
   checkable outcome, so the toy sprint's planner has no scope to invent.
3. Provision LLM credentials for the `toy-doer` member -- without this,
   step 4's Planner dispatch fails auth. Use the CLI auth path documented
   in `docs/mcp-tools.md` ("apra-fleet auth (CLI)"), not the
   MCP `provision_llm_auth` flow: `regression-test-runner` has no MCP
   tools available (see "Adding new features to this test" below).

   **3a. Seed the persistent secret store (run BEFORE step 1's
   registration).** Resolve the token from the runner's own ambient Claude
   credential -- its `CLAUDE_CODE_OAUTH_TOKEN` env var if set, else
   `claudeAiOauth.accessToken` from its real, pre-sandbox
   `$REAL_HOME/.claude/.credentials.json` (see `REAL_HOME` in `## Setup`)
   -- store it as `secure.INTEG-TOY-DOER-TOKEN`, then also write it to a
   credentials file so step 1's interactive session comes up already
   logged in.

   NEVER include the refresh token: refresh-token rotation is
   server-side, so a sandbox process that refreshes with a COPIED refresh
   token invalidates the operator's real, live session -- this has
   expired the operator's login twice. Seed only
   `accessToken`/`expiresAt`/`scopes`.

   ```bash
   SECRET=""
   if [ -f "$REAL_HOME/.claude/.credentials.json" ]; then
     SECRET=$(node -e "
       const fs = require('fs');
       const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
       const o = c.claudeAiOauth;
       if (o && o.accessToken) {
         const { refreshToken, refreshTokenExpiresAt, ...probeSafe } = o;
         process.stdout.write(JSON.stringify(probeSafe));
       }
     " "$REAL_HOME/.claude/.credentials.json")
   fi
   if [ -z "$SECRET" ]; then
     SECRET="${CLAUDE_CODE_OAUTH_TOKEN:-}"
   fi
   if [ -z "$SECRET" ]; then
     echo "No ambient Claude credential found. Run '/login' in a real" \
          "session first, or export CLAUDE_CODE_OAUTH_TOKEN, then re-run" \
          "this step." >&2
     exit 1
   fi
   printf '%s' "$SECRET" | node dist/index.js secret --set INTEG-TOY-DOER-TOKEN --persist -y
   node dist/index.js auth --oauth --llm claude secure.INTEG-TOY-DOER-TOKEN
   ```

   **3b. Provision the member directly (run AFTER step 1's registration --
   it looks the member up by name). This is the path step 4's dispatch
   actually uses.**

   ```bash
   node dist/index.js auth --oauth --member toy-doer secure.INTEG-TOY-DOER-TOKEN
   ```

   Verify immediately, so a broken provisioning step fails loud here
   instead of after 5 wasted Planner dispatch retries in step 4:

   ```bash
   node "<repo-root>/scripts/check-toy-doer-credentials.mjs" toy-doer "$SANDBOX"
   ```
4. Run `apra-fleet workflow fleet-sprint` against the canary issue with
   `--max-cycles 1` and `--dispatch-timeout-s 900` (bounds a hung dispatch
   to 15 minutes instead of the default hour). No `--skip-dolt-push` flag
   needed: with the sandbox's `sync.remote` neutralized per `## Reset`,
   the engine's D-push pre-gate refuses to issue any `bd dolt push`. If
   the sprint plans more than a couple of tasks for the canary's
   single-flag scope, that is itself suspicious and worth a bug bead.
5. Assert the canary issue is now closed and the toy repo's sprint branch
   has a commit. Because the canary's deliverable is concrete, also
   verify it functionally when the canary is the "--version flag" issue:
   run the toy CLI with `--version` from the sprint branch and confirm it
   prints a version string and exits 0. If any assertion fails, fail
   loud: file a bug bead per "Reporting failures" below. Do not silently
   reset and move on -- this repo treats sprint-run surprises as signal.
6. Hand off to Teardown regardless of the assertion's outcome.

## Reporting failures

Regression failures are filed as STANDALONE, PARENT-LESS beads (`bd
create` WITHOUT `--parent`), titled `[regression][carry-over] <description>`:

```bash
bd create \
  --title="[regression][carry-over] <short description of failure>" \
  --description="Expected: <what should happen>
Actual: <what happened>
Test: <which test failed and its output>
Repro: <minimal steps to reproduce>" \
  --type=bug \
  --priority=<see priority rules below>
```

Priority rules:
- **P0**: system will not start or core path is completely broken
- **P1**: a sprint-goal requirement is explicitly not met
- **P2**: a requirement is partially met; degraded or inconsistent behaviour
- **P3**: quality, performance, or UX issue that does not block the core function

No `--parent` on purpose: the current sprint's completion gate walks its
scope tree via parent edges, so a parent-less bead is structurally
invisible to it. That is the point -- a regression failure is pre-existing
breakage, not new work item of the sprint that just ran, so it should
carry over to be picked up by a future sprint rather than blocking this
one's completion.

Before creating a new bug, search for duplicates across BOTH tags -- the
same underlying defect can surface here, or in `integ-test-playbook.md`'s
per-cycle pass, filed there under `[integ]` instead:
```bash
bd search "[carry-over]"
bd search "[integ]"
```
If an existing bug (either tag) covers the same failure, update its
description rather than creating a new one.

## Adding new features to this test

When fleet-sprint or the installer gains a capability that changes what "a
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
   subcommand, not the MCP tool). This matters because `regression-test-runner`
   has only [Read, Bash, Grep, Glob] tools and cannot call MCP tools -- if a
   step genuinely needs MCP, add a CLI entry point for it first rather than
   assuming the runner can reach the MCP tool.

For new-feature-specific test coverage that runs every cycle against the
sprint branch working tree (not once-per-sprint sandbox checks), see
`integ-test-playbook.md` instead.
