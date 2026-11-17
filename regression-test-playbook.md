# Fleet Regression Test Playbook

Run by `regression-test-runner` to prove EXISTING functionality still works.
It is NOT a gate on the current sprint's new work: feature-closure testing
for the current cycle's features lives in `integ-test-playbook.md` instead.
(The `deployer` agent follows `deploy.md` and does not run this file.)

**Leftover sandbox-deploy sweep.** If Deploy succeeded but Integ Test never
ran in the last cycle, that sprint's sandbox deploy is still up. Before
returning, run `node scripts/sandbox-deploy.mjs teardown --sprint-id "<the
sprintId in your dispatch prompt>"` -- exit 0 with "nothing to tear down" is
the normal case; it only kills processes it can prove are that sandbox's own
(see `deploy.md` Teardown).

The pass has two parts. Report one `sections` entry per part, named exactly:

- **`Install smoke`** -- `## Setup` then `## Teardown`: a fresh `install`
  from this checkout into a throwaway HOME, the fleet server booted on a
  scratch port and verified bound to it, then stopped and deleted. Passed
  only if Setup and Teardown both exit 0.
- **`In-sprint smoke`** -- NOT RUN. Report it as `passed: false` with
  detail `NOT RUN: moved to CI`, say `NOT RUN: moved to CI` in `summary`,
  and return overall `passed: false`. File no bead for it.

Why `In-sprint smoke` is not run: the toy sprint (member registration,
canary sprint, harvest) needs an LLM credential provisioned for the toy
member, and an agent cannot provision one here -- the permission layer
blocks the secret-store write. Do NOT provision credentials or run the toy
sprint by any other route; a permission block is surfaced, never routed
around. The toy sprint is not run in-sprint until the CI regression
workflow lands. The real-`bd` `apra-fleet-se` suite and its slow lane run
nightly in CI (`.github/workflows/regression-nightly.yml`), not here.

The sandbox never touches the real `~/.apra-fleet` install. It lives at a
fixed path, `~/temp/.apra-fleet-tests`, guarded by a lock file next to it
(`$SANDBOX.lock`, outside the directory Teardown deletes) via
`scripts/sandbox-lock.mjs`: Setup acquires it before touching anything and
fails loud (`sandbox busy`, non-zero exit) if another live run holds it;
Teardown deletes the sandbox only if it owns the lock. **If Setup's
busy-check refuses, STOP the pass**: run neither the rest of Setup nor
Teardown (this run owns nothing to tear down), and report `Install smoke`
failed with the busy message.

Conventions:
- Scratch port: `18700` (`APRA_FLEET_PORT`), away from the default MCP
  server port `7523`.
- `<repo-root>`: the root of this apra-fleet checkout (the directory
  containing this playbook). Substitute the actual path.

Target time: under 3 minutes. Any single step over 2 minutes is a bug.

## Permissions

Commands below require coverage for these prefixes by SOME entry in
`permissions.allow` of EITHER `.claude/settings.json` OR
`.claude/settings.local.json` (where the fleet's compose_permissions tool
delivers). A broader prefix entry counts as coverage (e.g. `Bash(node:*)`
covers `node dist/index.js`). Only report a permissions block if a prefix has
no covering entry in either file, or a command is actually denied at
runtime:
- `Bash(mkdir *)`
- `Bash(rm -rf ~/temp/.apra-fleet-tests*)`
- `Bash(node dist/index.js *)`
- `Bash(node:*)` -- the absolute-path `node "<repo-root>/scripts/*.mjs"`
  helpers (`sandbox-lock.mjs`, `kill-port.mjs`), the inline `node -e` port
  check, and `scripts/sandbox-deploy.mjs` (the sweep above). A
  relative-prefix entry like `Bash(node scripts/sandbox-lock.mjs *)` does
  NOT cover the absolute form.
- `Bash(bd *)` -- `bd search`/`bd create` in "Reporting failures" below.

## Setup

Prerequisites: `<repo-root>` cloned normally (`install` fails at its
fleet-skill step if `packages/apra-fleet-se/apra-pm` is empty), and
`npm install && npm run build` already run.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"

# Busy-check: claim the sandbox lock BEFORE touching anything below.
node "<repo-root>/scripts/sandbox-lock.mjs" acquire "$SANDBOX" || exit 1

export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
mkdir -p "$HOME"
cd "<repo-root>"
node dist/index.js install

# Stale-process guard: free 18700 first. The server silently rebinds to an
# OS-assigned port on EADDRINUSE, so a leftover listener would otherwise
# hand this run the wrong port. Fails loud if the port stays bound.
node "<repo-root>/scripts/kill-port.mjs" 18700 "sandbox scratch port 18700" 5000 || exit 1

node dist/index.js start

# Point the lock at the sandbox's own long-lived server PID.
node "<repo-root>/scripts/sandbox-lock.mjs" mark-server-started "$SANDBOX" || exit 1
```

Verify the server came up AND is bound to `18700`. `status` exiting 0 alone
is not enough (see the silent-rebind note above); `server.json` is the
authoritative record `status` itself reads:

```bash
node dist/index.js status || exit 1
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const p = path.join(process.env.HOME, ".apra-fleet", "data", "server.json");
  const port = Number(JSON.parse(fs.readFileSync(p, "utf8")).port);
  if (port !== 18700) {
    console.error("Setup: server.json reports port " + port + ", not 18700 -- the server rebound after EADDRINUSE.");
    process.exit(1);
  }
  console.log("Setup: server bound to sandbox scratch port 18700");
'
```

## Teardown

Runs after every pass, pass or fail (except the busy-check STOP above). It
releases the lock only if this run owns it, stops the server, and deletes the
sandbox.

```bash
SANDBOX="$HOME/temp/.apra-fleet-tests"
export HOME="$SANDBOX"
export USERPROFILE="$HOME"
export APRA_FLEET_PORT=18700
cd "<repo-root>"

# Ownership check BEFORE 'stop' (it reads the still-live server.json): a
# lock naming another live PID means another run owns the sandbox -- refuse.
node "<repo-root>/scripts/sandbox-lock.mjs" release "$SANDBOX" || exit 1

node dist/index.js stop
rm -rf "$SANDBOX"
```

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
invisible to it. A regression failure is pre-existing breakage, not new
work of this sprint, so it carries over to a future sprint.

Before creating a new bug, search for duplicates across BOTH tags -- the
same defect can surface here or in `integ-test-playbook.md` (`[integ]`):
```bash
bd search "[carry-over]"
bd search "[integ]"
```
If an existing bug (either tag) covers the same failure, update its
description rather than creating a new one.

## Adding new features to this test

New install/sprint scenarios belong in CI (`.github/workflows/` and
`tests/integration/fresh-install/`), not here. Keep this file
shell-drivable: `regression-test-runner` has only [Read, Bash, Grep, Glob]
tools and cannot call MCP tools, and no step may need a credential an agent
cannot provision.
