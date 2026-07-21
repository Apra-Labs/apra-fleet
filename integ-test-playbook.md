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

apra-fleet-eft.30 (second neutralize gap): the sed above only patches the
bd-level `sync.remote` YAML key. `bd bootstrap --yes` ALSO wires Dolt's OWN
internal remote (tracked separately from that YAML key) to the real
`fleet-e2e-toy` remote, so a per-cycle D-push can still target it even after
the YAML patch above -- the YAML key and Dolt's own remote wiring are two
independent hazards that both need neutralizing. Disarm the Dolt-level
remote too, immediately after the YAML step, using `bd dolt remote remove`
(read-only listing plus a name-scoped removal -- never `bd dolt push`).
Idempotent and safe to run even when no Dolt-level remote is configured (or
no beads DB exists yet in this clone): it is then a no-op.

```bash
TOY_REPO="$HOME/toy-repo"
if [ -d "$TOY_REPO/.beads" ]; then
  HAZARD_REMOTES=$(cd "$TOY_REPO" && bd dolt remote list --json 2>/dev/null | node -e "
    let d = '';
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => {
      try {
        for (const r of JSON.parse(d)) {
          if ((r.url || '').includes('fleet-e2e-toy') || (r.name || '').includes('fleet-e2e-toy')) {
            console.log(r.name);
          }
        }
      } catch (e) { /* no remotes configured -- nothing to print */ }
    });
  ")
  for name in $HAZARD_REMOTES; do
    (cd "$TOY_REPO" && bd dolt remote remove "$name") || true
  done
fi
```

apra-fleet-eft.31 (third neutralize gap): checks 1-3 above can all report
clean at snapshot time, yet the sandbox clone's OWN `git remote get-url
origin` still points at the real `fleet-e2e-toy` remote -- that is exactly
what `## Setup`'s `git clone https://github.com/Apra-Labs/fleet-e2e-toy
"$HOME/toy-repo"` step sets it to. Left as-is, this is a latent hazard: a
LATER `bd dolt` invocation can auto-provision a fresh Dolt-level remote
FROM this git origin ("Configured Dolt remote origin from git origin."),
re-arming exactly what the Dolt-level neutralize step above just cleared.
Neutralize the sandbox clone's git origin too, immediately after the
Dolt-level remote step, by rewriting it to point at a fetchable-but-fully-
isolated local git remote -- never `git push`, and never `file:///dev/null/...`
(apra-fleet-eft.47: that path is not a real repo, so any LEGITIMATE later
`git fetch origin` -- e.g. the auto-sprint engine's own `Ensure Sprint
Branch` phase, or this playbook's own `## Reset` step -- fails with exit
128 and aborts, even though nothing hazardous was ever at stake). Instead,
create a second, throwaway BARE clone of the sandbox toy-repo's own local
content (never the real `https://github.com/Apra-Labs/fleet-e2e-toy`) and
point `origin` at that: real, empty-of-any-network-remote, and fully
fetchable. Use `git remote set-url` rather than `git remote remove`: the
latter also deletes the clone's cached `origin/main` remote-tracking ref,
which would break the Verify step's `checkNoOutboundCommits` check (it
diffs `HEAD...origin/main` and needs that ref to still resolve locally).
The bare clone's path deliberately does not contain the `fleet-e2e-toy`
substring, so it also reads as non-hazard to
`checkGitOriginNotHazard` below:

```bash
TOY_REPO="$HOME/toy-repo"
NEUTRAL_ORIGIN="$HOME/.apra-fleet-neutralized-origin.git"
if [ -d "$TOY_REPO/.git" ]; then
  rm -rf "$NEUTRAL_ORIGIN"
  git clone --bare "$TOY_REPO" "$NEUTRAL_ORIGIN"
  (cd "$TOY_REPO" && git remote set-url origin "file://$NEUTRAL_ORIGIN") || true
fi
```

Idempotent and safe to run even when no `origin` remote is configured (or
no git repo exists yet in this clone): the bare clone is rebuilt fresh each
run (`rm -rf` before `clone --bare`), and the `set-url` no-ops with a
non-zero exit swallowed by `|| true` when there is no `origin` to rewrite.
`git clone --bare` here only reads from the local `$TOY_REPO` working
copy and writes to a new local directory -- it never contacts any network
remote, so no reachability to the real `fleet-e2e-toy` repo is introduced.

Verify: no uncommented line in `.beads/config.yaml` may reference
`fleet-e2e-toy` after the first step, Dolt's own remote list (`bd dolt
remote list --json` in the sandbox clone) must carry no remote pointing at
`fleet-e2e-toy` after the second step, the sandbox clone's `git remote
get-url origin` must not point at `fleet-e2e-toy` after the third step
(it must instead point at the local `$NEUTRAL_ORIGIN` bare clone),
`git fetch origin main` run from `$TOY_REPO` must exit 0 against that
neutralized origin (proving the sprint engine's own fetch can succeed),
AND the sandbox clone must have 0 commits ahead of `origin/main` (nothing
has actually reached the real remote -- still checkable locally because
`set-url` preserves the cached `origin/main` ref, and the fresh bare clone
shares the same history as of neutralize time).
`scripts/check-sandbox-sync-remote.mjs` (apra-fleet-eft.25.2, extended by
apra-fleet-eft.30.1 and apra-fleet-eft.31) asserts all four in one
shell-drivable, sandbox-only, read-only step -- it exits non-zero (and
prints a `FAIL` line) if any check fails, and exits 0 (`OK` lines) when all
four hold. Run it from `<repo-root>`, AFTER the git-origin neutralize step
above:

```bash
node "<repo-root>/scripts/check-sandbox-sync-remote.mjs" "$HOME/toy-repo"
```

(Its own unit tests, `tests/check-sandbox-sync-remote.test.ts`, exercise the
eft.25 hazard shape -- active `sync.remote` right after a bare `bd
bootstrap --yes` -- the eft.25.1 remedy shape -- `sync.remote` commented
out -- and (apra-fleet-eft.30.3) the eft.30 Dolt-level remote hazard/remedy
shapes, entirely against local fixtures, so they never touch the real
remote either.)

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

apra-fleet-eft.18.3 (stale bootstrap Dolt DB vs. git-tracked JSONL): `bd
bootstrap --yes` hydrates the sandbox's local Dolt DB from a SEPARATE sync
path (the real `fleet-e2e-toy` Dolt remote) rather than from the git-
tracked `.beads/issues.jsonl` the `git reset --hard` above just restored.
A maintainer can merge an `integ-canary` label into the JSONL (e.g. PR #96
labeling gh-toy-4ef) without that label having propagated into the synced
Dolt DB yet, so the tag lookup below can return zero matches even though
the git-tracked source of truth already carries the tag. Before falling
back to self-provisioning, the tag lookup in `## Test scenario` step 2
first reconciles the local Dolt DB from the git-tracked JSONL with `bd
import` (no file argument: it reads the configured `import.path`, which
defaults to `.beads/issues.jsonl`) -- an upsert into the LOCAL database
only, never a push -- and retries the label lookup once. `bd import`
never contacts the real Dolt remote, so this reconcile step is exactly as
isolated as the tag lookup it repairs.

If the tag lookup still returns zero matches after that reconcile (no
`integ-canary` issue present in the Dolt DB or the git-tracked JSONL, or
it was renamed/removed), the runner self-provisions a canary in the
sandbox's LOCAL beads DB only -- this never writes to or pushes the real
Dolt remote.

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
2. Find the canary issue by its `integ-canary` tag (`bd list
   --label=integ-canary --json` from `$HOME/toy-repo`). If the lookup
   returns a match, confirm it is open (`bd show <canary-id>`, where
   `<canary-id>` is whatever ID the tag lookup returned). If the lookup
   returns zero matches, first reconcile the local Dolt DB from the
   git-tracked JSONL (`bd import`, no file argument -- reads
   `.beads/issues.jsonl` by default, a local-only upsert, never a push;
   see the apra-fleet-eft.18.3 note under `## Reset`) and retry the label
   lookup once. If that retry still returns zero matches (no
   `integ-canary` tag in the Dolt DB or the git-tracked JSONL),
   self-provision the minimal "--version flag" canary in the sandbox's
   local beads DB per `## Reset` above (`bd create "Add a --version flag
   to the CLI" ... --label integ-canary`, no push) and use its ID as
   `<canary-id>`. No path in this step writes to
   `git+https://github.com/Apra-Labs/fleet-e2e-toy`.
3. Run `apra-fleet workflow auto-sprint` against the canary issue with
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
