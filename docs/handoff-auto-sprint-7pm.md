# Handoff: `auto-sprint` bug-fix pass against `apra-fleet-7pm` run

Status as of 2026-07-13. This doc exists so a fresh session can pick up
without re-deriving the diagnosis below. Supersedes the earlier version of
this doc (the "get a green run going" goal from earlier today is DONE --
see history below).

## Current state (HEAD)

- Branch `feat/fleet-reorg`, HEAD `08105eb`, working tree clean.
- Binary rebuilt and installed at v0.3.5_08105e; server running locally
  (`apra-fleet.exe start`, http://127.0.0.1:7523/mcp). `fleet_status` shows
  21/23 members online.
- All 3 test suites green at HEAD: root vitest 2215/2215 (+18 skipped),
  `apra-fleet-workflow` 112/112, `apra-fleet-se` 222/222.

## What happened today (in order)

1. Merged `apra-pm` PR #21, bumped the `vendor/apra-pm` submodule pin,
   rebuilt/installed the binary, and got a real (non-mocked) `auto-sprint`
   run going against beads epic `apra-fleet-7pm` on member `fleet-reorg`.
2. While that sprint ran, acted as a live bug scribe per user instruction:
   watched the dashboard/viewer and the auto-sprint HTTP API (`/state`,
   `/events`) and filed every observed issue as a beads bug -- **record
   only, no fixing** during this phase.
3. User manually stopped the sprint, then said: **fix all filed bugs in
   priority order P1/P2/P3; flag anything too complex.**
4. All P1/P2/P3 bugs were fixed (list below), verified with the 3 full
   test suites, committed (`51df121`, `08105eb`), and merged into
   `feat/fleet-reorg` per explicit instruction ("merge everything to
   feat/fleet-reorg branch") -- including recovering one commit that had
   landed on a stray `feat/fleet-workflow-subsystem` checkout via a clean
   `git merge --ff-only`.
5. User also asked for `apra-fleet-aqq` (P4, "should be simple") to be
   fixed -- done, `08105eb`.
6. Binary rebuilt and reinstalled with all of the above (`build:binary` ->
   `install --force` -> `apra-fleet.exe start`), confirmed live via
   `fleet_status`.

## Bugs fixed (commits `51df121`, `08105eb`)

- **`apra-fleet-7b0`/`jkw`** (root cause, spans 3 files) -- dispatch-level
  agent failures (busy guard, nonzero exit, exception) were not
  distinguished from bad-LLM-JSON schema failures, so the workflow engine
  retried them via the schema-repair loop instead of failing cleanly, and
  concurrent same-member dispatch had no serialization. Fixed by: adding a
  `structuredContent` channel to `execute_prompt`'s MCP response
  (`src/tools/execute-prompt.ts`, same pattern as the earlier
  `execute_command` fix), a new `AgentDispatchError` class
  (`packages/apra-fleet-workflow/src/workflow/errors.mjs`) so the engine's
  `agent()` method classifies dispatch failures correctly and never
  schema-repair-retries them, and a per-member async lock
  (`memberLocks` Map) in the auto-sprint runner's streak-dispatch loop
  (`packages/apra-fleet-se/auto-sprint/runner.js`) to serialize concurrent
  calls to the same member.
- **`apra-fleet-13o`** (cost always $0.000) -- `execute-prompt.ts` computed
  real token usage but never returned it in a structured field; same root
  gap as `7b0`. Fixed by the same `structuredContent` change (usage now
  threaded through to `FleetWorkflow.agent()` and the viewer).
- **`apra-fleet-m0c`/`5lj`** (no scroll in activity view / dashboard not
  auto-refreshing) -- single shared root cause: CSS specificity bug in the
  viewer, `.tab-content.active { display: block; }` silently overrode
  `.panel`'s `display: flex`, breaking the nested flex/overflow scroll
  chain. Fixed in `packages/apra-fleet-workflow/src/viewer/index.mjs`.
- **`apra-fleet-wei`** (silent schema-repair failures, no console output) --
  the `attempt < maxRepairs` branch in `workflow/index.mjs` was missing the
  `console.error` call its sibling branches had. Added.
- **`apra-fleet-zzu`** ("Ensure Sprint Branch" PowerShell error) -- runner.js
  used a combined `git fetch ... && git checkout ...` command, which fails
  under PowerShell 5.1 (no `&&`). Split into two sequential `command()`
  calls.
- **`apra-fleet-0ak`** (model tier always shown as n/a) -- viewer now
  renders `[model_name]` badge next to token count when available.
- **`apra-fleet-nkg`** (silent dashboard-refresh failures) -- empty
  `catch (e) { /* ignore */ }` around the beads-panel refresh replaced with
  a logged, non-fatal warning.
- **`apra-fleet-aqq`** (P4, long single-line log messages not truncated) --
  extended the viewer's existing multiline-truncation logic to also cover
  long single-line messages (200-char preview + expandable `<details>`),
  same fix applied to all agent types, not just reviewer.

## Deferred, left open in beads -- explicit user calls, no action needed

- **`apra-fleet-4yr`** -- Stop-button uses 2 native OS dialogs (confirm +
  info), user wants a modernized in-app confirmation instead of the
  "ugly" native ones. Explicitly deferred ("really cosmetic").
- **`apra-fleet-9ub`** -- pause/resume feature for auto-sprint runs (as
  opposed to hard stop). Explicitly deferred by user as a backlog idea
  needing more design thought before scheduling.
- **`apra-fleet-1cb`** (P3, from the earlier handoff) -- some
  `apra-fleet-se` test mocks conflate nonzero shell exit with MCP-level
  `isError: true`; not confirmed to cause a real runner.js bug. Still just
  filed for investigation, not investigated.
- **`apra-fleet-adl`** (P3, from the earlier handoff) -- `pm` skill's
  `planner.md`/`plan-reviewer.md` docs use literal model names instead of
  the `cheap`/`standard`/`premium` tier vocabulary; auto-sprint's Plan
  phase self-heals this today but it's not guaranteed to always.
- **`apra-fleet-3ns.6`** -- still open, superseded by `apra-fleet-7pm.3`
  per the epic's own description; nobody has closed it yet
  (`plan-reviewer` criterion-7 duplicate-work warning). Low priority,
  cosmetic bookkeeping only.

## Test-infra notes worth keeping

- `executePrompt()` now returns `string | { text, structuredContent }`.
  Tests must read results via the `resultText()` helper from
  `tests/test-helpers.ts`, not raw `.toContain()` on the return value.
  Already fixed across all affected test files at HEAD -- if you add a new
  test that calls `executePrompt()` directly, use `resultText(result)`.
- Golden-transcript snapshot tests
  (`packages/apra-fleet-se/test/golden-transcript*.test.mjs`) are
  regenerable via `UPDATE_GOLDEN=1 node --test <file>` -- used once today
  for the `zzu` git-command-split fix (clean `seq` +1 shift only, verified
  by diff).
- Long-running background test suites (`run_in_background: true`) were
  observed getting killed mid-run for no clear reason today. Foreground
  `Bash` calls with a large explicit `timeout` (e.g. 600000ms) completed
  reliably every time instead -- prefer that pattern for full-suite runs
  until this is understood better. (Not confirmed root-caused; may be
  harness reaping idle-perceived background jobs.)

## Standing constraints (unchanged from before)

- Never run `bd init` on a repo that already has `.beads/` (destructive).
- Keep CI green on `feat/fleet-reorg` at all times; verify every push.
- `feat/fleet-workflow-subsystem` should be cut FROM `feat/fleet-reorg`
  (`--base feat/fleet-reorg`), never re-target `--branch feat/fleet-reorg
  --base main`.
- Multi-member auto-sprint is not supported today for genuinely separate
  checkouts -- `checkMemberTopology()` refuses to start unless all
  configured members share an identical git HEAD. Stick to single-member
  (`fleet-reorg`) until the deferred cross-member bd/git sync layer exists
  (`docs/plan.md` section 5 / `docs/architecture.md` "Multi-member
  topology").
- The server does not auto-start on reboot/logout in this environment
  (Windows Scheduled Task registration fails without admin rights). Start
  manually with `apra-fleet.exe start` after any reboot.

## Suggested next steps (not yet requested by user)

- Re-run `auto-sprint` against `apra-fleet-7pm` now that the P1-P3 blockers
  are fixed, to see if it can get further than Develop Cycle 1 Round 1.
- Consider tackling `apra-fleet-1cb`/`adl` (P3s) or designing `9ub`
  (pause/resume) if/when the user wants to continue this track.
