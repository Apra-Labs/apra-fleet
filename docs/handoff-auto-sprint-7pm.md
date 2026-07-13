# Handoff: getting `auto-sprint` running against `apra-fleet-7pm`

Status as of 2026-07-13. This doc exists so a fresh session can pick up exactly
where this one left off without re-deriving any of the diagnosis below.

## Goal

Run `apra-fleet-se`'s auto-sprint engine, single-member on `fleet-reorg`,
against beads epic `apra-fleet-7pm` (the SEA-binary workflow-runner subsystem
epic, 14 tasks, built from `docs/workflow-subsystem-plan.md`).

## Done and committed on `feat/fleet-reorg`

- `docs/workflow-subsystem-plan.md` corrected: the "Hard invariant" section
  previously claimed `apra-fleet workflow <name>` always self-spawns its own
  MCP server child. Corrected to split by transport -- stdio self-spawns,
  streamableHTTP (the actual product default) instead connects to the
  already-running local singleton service. Added risk **R13** for the
  resulting gap in `resolveFleetServerCommand()` (stdio-only, no HTTP
  branch). Commit `1dec81c`.
- `.mcp.json` fixed: was configured for stdio self-spawn (`node dist/index.js
  run`), which immediately exits when the HTTP singleton is already running
  ("apra-fleet already running... -- exiting"), leaving the session with no
  fleet MCP tools at all. Switched to `{"type": "http", "url":
  "http://localhost:7523/mcp"}`. Commit `33e7e86`.
- `skills/fleet/beads.md` accuracy fixes: removed a false "`bd init` is
  idempotent" claim (it is NOT -- re-running it on a repo with an existing
  `.beads/` recreates the DB and discards local issue state; use `bd
  bootstrap` instead), fixed misleading `dep add <child-id> <parent-id>`
  naming (renamed to `<blocked-id> <blocker-id>` -- unrelated to `--parent`,
  which means epic/task nesting), fixed a nonexistent `--note` flag (real
  flag is `--notes` / `bd note`), documented the missing P4 priority tier.
  Commit `e9941b2`.
- **`apra-fleet-7ll` fix (the big one)**: `execute_command`'s MCP response
  always formats output as `Exit code: N\n<output>` display text
  (`src/tools/execute-command.ts`, by design, for human/LLM-facing
  dispatch). But `FleetWorkflow.command()`
  (`packages/apra-fleet-workflow/src/workflow/index.mjs`) returned that text
  verbatim to callers expecting raw stdout -- every `bd ... --json` call
  dispatched through a REAL fleet member (not a test mock) failed to
  `JSON.parse`. This broke the auto-sprint engine's very first real
  (non-mocked) run, ever, confirmed live.
  Fix: `execute_command` now returns `{ text, structuredContent:
  { exitCode, stdout, stderr } }` -- `text` (display, with the prefix) is
  UNCHANGED for LLM-facing dispatch; `structuredContent` is a new additive
  machine-readable channel. `wrapTool()` in `tool-registry.ts` generically
  supports both shapes. No client-library plumbing needed -- `callTool()`
  already passes through the full raw MCP response. `FleetWorkflow.command()`
  now prefers `structuredContent.stdout`, falling back to the legacy text
  field for older servers. Test mocks across `apra-fleet-se`/root test
  suites updated to replicate the real shape (previously returned clean
  stdout directly -- an unrealistic mock that let this bug ship
  undetected). Full suites green: root 2215/2215, `apra-fleet-se` 222/222,
  `apra-fleet-workflow` 112/112. Commit `0b878fc`, CI green on all 3 OSes.
- Beads epic **`apra-fleet-7pm`** created (14-task DAG covering the plan
  doc's Sections 1-10 / Phases 1-4) via the `planner` agent, reviewed via
  `plan-reviewer`, 3 real findings fixed directly in beads: R9/R10
  version-mismatch mitigation added to task `.7`, dynamic-`import()` fix
  applied to task `.2`'s acceptance criteria, model-tier bumped from
  `haiku` to `sonnet` on tasks `.11`/`.14`.
- 3 remote fleet members migrated from password to key-based auth:
  `fleet-rev`, `fleet-win11`, `fleet-mac15` (via `setup_ssh_key`).
  `rport-bb` skipped -- offline (`ECONNREFUSED`).
- Binary rebuilt (`npm run build:binary` -> `v0.3.5_0b878f`) and installed
  at user scope (`./dist/apra-fleet-installer-win-x64.exe install --force`).
  No admin privileges needed or used -- everything lives under
  `C:\Users\<user>\.apra-fleet\` / `.claude\`. The ONE step that does need
  elevated rights, registering a persistent Windows Scheduled Task so the
  server auto-starts on login (`schtasks /create ... /sc onlogon`), fails
  with "Access is denied" in this environment and is skipped harmlessly --
  the server was started manually instead (`apra-fleet.exe start`). This is
  a standing, separate, low-priority gap: the server will not survive a
  reboot/logout until scheduled-task registration is fixed or done manually
  with elevated rights.

## Open, NOT yet merged -- this is what's actually blocking a green run

**`apra-pm` PR #21**: https://github.com/Apra-Labs/apra-pm/pull/21

Fixes two bugs in the `pm` skill's agent definitions (a separate repo,
vendored into `apra-fleet-reorg` via the `vendor/apra-pm` submodule pin):

1. **`agents/plan-reviewer.md` criterion 9** told the reviewer to run bare
   `bd ready` and flag any feature/sprint-goal that appears as "dependencies
   wired backwards." This is structurally impossible to satisfy: `bd dep add
   <epic> <child>` is rejected by the CLI outright ("epics can only block
   other epics, not tasks"), so an epic can NEVER be wired to wait on its own
   children -- it will always appear in a bare `bd ready` scan (which also
   lists ready work across the whole database, not just the DAG under
   review). **Confirmed live**: this produced a false CHANGES_NEEDED against
   the real, correctly-wired `apra-fleet-7pm` epic, and the auto-sprint run
   below failed because of exactly this, after exhausting its 3-round
   planning-retry cap (`SprintPlanRejectedError`, clean exit, no hung
   process). The fix replaces the check with a scoped equivalent: `bd list
   --parent <scope> --ready --json` should be non-empty whenever open tasks
   remain under the reviewed scope.
2. **`agents/harvester.md` Step 5** closed every P3/P4 "deferred" issue with
   `--reason="deferred to next sprint"` -- this defeats its own stated goal,
   since a closed issue drops out of `bd list --status=open`/`bd ready` and
   the next sprint's planner never sees it. Fixed to leave them open.

The running binary's vendored `pm` skill/agents come from `vendor/apra-pm`'s
**pinned commit** in this repo, which predates PR #21. Rebuilding the binary
today does NOT pick up this fix -- the submodule pin must move first.

## Also surfaced by the last run (real, not a tool bug)

`apra-fleet-3ns.6` ("SEA binary: embed new auto-sprint as SEA assets") is
still open and covers the same scope as `apra-fleet-7pm.3`. The epic's own
description already says it should be closed as superseded, but nobody has
done it -- `plan-reviewer` flagged this as a legitimate duplicate-work risk
(criterion 7 WARN).

## Filed bugs, P3, not blocking, for later

- `apra-fleet-1cb` -- several `apra-fleet-se` test mocks conflate "shell
  command exited nonzero" with MCP-level `isError: true`; real
  `execute-command.ts` does not do this (nonzero exit is just data on a
  successful dispatch). Not confirmed to cause an actual runner.js bug yet;
  filed for investigation.
- `apra-fleet-adl` -- `pm` skill's `planner.md`/`plan-reviewer.md` write/read
  task model metadata using literal Claude model names (`opus`/`sonnet`)
  instead of the `cheap`/`standard`/`premium` tier vocabulary
  `apra-fleet-se`'s `runner.js` actually expects (established in
  `apra-fleet-dv5`). Auto-sprint's own internal Plan phase caught and
  silently rewrote this on the last run -- it self-healed this time, but
  cost a wasted planning round, and there's no guarantee it always will.

## Next steps to get a green run

1. Merge `apra-pm` PR #21 -> `main`.
2. In `apra-fleet-reorg`: bump the `vendor/apra-pm` submodule pin to that
   new commit (`cd vendor/apra-pm && git checkout main && git pull`, then
   `cd ../.. && git add vendor/apra-pm && git commit`), push to
   `feat/fleet-reorg`, verify CI green.
3. `npm run build:binary`
4. `./dist/apra-fleet-installer-win-x64.exe install --force` then
   `apra-fleet.exe start` (manual start needed -- see the scheduled-task
   caveat above).
5. `bd close apra-fleet-3ns.6 --reason "superseded by apra-fleet-7pm"`
   (clears the criterion-7 duplicate-work warning).
6. Retry:
   ```bash
   node packages/apra-fleet-se/bin/cli.mjs \
     -i apra-fleet-7pm \
     -m fleet-reorg \
     -b feat/fleet-workflow-subsystem \
     -B feat/fleet-reorg \
     --goal P1/P2 \
     --budget 50 \
     --viewer-port 8090
   ```

## Standing constraints to respect while doing the above

- Never run `bd init` on a repo that already has `.beads/` (destructive).
- Keep CI green on `feat/fleet-reorg` at all times; verify every push.
- `feat/fleet-workflow-subsystem` should be cut FROM `feat/fleet-reorg`
  (`--base feat/fleet-reorg`), never re-target `--branch feat/fleet-reorg
  --base main` -- that would `git checkout -B` and rewind the existing
  branch's ~30 commits of divergence back to `main`.
- Multi-member auto-sprint is not supported today for genuinely separate
  checkouts (`fleet-dev`, `fleet-dev2`, etc.) -- `checkMemberTopology()`
  refuses to start unless all configured members share an identical git
  HEAD (a verified shared workspace). Stick to single-member (`fleet-reorg`)
  until the deferred cross-member bd/git sync layer exists
  (`docs/plan.md` section 5 / `docs/architecture.md` "Multi-member
  topology").
