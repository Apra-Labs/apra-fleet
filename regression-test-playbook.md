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

Because the path is fixed, two regression passes in flight against the same
machine at once would otherwise stomp on each other -- specifically, a
second run's `## Teardown` (`node dist/index.js stop` + `rm -rf $SANDBOX`)
can destroy a first run's sandbox while it is still mid-`## Setup` or
mid-`## Test scenario`. `## Setup` and `## Teardown` below guard against
this with a lock file living NEXT TO the sandbox (`$SANDBOX.lock` --
deliberately outside the directory `## Teardown` deletes, so the lock is
never a casualty of the cleanup it gates), via `scripts/sandbox-lock.mjs`:
- `## Setup` acquires the lock before touching anything (mkdir/install/
  clone); if another live run already holds it, Setup fails loud with a
  `sandbox busy` message and a non-zero exit instead of proceeding.
- `## Teardown` only `rm -rf`s the sandbox (and releases the lock) if it can
  prove it owns it -- a live lock naming a PID other than this sandbox's own
  fleet server is left untouched.
- A single normal `## Setup` -> `## Test scenario` -> `## Teardown` pass is
  unaffected: the lock is acquired at the start and released at the end, as
  before.

**If `## Setup`'s busy-check refuses (non-zero exit), STOP the whole pass
right there.** Do not proceed to `## Test scenario`, and do not run
`## Teardown` either: this run never acquired the lock, so it has nothing of
its own to tear down, and `## Teardown`'s ownership check -- which compares
the lock's recorded PID against the sandbox's own currently-running server --
cannot by itself distinguish "a stray/misfired Teardown call for a run that
never actually owned this sandbox" from "this run's own legitimate Teardown"
once another live run's Setup has since completed the hand-off to its own
server PID. The busy-check at the start of `## Setup` is what actually
prevents that ambiguity from ever arising -- respect its exit code.

Conventions used below:
- Sandbox root: `~/temp/.apra-fleet-tests` (`$HOME/temp/.apra-fleet-tests`
  on POSIX, `%USERPROFILE%\temp\.apra-fleet-tests` on Windows).
- Scratch port: `18700` (`APRA_FLEET_PORT`) -- the fleet MCP server (`node
  dist/index.js start`). Kept away from the default MCP server port `7523`,
  viewer ports starting at `8081` (DEFAULT_SPAWNER_BASE_PORT in
  packages/apra-fleet-se/src/supervisor/spawner.mjs), and the dolt settle
  port range `13300-13400` (DEFAULT_PORT_RANGE in
  packages/apra-fleet-se/fleet-sprint/dolt-settle.mjs).
- Supervisor scratch port: `18701` (`SUPERVISOR_PORT` below) -- the
  fleet-sprint supervisor (`packages/apra-fleet-se/bin/serve.mjs`),
  distinct from the fleet MCP server's `18700` above and from every range
  in the previous bullet.
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
- `Bash(node:*)` -- covers the sandbox lock's
  `node "<repo-root>/scripts/sandbox-lock.mjs" acquire|mark-server-started|
  release` calls in `## Setup` and `## Teardown`, and every other
  `node "<repo-root>/scripts/*.mjs"` helper this playbook invokes
  (`kill-port.mjs`, `reap-sandbox-dolt.mjs`, `sandbox-seed-beads.mjs`,
  `check-sandbox-sync-remote.mjs`, `check-toy-doer-credentials.mjs`). A
  relative-prefix entry like `Bash(node scripts/sandbox-lock.mjs *)` does
  NOT cover any of these: the invocations use the absolute `<repo-root>/...`
  form (see Conventions above), so only a broader `Bash(node:*)`-class
  entry satisfies it. Note: `kill-port.mjs`/`reap-sandbox-dolt.mjs` in turn
  spawn their own subprocesses internally (`netstat`/`taskkill` on Windows,
  `lsof`/`ps` on POSIX) -- those do NOT need their own permission entries,
  the same way `sandbox-lock.mjs`'s and `check-sandbox-sync-remote.mjs`'s
  own internal `git`/`bd` calls never have: the permission layer gates this
  playbook's own `Bash` tool calls, not what a permitted process spawns
  internally.
- `Bash(git clone *)`
- `Bash(git -C ~/temp/.apra-fleet-tests* *)`
- `Bash(node scripts/run-integ-suites.mjs *)` (for the
  "Run the apra-fleet-se suite against real bd" section only)
- `Bash(npm run test:slow*)` (same section, the slow-lane run)
- `Bash(tail:*)` (same section -- reading the persisted slow-lane verdict
  after an interrupted shell, `apra-fleet-f28t.1`)
- `Bash(bd *)` (for "Reporting failures" below -- `bd search` to dedupe and
  `bd create` to file the parent-less carry-over beads; also the sandbox
  `bd show`/`bd dolt` steps in `## Setup` and `## Test scenario`)
- `Bash(curl:*)` -- drives the supervisor's HTTP API (`POST /api/sprints`,
  `GET /api/sprints/:id`, `GET /api/members`, `POST /api/shutdown`) in
  `## Setup`, `## Test scenario`, and `## Teardown`.
- `Bash(kill:*)` -- covers the supervisor-boot verification and stop steps'
  own direct `kill -0`/`kill -9` calls (the port and dolt-sql-server kill
  loops now run through the `kill-port.mjs`/`reap-sandbox-dolt.mjs` helpers
  above, already covered by `Bash(node:*)`).

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

apra-fleet-f28t.1: redirect combined stdout+stderr to a log file instead of
piping through `tail` -- a bare pipe leaves nothing persisted if the
background shell running this command is interrupted, so an ~8-minute lane's
pass/fail verdict becomes unrecoverable. The log lives at
`$HOME/temp/.apra-fleet-tests/test-slow-lane.log` -- deliberately the SAME
throwaway root the smoke-test sandbox below uses (`$SANDBOX`, see `## Setup`)
even though this lane itself needs no sandbox, so a later `## Teardown`'s
`rm -rf "$SANDBOX"` sweeps this log up too as part of its normal cleanup; if
this pass's smoke-test portion is skipped, remove it by hand like any other
throwaway artifact under that path (`rm -f
"$HOME/temp/.apra-fleet-tests/test-slow-lane.log"`).

```bash
mkdir -p "$HOME/temp/.apra-fleet-tests"
SLOW_LANE_LOG="$HOME/temp/.apra-fleet-tests/test-slow-lane.log"
{ npm run test:slow --workspace=@apralabs/apra-fleet-se; echo "test:slow exit=$?"; } > "$SLOW_LANE_LOG" 2>&1
```

apra-fleet-f28t.1 (reopen fix): the exit marker MUST be inside the same
redirected group as the `npm run test:slow` command above -- if the `echo`
is placed after a `> "$SLOW_LANE_LOG"` redirect that only wraps the `npm
run` call, the marker is written to the terminal, not the file, and an
interrupted shell (the exact scenario this recovery path exists for) never
runs the `echo` at all, making the "recovered pass verdict" branch below
undocumented-but-impossible. The `{ ...; echo ...; }` grouping above
redirects both.

If this command's shell is interrupted (session restart, killed background
shell) before it completes, do NOT re-run the lane -- re-running risks
piling up a second orphaned process on top of the first. Instead, read the
verdict directly from the persisted log once the earlier process has
actually stopped: `tail -n 80 "$HOME/temp/.apra-fleet-tests/test-slow-lane.log"`
(`tail` is covered by the `Bash(tail:*)` permissions entry above) and treat
`test:slow exit=0` at the tail of the file as the recovered pass verdict, a
nonzero value as a recovered failure verdict, and the file's absence (or a
truncated file with no exit line) as "still running or was never
recoverable -- report status, do not fabricate a verdict."

An interrupted run's orphaned `npm run test:slow` / `node --test` child
processes are a KNOWN harness gap (apra-fleet-f28t): `taskkill`, `kill -9`,
and `wmic process ... delete` (and even the read-only `wmic process ...
get`) have all been observed denied by the auto-mode permission classifier.
Per this repo's CLAUDE.md, a permission block must be SURFACED, not routed
around -- do NOT author a wrapper script, alternate binary, or any other
workaround whose purpose is to reap those processes past the block. Report
any such orphaned process to the operator as a surfaced permission block
and leave the cleanup to them out of band; apra-fleet-f28t stays open for
that half.

To PROVE a before/after timing claim against a pre-fix commit (not just
assert one from memory), see `packages/apra-fleet-se/test/INTEG-SUITE.md`'s
"Reproducing on a pre-fix commit" section -- a `git worktree` at the old SHA
does not work here (no workspace `node_modules` of its own), the documented
recipe is a scratch clone plus its own `npm install`.

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

# Records this run's own start time, sibling to the sandbox (like the lock
# file below) so a later '## Teardown' can still read it after "$HOME" is
# deleted. Consumed by the dolt-sql-server reap's recency bound (see
# '## Teardown').
SETUP_STARTED_AT=$(date +%s)
echo "$SETUP_STARTED_AT" > "$SANDBOX.setup_started_at"

# Busy-check: claim the sandbox lock BEFORE touching anything below. Fails
# loud ('sandbox busy', non-zero exit) if another live run already holds it,
# instead of racing/clobbering it. sandbox-lock.mjs records ITS OWN
# process.ppid (this Setup shell's real, native OS pid) rather than reading
# $$ -- see scripts/sandbox-lock.mjs's file header (apra-fleet-5co8.39) for
# why $$ is unsafe under Git Bash on Windows.
node "<repo-root>/scripts/sandbox-lock.mjs" acquire "$SANDBOX" || exit 1

export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
mkdir -p "$HOME"
cd "<repo-root>"
node dist/index.js install

# Stale-process guard: kill any process still bound to the sandbox's own
# scratch port (18700) before starting the server. Without this, a previous
# run's crashed or interrupted 'node dist/index.js' left bound to 18700
# causes this Setup's 'start' to hit EADDRINUSE; the real server silently
# rebinds to an OS-assigned port on EADDRINUSE instead of failing loud (see
# src/services/http-transport.ts / src/index.ts), which can leave the
# sandbox listening on the wrong port with no obvious error.
#
# scripts/kill-port.mjs (not a raw lsof-based loop) does the actual probe +
# kill: it is portable to Windows Git Bash (netstat/taskkill, no lsof), and
# hard-fails naming the missing probe tool instead of silently treating "I
# could not check" as "the port is free" -- a plain
# 'lsof -ti tcp:18700 2>/dev/null || true' loop reads as a pass on any host
# without lsof, which is exactly the false-success failure mode this
# replaces. Fails loud (non-zero exit) if the port is still occupied once
# the deadline elapses, or if this host has no supported probe tool.
node "<repo-root>/scripts/kill-port.mjs" 18700 "sandbox scratch port 18700" 5000 || exit 1

# Same stale-process guard, but for the toy app's dev-server port (3001,
# from 'npm run start:test' / 'cross-env PORT=3001'). This mirrors the
# bounded-retry kill-loop '## Reset' already uses for 3001: a prior
# interrupted run's toy-repo Deploy phase can leave its dev server bound to
# 3001, which would otherwise survive into this run's own '## Test
# scenario' and make its Deploy phase fail with 'listen EADDRINUSE :::3001'.
# Unlike the 18700 case the toy dev server just dies rather than silently
# rebinding, but this guard still fails loud (non-zero exit) instead of
# proceeding, matching the shape of every other port guard in this
# playbook. Runs before 'node dist/index.js start' like the 18700 guard
# above, and after the sandbox lock is acquired.
node "<repo-root>/scripts/kill-port.mjs" 3001 "toy app dev-server port 3001" 5000 || exit 1

node dist/index.js start

# Re-point the lock at the sandbox's own long-lived fleet-server PID (not
# this Setup shell, which exits once this code block finishes) -- the
# server stays up through ## Test scenario until ## Teardown stops it, so
# this is what keeps the lock a true liveness signal for the rest of the run.
node "<repo-root>/scripts/sandbox-lock.mjs" mark-server-started "$SANDBOX" || exit 1

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

Before handing off to the test: verify the server is actually bound to the
sandbox's scratch port. `node dist/index.js status` exiting 0 alone is NOT
sufficient here -- the server silently rebinds to an OS-assigned port on
EADDRINUSE instead of failing loud (see the stale-process guard comment
above and `src/services/http-transport.ts` / `src/index.ts`), so a runner
that only checks the exit code could hand off against the wrong instance
without ever noticing. Read `server.json` directly (the authoritative
source `status` itself reads -- `SERVER_INFO_PATH` in `src/paths.ts`,
`$HOME/.apra-fleet/data/server.json` once `HOME` is overridden to
`$SANDBOX` above) and assert its recorded port is exactly `18700`, failing
loud (non-zero exit, clear message) otherwise:

```bash
node dist/index.js status || {
  echo "Setup: 'node dist/index.js status' exited non-zero -- server did not" \
       "come up." >&2
  exit 1
}
ACTUAL_PORT="$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const p = path.join(process.env.HOME, ".apra-fleet", "data", "server.json");
  const info = JSON.parse(fs.readFileSync(p, "utf8"));
  process.stdout.write(String(info.port ?? ""));
')"
if [ "$ACTUAL_PORT" != "18700" ]; then
  echo "Setup: server.json reports port '$ACTUAL_PORT', not the expected" \
       "sandbox scratch port 18700 -- the server likely silently rebound" \
       "after finding 18700 occupied (EADDRINUSE). Refusing to hand off to" \
       "the test against the wrong instance." >&2
  exit 1
fi
```

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

### Boot the fleet-sprint supervisor

The toy sprint runs THROUGH a real supervisor instance
(`packages/apra-fleet-se/bin/serve.mjs`), not the direct `apra-fleet
workflow fleet-sprint` CLI, so this smoke test exercises the same
reservation-ledger / member-dispatch / HTTP-API path a real production
sprint launch actually uses (see `fleet-supervisor` skill guidance).

Isolate the supervisor's own service data directory from any real,
already-running supervisor on this machine -- `FLEET_SE_DATA_DIR` (read by
`ledger.mjs`/`history.mjs`/`spawner.mjs`) is NOT covered by the `HOME`
override above, so it must be set explicitly:

Note: by this point in `## Setup`, `HOME` (and `USERPROFILE`) are already
overridden to the sandbox root (see the `export HOME="$SANDBOX"` earlier in
this section) -- every command below uses `$HOME`, never `$SANDBOX`
directly, matching the convention the rest of `## Setup` already uses
(e.g. `GIT_MIRROR="$HOME/..."` above).

```bash
export SUPERVISOR_PORT=18701
export FLEET_SE_DATA_DIR="$HOME/.apra-fleet-se-data"
# Owner-scopes this instance's dolt-orphan-sweep to the sandbox (see the
# hazard note below). Every member this supervisor can enumerate lives
# under the sandbox HOME, so its ephemeral dolt sql-servers do too.
export FLEET_SE_SWEEP_OWNER_DATA_DIR="$HOME"
mkdir -p "$FLEET_SE_DATA_DIR"
```

**dolt-orphan-sweep cross-instance hazard -- now fixed in code, and still
time-bounded as belt-and-braces.** The supervisor's `dolt-orphan-sweep`
seam (`packages/apra-fleet-se/src/supervisor/dolt-orphan-sweep.mjs`) scopes
`listMembers()` to whatever fleet server this process's `HOME` resolves to
(the sandbox's own, per the override above -- so it will only ever
enumerate `toy-doer`), but its actual probe/kill command USED to be a
MACHINE-WIDE process scan filtered only by port range (`13300-13400`) and
process age (`DEFAULT_MAX_AGE_MS`, 10 minutes) -- NOT by which supervisor
instance owns the process. That is mitigation option (a) from the bead, and
it has now LANDED as a code-level scope fix: `buildSweepCommand()` takes an
owner data-dir prefix, and `bin/serve.mjs` wires it from the
`FLEET_SE_SWEEP_OWNER_DATA_DIR` export above. With it set, BOTH shell
families (the win32 PowerShell `-like` clause and the POSIX `awk
index($0, owner)` clause) additionally require the candidate's
`--data-dir` to sit under the sandbox root, so this instance cannot kill a
different, live supervisor's ephemeral server. The seam is opt-in on
purpose: the ephemeral server's `--data-dir` is the MEMBER's beads data dir,
which for a real remote member has no relation to the supervisor's own data
dir, so scoping it unconditionally would silently turn the production sweep
into a no-op.

Three residual limits keep the old time bound worth having:

* Under `dolt-settle.mjs`'s `unknown` status-parse fallback the spawned
  command line carries only the RELATIVE default data dir, so it matches no
  prefix at all. That direction is fail-safe -- the sweep skips rather than
  kills a foreign process -- but it means the owner-scoped sweep is INERT
  for that case, exactly the blind spot `scripts/reap-sandbox-dolt.mjs`
  covers in `## Teardown` with a recency bound instead.
* The scope fix depends on the export above actually being in this
  supervisor's environment; a run that boots the supervisor by hand without
  it is back to the machine-wide scan.
* `FLEET_SE_SWEEP_OWNER_DATA_DIR="$HOME"` under Git Bash is an MSYS-style
  POSIX path (e.g. `/c/Users/x/...`), and `bin/serve.mjs` used to pass it
  straight to Node's `path.resolve()` on win32, which mangled it into a
  nonexistent path (`/c/Users/x` -> `C:\c\Users\x`) and made this instance's
  owner scope silently match nothing while still logging a confident scope
  claim. `bin/serve.mjs` now normalizes an MSYS-style path to its native
  Windows form before resolving it and warns loudly if the resolved prefix
  does not exist on disk, but a future direct caller of `path.resolve()` on
  an MSYS path bypassing that normalization would reintroduce the same
  silent-inert failure mode.

So the time bound stays, now as belt-and-braces rather than the only
defence: the sweep runs on EVERY tick of its `DEFAULT_SWEEP_INTERVAL_MS`
(5-minute) timer once started, with no immediate first pass -- so as long
as this sandbox's supervisor process never lives to see a single tick, the
sweep never runs at all during this test. `SUPERVISOR_STARTED_AT` below
records the boot time, and this bound is HARD-ENFORCED, not merely
asserted: `## Test scenario` step 4's sprint poll loop stops polling and
shuts the supervisor down itself once uptime reaches 280s (before the
300s/5-minute tick), rather than relying on its 360s poll deadline plus the
~30s boot time never crossing 300s in practice (they can -- 30s boot + 360s
poll is ~6.5 minutes). That 280s stop is deliberately KEPT as-is; it also
bounds how long a stuck toy sprint may run. `## Teardown`'s
`SUPERVISOR_UPTIME >= 300` check remains as a belt-and-suspenders
after-the-fact confirmation.

**Stale-process guard: kill any process still bound to $SUPERVISOR_PORT
(18701) before starting.** Mirrors the 18700 guard above and the `## Reset`
guard for port 3001: on `EADDRINUSE` the supervisor's `server.once('error',
...)` handler rejects `start()` rather than silently rebinding
(`packages/apra-fleet-se/src/supervisor/server.mjs`), but a plain
readiness-loop against the port cannot tell "our new process bound the
port" apart from "a leftover supervisor from a prior crashed/interrupted
run is still answering here" -- the identity check below closes that gap
for the boot itself, but only if the port is free to bind on first try.

```bash
node "<repo-root>/scripts/kill-port.mjs" "$SUPERVISOR_PORT" "supervisor port $SUPERVISOR_PORT" 5000 || exit 1

node "<repo-root>/packages/apra-fleet-se/bin/serve.mjs" --port "$SUPERVISOR_PORT" \
  > "$HOME/supervisor.log" 2>&1 &
SUPERVISOR_PID=$!
SUPERVISOR_STARTED_AT=$(date +%s)
# Marker files live NEXT TO the sandbox (mirrors "$SANDBOX.lock"'s placement
# above), not inside it -- so a later '## Teardown' can still find them even
# though it deletes "$HOME" (== "$SANDBOX" here) wholesale.
echo "$SUPERVISOR_PID" > "$SANDBOX.supervisor.pid"
echo "$SUPERVISOR_STARTED_AT" > "$SANDBOX.supervisor.started_at"

# Identity-checked readiness: GET /api/health returns the answering
# process's OWN pid (server.mjs), so require it to match the NEWLY-BOOTED
# process's own pid rather than accepting "something answered" on the
# port. This is compared against the pid server.mjs itself logs on boot
# ("[supervisor] listening on http://localhost:<port> (pid N)",
# server.mjs), NOT against $SUPERVISOR_PID/$! -- under MSYS/MinGW bash
# (Git Bash on Windows, which this playbook targets), $! is a
# bash-internal pid that never equals the native process's own
# process.pid (confirmed: a backgrounded node process reported $!=10954
# while its own process.pid was 117404), so comparing HEALTH_PID to
# $SUPERVISOR_PID can never match there and this readiness loop would
# always time out and kill the supervisor it just booted. Parsing the
# boot log for the process's own reported pid keeps both sides of the
# comparison native, which is what makes it identity-safe: a plain
# 'curl -sf .../api/members' readiness loop would false-positive against a
# foreign supervisor already bound to this port -- our process would then
# die (EADDRINUSE) while the test proceeds to drive someone else's
# supervisor, whose HOME/FLEET_SE_DATA_DIR are the real machine's, not this
# sandbox's, and whose uptime already exceeds the dolt-orphan-sweep's
# 5-minute tick. `kill -0`/`kill -9` below still use $SUPERVISOR_PID (the
# MSYS pid) -- that IS the correct pid space for bash's own liveness/kill
# builtins, even though it is the wrong pid space for this identity check.
DEADLINE=$(( $(date +%s) + 30 ))
while :; do
  if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    echo "Setup: supervisor process exited before coming up -- see" \
         "$HOME/supervisor.log." >&2
    rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
    exit 1
  fi
  LOG_PID="$(grep -o '(pid [0-9]*)' "$HOME/supervisor.log" 2>/dev/null | tail -n1 | grep -o '[0-9]*' || true)"
  HEALTH="$(curl -sf "http://localhost:$SUPERVISOR_PORT/api/health" 2>/dev/null || true)"
  if [ -n "$HEALTH" ] && [ -n "$LOG_PID" ]; then
    HEALTH_PID="$(node -e '
      try { process.stdout.write(String(JSON.parse(process.argv[1]).pid)); } catch { /* empty */ }
    ' "$HEALTH")"
    if [ "$HEALTH_PID" = "$LOG_PID" ]; then
      break
    fi
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "Setup: supervisor did not answer with its own pid on port" \
         "$SUPERVISOR_PORT within 30s (possibly a foreign process already" \
         "held it) -- see $HOME/supervisor.log." >&2
    kill -9 "$SUPERVISOR_PID" 2>/dev/null || true
    rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
    exit 1
  fi
  sleep 1
done
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

**Reset also stops and reboots the sandbox supervisor.** `## Setup`'s
dolt-orphan-sweep mitigation is a per-process uptime bound (the sweep only
fires once its 5-minute-tick timer has run at least once), so a supervisor
that survives across `## Reset` into a second test run in the same session
accumulates uptime across BOTH runs -- a Reset-and-rerun can push a
supervisor that individually looked fine each run past the 5-minute tick
without either run's own Teardown ever seeing it. Rebooting on every Reset
resets `SUPERVISOR_STARTED_AT` (and hence the uptime clock `## Teardown`
checks) so the accepted mitigation actually holds across repeated
Reset-and-rerun cycles, not just a single Setup-to-Teardown run. This
reuses the same identity-checked stop as `## Teardown` and the same
identity-checked boot as `## Setup` -- see those sections for the
rationale behind each check.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700

SUPERVISOR_PORT="${SUPERVISOR_PORT:-18701}"
if [ -f "$SANDBOX.supervisor.pid" ]; then
  OLD_SUPERVISOR_PID="$(cat "$SANDBOX.supervisor.pid")"
  curl -sf -X POST "http://localhost:$SUPERVISOR_PORT/api/shutdown" > /dev/null 2>&1 || true
  DEADLINE=$(( $(date +%s) + 10 ))
  while kill -0 "$OLD_SUPERVISOR_PID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      kill -9 "$OLD_SUPERVISOR_PID" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
fi
# scripts/kill-port.mjs: portable to Windows Git Bash (no lsof dependency)
# and hard-fails naming the missing probe tool rather than silently passing
# -- see the same guard's comment in `## Setup` for the full rationale.
node "<repo-root>/scripts/kill-port.mjs" 3001 "toy app dev-server port 3001" 5000 || exit 1
node "<repo-root>/scripts/kill-port.mjs" "$SUPERVISOR_PORT" "supervisor port $SUPERVISOR_PORT" 5000 || exit 1
cd "$HOME/toy-repo"
git fetch origin
git reset --hard origin/main
git clean -fdx
node "<repo-root>/scripts/sandbox-seed-beads.mjs" --sandbox-root "$HOME" --toy-repo "$HOME/toy-repo" --mode reset

node "<repo-root>/packages/apra-fleet-se/bin/serve.mjs" --port "$SUPERVISOR_PORT" \
  > "$HOME/supervisor.log" 2>&1 &
SUPERVISOR_PID=$!
SUPERVISOR_STARTED_AT=$(date +%s)
echo "$SUPERVISOR_PID" > "$SANDBOX.supervisor.pid"
echo "$SUPERVISOR_STARTED_AT" > "$SANDBOX.supervisor.started_at"

# See '## Setup's identity-checked readiness loop for why HEALTH_PID is
# compared to a boot-log-parsed native pid (LOG_PID), not to
# $SUPERVISOR_PID/$! -- the latter is an MSYS-internal pid under Git Bash
# and never equals the native process's own reported pid.
DEADLINE=$(( $(date +%s) + 30 ))
while :; do
  if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    echo "Reset: rebooted supervisor process exited before coming up --" \
         "see $HOME/supervisor.log." >&2
    rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
    exit 1
  fi
  LOG_PID="$(grep -o '(pid [0-9]*)' "$HOME/supervisor.log" 2>/dev/null | tail -n1 | grep -o '[0-9]*' || true)"
  HEALTH="$(curl -sf "http://localhost:$SUPERVISOR_PORT/api/health" 2>/dev/null || true)"
  if [ -n "$HEALTH" ] && [ -n "$LOG_PID" ]; then
    HEALTH_PID="$(node -e '
      try { process.stdout.write(String(JSON.parse(process.argv[1]).pid)); } catch { /* empty */ }
    ' "$HEALTH")"
    if [ "$HEALTH_PID" = "$LOG_PID" ]; then
      break
    fi
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "Reset: rebooted supervisor did not answer with its own pid on" \
         "port $SUPERVISOR_PORT within 30s -- see $HOME/supervisor.log." >&2
    kill -9 "$SUPERVISOR_PID" 2>/dev/null || true
    rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
    exit 1
  fi
  sleep 1
done
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

# Stop the supervisor FIRST, before the sandbox-lock release below and
# before the fleet MCP server further down -- a concurrent run's Setup
# readiness loop is now identity-checked (see '## Setup'), but stopping the
# outgoing supervisor before releasing the lock still closes the window
# where the lock is free (signalling "safe to acquire") while port 18701 is
# still held by this run's dying instance; releasing the lock first would
# let a new run's kill-port.mjs guard race this shutdown. This also
# confirms the dolt-orphan-sweep time bound documented in ## Setup actually
# held for this run (a loud warning, not a failure: the sweep is now
# owner-scoped in code to $FLEET_SE_SWEEP_OWNER_DATA_DIR -- see ## Setup's
# hazard note -- and it only ACTS if it also finds an aged dolt sql-server
# in its port range, which this sandbox's own dolt processes never are by
# the time we get here).
if [ -f "$SANDBOX.supervisor.pid" ] && [ -f "$SANDBOX.supervisor.started_at" ]; then
  SUPERVISOR_PID="$(cat "$SANDBOX.supervisor.pid")"
  SUPERVISOR_STARTED_AT="$(cat "$SANDBOX.supervisor.started_at")"
  SUPERVISOR_PORT="${SUPERVISOR_PORT:-18701}"
  SUPERVISOR_UPTIME=$(( $(date +%s) - SUPERVISOR_STARTED_AT ))
  if [ "$SUPERVISOR_UPTIME" -ge 300 ]; then
    echo "Teardown: supervisor was up for ${SUPERVISOR_UPTIME}s (>= the" \
         "dolt-orphan-sweep's 5-minute tick) -- the accepted time-bound" \
         "mitigation from ## Setup did not hold this run. File this per" \
         "'## Reporting failures' below as a carry-over bug (not just slow" \
         "-- the sweep may have run, and its code-level owner scope only" \
         "holds if FLEET_SE_SWEEP_OWNER_DATA_DIR was exported for this" \
         "supervisor)." >&2
  fi
  curl -sf -X POST "http://localhost:$SUPERVISOR_PORT/api/shutdown" > /dev/null 2>&1 || true
  DEADLINE=$(( $(date +%s) + 10 ))
  while kill -0 "$SUPERVISOR_PID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      kill -9 "$SUPERVISOR_PID" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  # Primary evidence the port is free: the recorded PID is gone AND the API
  # no longer answers -- portable to every host, unlike an lsof-ti probe
  # (Git Bash/Windows has no lsof; see the KB note this playbook's earlier
  # port-kill loops already run into). lsof below is best-effort only, run
  # if present, never the sole basis for a pass/fail verdict.
  DEADLINE=$(( $(date +%s) + 5 ))
  while kill -0 "$SUPERVISOR_PID" 2>/dev/null || curl -sf "http://localhost:$SUPERVISOR_PORT/api/members" > /dev/null 2>&1; do
    kill -9 "$SUPERVISOR_PID" 2>/dev/null || true
    if command -v lsof > /dev/null 2>&1; then
      PIDS="$(lsof -ti tcp:$SUPERVISOR_PORT 2>/dev/null || true)"
      [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      break
    fi
    sleep 1
  done
  if kill -0 "$SUPERVISOR_PID" 2>/dev/null || curl -sf "http://localhost:$SUPERVISOR_PORT/api/members" > /dev/null 2>&1; then
    echo "Teardown: the supervisor (pid $SUPERVISOR_PID, port $SUPERVISOR_PORT)" \
         "is still alive/answering after stop + 5s of kill retries." \
         "Manually confirm it is stopped before continuing." >&2
    exit 1
  fi
  rm -f "$SANDBOX.supervisor.pid" "$SANDBOX.supervisor.started_at"
fi

# Ownership check: only rm -rf the sandbox further down if this Teardown
# can prove it owns the lock -- i.e. the lock currently names THIS
# sandbox's own fleet-server PID (or is missing/stale, meaning there is
# nothing live to protect). A lock naming some OTHER live PID means a
# different run currently owns this sandbox; refuse loud instead of
# destroying it. Runs AFTER the supervisor stop above (see that block's
# comment for why) but still BEFORE 'stop' below so it reads the
# still-live server.json to compare against.
node "<repo-root>/scripts/sandbox-lock.mjs" release "$SANDBOX" || exit 1

node dist/index.js stop

# Detached-dolt-sql-server reap: 'node dist/index.js stop' only stops the
# fleet server process itself -- it does NOT (and by design cannot) reap a
# `dolt sql-server` that fleet-sprint/dolt-settle.mjs may have spawned during
# Dolt conflict resolution in the toy sprint (see
# packages/apra-fleet-se/fleet-sprint/docs/dolt-sync-redesign.md Part 3.3).
# settleDoltConflicts() spawns that server genuinely DETACHED
# (setsid/nohup on POSIX, WMI on Windows --
# see dolt-settle.mjs's spawnEphemeralServer) specifically so it survives
# its parent process, and tears it down itself in a real `finally`
# (killServerAndVerify) once settle completes -- so under the smoke test's
# normal pass/fail completion, by the time this Teardown runs, settle has
# already reaped its own server and this step finds nothing. The one gap
# `stop` cannot close is the orchestrator (fleet server) process itself
# dying mid-settle before that `finally` runs; the supervisor's own
# dolt-orphan-sweep (packages/apra-fleet-se/src/supervisor/dolt-orphan-
# sweep.mjs) is the long-term backstop for that, but its 5-minute interval
# and 10-minute max-age threshold are far longer than this smoke test's
# window, so it cannot be relied on to run before the 'rm -rf' below.
#
# scripts/reap-sandbox-dolt.mjs (not a raw pgrep-based loop) closes that
# window for the sandbox: it is portable to Windows Git Bash (no pgrep
# dependency, hard-fails naming the missing probe tool instead of silently
# passing), and it also covers dolt-settle's RELATIVE-data-dir fallback
# (dolt-settle.mjs's resolveDoltStatus can fall back to the relative default
# 'beads/embeddeddolt', in which case the spawned command line carries no
# absolute sandbox path for a plain 'pgrep -f "dolt.*sql-server.*$SANDBOX"'
# to match) by ALSO matching that relative default when the process started
# at/after this run's own '## Setup' timestamp -- see the script's own
# header comment for why that recency bound is required (a bare match on
# the relative default alone would recreate the machine-wide-kill hazard
# documented against dolt-orphan-sweep.mjs).
SETUP_STARTED_AT="$(cat "$SANDBOX.setup_started_at" 2>/dev/null || echo 0)"
node "<repo-root>/scripts/reap-sandbox-dolt.mjs" --sandbox "$SANDBOX" --since "$SETUP_STARTED_AT" --deadline-ms 5000 || exit 1
rm -f "$SANDBOX.setup_started_at"

# No separate guard reaps the toy app's dev-server port (3001) here:
# 'rm -rf "$SANDBOX"' below does not depend on 3001 being free (the dev
# server, if still alive, has nothing left to read or write once the
# sandbox directory is gone), and the next run's own '## Setup' stale-
# process guard closes the port before it is needed again. Leaving a stray
# dev server running between runs is a hygiene gap, not a correctness one,
# so it is intentionally left to the next '## Setup'/'## Reset' to clear
# rather than duplicated here.
rm -rf "$SANDBOX"
```

`tests/regression-playbook-sandbox-lifecycle.test.ts` is an automated,
pass/fail regression suite for the Setup busy-check, the Setup/
Teardown stale-port guards above, Teardown's dolt-sql-server reap, and the
cross-instance time-bound mitigation documented above -- run it via `npx
vitest run tests/regression-playbook-sandbox-lifecycle.test.ts` whenever this
sandbox lifecycle changes. It drives the real `scripts/sandbox-lock.mjs`,
`scripts/kill-port.mjs`, and `scripts/reap-sandbox-dolt.mjs` CLIs/functions
against throwaway sandboxes and OS-assigned ports; it does not run the live
Setup/Teardown sequence end to end (no real `node dist/index.js
install/start`, no network clone) -- that remains this file's job, run for
real by `regression-test-runner`.

`tests/regression-playbook-port3001-guard.test.ts` is the same kind of
automated, pass/fail regression suite, scoped to the toy app's dev-server
port (3001) guard in `## Setup` above and the documented Teardown rationale
for not separately reaping it -- run it via `npx vitest run
tests/regression-playbook-port3001-guard.test.ts` whenever that guard
changes. Same scope limits as the suite above: it drives the real
`scripts/kill-port.mjs` CLI against throwaway dummy listeners and OS-assigned
ports, never the real HOME or a real toy dev server.

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
4. Launch the toy sprint THROUGH the supervisor's HTTP API
   (`POST /api/sprints` on `$SUPERVISOR_PORT`) instead of the direct
   `apra-fleet workflow fleet-sprint` CLI, matching how a real
   production sprint is actually launched (fleet-supervisor skill
   guidance). No `--skip-dolt-push` equivalent is needed: with the
   sandbox's `sync.remote` neutralized per `## Reset`, the engine's D-push
   pre-gate refuses to issue any `bd dolt push` regardless of launch path.
   If the sprint plans more than a couple of tasks for the canary's
   single-flag scope, that is itself suspicious and worth a bug bead.

   Note: the supervisor's launch body (`createSprintController`'s
   `launch()` in `src/supervisor/api.mjs`) does not currently forward a
   per-request dispatch-timeout override the way the CLI's
   `--dispatch-timeout-s` flag does -- a dispatch on this path runs under
   the engine's default (1 hour), not the CLI path's bounded 15 minutes.
   The bounded poll deadline below (6 minutes -- leaves headroom in the
   playbook's overall 10-minute budget for the ~30s supervisor boot and
   Teardown's own stop/reap steps) is what actually keeps THIS test's wall
   time bounded; a genuinely hung dispatch still fails this step loud via
   that deadline rather than the engine's own timeout. This gap is worth
   its own follow-up bead if the supervisor API grows a timeout field
   later.

   `SPRINT_BRANCH` gets a per-run timestamp suffix (not a fixed literal) so
   step 5 below can still check out the exact branch this launch used, but
   a Reset-and-relaunch within the same session (`## Reset` now reboots the
   supervisor but does NOT wipe `$FLEET_SE_DATA_DIR`'s on-disk ledger/
   history) never collides with a previous run's branch name and hits the
   launch API's 409 relaunch-guard (`createSprintController`'s `launch()`
   in `src/supervisor/api.mjs`).

   ```bash
   export SUPERVISOR_PORT="${SUPERVISOR_PORT:-18701}"
   SPRINT_BRANCH="smoke-uof6-$(date +%s)"
   # No '-f': a 409 (or any non-2xx) response body is the diagnostic here,
   # and '-f' makes curl discard the body and exit nonzero with nothing to
   # show for it. Capture the HTTP status separately via '-w' instead and
   # check it explicitly.
   HTTP_RESPONSE="$(curl -s -w '\n%{http_code}' -X POST "http://localhost:$SUPERVISOR_PORT/api/sprints" \
     -H 'Content-Type: application/json' \
     -d "{\"issue\":\"gh-toy-4ef\",\"branch\":\"$SPRINT_BRANCH\",\"base\":\"main\",\"members\":[\"toy-doer\"],\"maxCycles\":1}")"
   HTTP_CODE="$(printf '%s' "$HTTP_RESPONSE" | tail -n1)"
   RESPONSE="$(printf '%s' "$HTTP_RESPONSE" | sed '$d')"
   if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
     echo "Test scenario: POST /api/sprints returned HTTP $HTTP_CODE --" \
          "response was: $RESPONSE" >&2
     exit 1
   fi
   SPRINT_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sprintId)' "$RESPONSE")"
   if [ -z "$SPRINT_ID" ]; then
     echo "Test scenario: POST /api/sprints did not return a sprintId --" \
          "response was: $RESPONSE" >&2
     exit 1
   fi
   ```

   Hard-enforces the `## Setup` dolt-orphan-sweep mitigation: this loop
   stops itself and shuts the supervisor down BEFORE uptime reaches the
   sweep's 300s/5-minute tick, rather than only asserting boot (~30s) +
   this 360s poll deadline never crosses it (they can -- 30s + 360s is
   already past 300s, `## Teardown`'s own `SUPERVISOR_UPTIME >= 300` check
   only warns after the fact). `SUPERVISOR_STARTED_AT` is read from the
   marker file `## Setup`/`## Reset` wrote, not a shell variable, since
   this may be a separate script invocation from the one that booted it.

   The marker is validated BEFORE the deadline is computed. Without that
   guard, a missing/empty/non-numeric marker (Setup partially failed, or
   this step run as its own invocation before Setup wrote it) makes `cat`
   yield nothing, `UPTIME_DEADLINE` evaluate to a bare `280` -- decades in
   the past -- and the loop exit 1 on its very first pass with the
   sweep-tick message, sending the operator to investigate a timing
   problem that does not exist. The guard fails with the real reason and
   names the marker file instead.

   ```bash
   if [ ! -f "$SANDBOX.supervisor.started_at" ]; then
     echo "Test scenario: supervisor started-at marker file" \
          "'$SANDBOX.supervisor.started_at' is missing -- ## Setup (or" \
          "## Reset) never recorded the supervisor boot time, so this" \
          "step cannot compute its uptime bound. Re-run ## Setup (which" \
          "boots the supervisor and writes the marker) before this step." >&2
     exit 1
   fi
   SUPERVISOR_STARTED_AT="$(cat "$SANDBOX.supervisor.started_at")"
   case "$SUPERVISOR_STARTED_AT" in
     '' | *[!0-9]* )
       echo "Test scenario: supervisor started-at marker file" \
            "'$SANDBOX.supervisor.started_at' does not hold an integer" \
            "epoch timestamp (read: '$SUPERVISOR_STARTED_AT') -- re-run" \
            "## Setup before this step." >&2
       exit 1
       ;;
   esac
   UPTIME_DEADLINE=$(( SUPERVISOR_STARTED_AT + 280 ))
   DEADLINE=$(( $(date +%s) + 360 ))
   while :; do
     # '|| true': GET /api/sprints/:id 404s (api.mjs's getSprint) if the
     # sprint is neither live nor in history yet, which would otherwise
     # make 'curl -sf' fail silently, leave STATE empty, and spin the
     # loop to its deadline instead of retrying/reporting -- treat an
     # empty STATE as "not yet terminal" and just keep polling.
     STATE="$(curl -sf "http://localhost:$SUPERVISOR_PORT/api/sprints/$SPRINT_ID" 2>/dev/null || true)"
     if [ -n "$STATE" ]; then
       # GET /api/sprints/:id (api.mjs's getSprint): 'live:false' covers
       # both its 'terminal:true' branch (persisted run-state found) and
       # its history-fallback branch (child gone, no persisted run-state
       # yet) -- either way the sprint is no longer actively dispatching.
       IS_LIVE="$(node -e '
         const s = JSON.parse(process.argv[1]);
         process.stdout.write(s.live === false ? "no" : "yes");
       ' "$STATE")"
       if [ "$IS_LIVE" = "no" ]; then
         break
       fi
     fi
     if [ "$(date +%s)" -ge "$UPTIME_DEADLINE" ]; then
       echo "Test scenario: supervisor uptime is approaching the" \
            "dolt-orphan-sweep's 5-minute tick (## Setup's accepted," \
            "time-bounded mitigation) before sprint '$SPRINT_ID' reached a" \
            "terminal state -- stopping the supervisor now rather than" \
            "risk the sweep's machine-wide kill scope firing. File this as" \
            "a carry-over bug: the toy sprint did not finish within the" \
            "mitigation window." >&2
       curl -sf -X POST "http://localhost:$SUPERVISOR_PORT/api/shutdown" > /dev/null 2>&1 || true
       exit 1
     fi
     if [ "$(date +%s)" -ge "$DEADLINE" ]; then
       echo "Test scenario: sprint '$SPRINT_ID' did not reach a terminal" \
            "state within 6 minutes -- see the supervisor dashboard" \
            "(http://localhost:$SUPERVISOR_PORT/) or $HOME/supervisor.log." >&2
       exit 1
     fi
     sleep 5
   done
   ```
5. Assert the canary issue is now closed and `$SPRINT_BRANCH` (the branch
   step 4 launched, `smoke-uof6-<timestamp>`) has a commit. Because the
   canary's deliverable is concrete, also verify it functionally when the
   canary is the "--version flag" issue: in `$HOME/toy-repo`, run
   `git fetch origin` FIRST -- the sprint's push lands on the sandbox-local
   `$GIT_MIRROR` (this clone's `origin`, wired in `## Setup`), not directly
   in this working copy, so `git checkout "$SPRINT_BRANCH"` without
   fetching first fails with "unknown revision" even though the branch
   exists on `origin`. After the fetch, check out `$SPRINT_BRANCH` and run
   the toy CLI with `--version`, confirming it prints a version string and
   exits 0. If any assertion fails, fail loud: file a bug bead per
   "Reporting failures" below. Do not silently reset and move on -- this
   repo treats sprint-run surprises as signal.
6. Hand off to Teardown regardless of the assertion's outcome.

### Smoke evidence output fields

The generic `regression-test-runner` output schema leaves `smokeEvidence`
target-defined. For this repo's own dispatches, populate it with exactly
these three fields, sourced from the checks above:

- `versionStdout` -- verbatim stdout of the toy CLI's `--version` run from
  step 5.
- `canaryStatus` -- the `status` field from `bd show gh-toy-4ef` (step 2),
  e.g. `"closed"`.
- `toyRepoHeadSha` -- the toy repo's head commit SHA after the toy sprint
  (step 4).

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

## Sandbox isolation: FLEET_SE_DATA_DIR and supervisor

`## Setup`'s "Boot the fleet-sprint supervisor" subsection DOES spawn a
real supervisor process (`bin/serve.mjs`) in the
sandbox, and `## Test scenario` step 4 drives the toy sprint through its
HTTP API (`POST /api/sprints`) rather than the direct `apra-fleet workflow
fleet-sprint` CLI. `FLEET_SE_DATA_DIR` is overridden to a sandbox-local
directory for that process (`$SANDBOX/.apra-fleet-se-data`) so its
reservation ledger/history/logs never mix with a real, already-running
supervisor's own data dir. That directory override is NOT, by itself,
enough to isolate the supervisor's `dolt-orphan-sweep` seam: `dolt-orphan-
sweep.mjs`'s `listMembers()` is scoped correctly (via the HOME-scoped
fleet server this supervisor process resolves against), but its probe/kill
command was a MACHINE-WIDE process scan filtered only by port range
(`13300-13400`, `SETTLE_PORT_RANGE`) and age (`DEFAULT_MAX_AGE_MS`), not by
`FLEET_SE_DATA_DIR` or supervisor instance. That is no longer open follow-up
work: mitigation option (a) has LANDED as a code-level scope fix --
`buildSweepCommand()` takes an owner data-dir prefix that both shell
families enforce, and `bin/serve.mjs` wires it from the deps-level seam
`FLEET_SE_SWEEP_OWNER_DATA_DIR`, which `## Setup` exports as the sandbox
root. See the dolt-orphan-sweep hazard note in `## Setup`'s supervisor-boot
subsection for the three residual limits (the relative-data-dir parse
fallback matches no prefix, the scope holds only where that export is
actually set, and the MSYS-path normalization seam) and for why the
time-bounded supervisor lifetime is kept alongside it as belt-and-braces
rather than removed.

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
