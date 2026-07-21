# Refactoring: restore the core-vs-se boundary in the workflow package

Status: DESIGN APPROVED FOR EXECUTION (user-directed 2026-07-20). To be
executed as part of the current build effort, not parked as debt. Tracked
by a bug bead under the eft epic; this document is the single design
source the planner should decompose from.

## Why (the product argument)

packages/apra-fleet-workflow is the GENERIC workflow engine + viewer: the
thing other teams use to build non-sprint workflows. auto-sprint
(packages/apra-fleet-se) is ONE workflow built on it. The original design
honored this: the beads tree is a dashboard EXTENSION, not core UI. But
sprint vocabulary has since leaked into core -- state keys, module names,
persistence paths, and one extension-shape dependency. A team building a
plain non-se workflow today ships state carrying `sprintId`/`verdict`/
`prUrl` nulls, persists into `old_sprints/`, and reads core code that
talks about sprints. That is annoying at best and misleading at worst,
and it erodes the platform claim that workflows are first-class and
domain-agnostic.

## Leakage inventory (verified 2026-07-20, file:line)

All in packages/apra-fleet-workflow/src unless noted:

1. viewer/index.mjs:537-564 -- core state INIT mints `sprintId` (from
   `opts.sprintId`), `verdict: null`, `prUrl: null`.
2. viewer/index.mjs:797-798 -- core completion code copies
   `res.result.verdict` / `res.result.prUrl` into state BY NAME.
3. viewer/index.mjs:~500-515 findBeadById() -- core route handler for
   GET /beads/:id/description reaches into
   `state.extensions.beads.sprintTasks/backlogTasks` (self-documented as
   the one deliberate violation). The ROUTE itself is also beads-named.
4. viewer/sprint-state-paths.mjs -- entire core module named around
   sprints: `running/<sprintId>.json`, `old_sprints/`;
   getRunningSprintStatePath()/getOldSprintStatePath().
5. viewer/index.mjs:637-679 -- terminal-state move logs "sprint state";
   crash-net snapshot writes `sprint-logs/sprint_<HHMMSS>.json` from core.
6. Assorted comments/log strings across viewer/*.mjs say "sprint" where
   they mean "workflow run" (cosmetic tier, fix opportunistically).

se-side consumers that must follow any rename: packages/apra-fleet-se
bin/serve.mjs, src/supervisor/{history-view,proxy,watchdog}.mjs (import
the path helpers), bin/cli.mjs (passes opts.sprintId), runner.js (returns
verdict/prUrl in its result).

## Target model (three mechanisms, all sanctioned)

### M1. Generic run identity + generic persistence names

- `sprintId` -> `runId` everywhere in core. `opts.sprintId` becomes
  `opts.runId` (back-compat: accept `opts.sprintId` for one release with
  a deprecation warning, se moves off it immediately).
- viewer/sprint-state-paths.mjs -> viewer/run-state-paths.mjs with
  getRunningRunStatePath()/getTerminalRunStatePath(); directories
  `running/<runId>.json` and `old_runs/`.
  Migration: terminal-state reader checks `old_runs/` first, then falls
  back to legacy `old_sprints/` (read-only); the supervisor history list
  merges both. No file moves at upgrade time.
- Core crash-net snapshot dir becomes configurable:
  `opts.stateSnapshotDir` (default `workflow-logs/`); auto-sprint passes
  `sprint-logs` explicitly so its user-facing convention is unchanged.
  Snapshot filename `run_<HHMMSS>.json` in core; se override may keep
  `sprint_<HHMMSS>.json` via `opts.stateSnapshotPrefix` (default `run_`).

### M2. Workflow-declared result surface (replaces verdict/prUrl leakage)

- Core stops minting or copying `verdict`/`prUrl`. Instead:
  - `state.result = res.result` is stored WHOLESALE and opaquely at
    completion (core knows nothing about its keys).
  - The generic page renders `state.result`'s scalar (string/number/
    boolean/null) top-level fields as a plain key/value "Result" strip --
    every workflow gets result display for free, no registration needed.
  - Anything richer (the auto-sprint verdict badge coloring, the PR
    link-ification) moves into the auto-sprint dashboard extension's own
    js, reading `state.result.verdict`/`state.result.prUrl` -- se code
    referencing se keys, as it should be.
- Persisted-state compat: history-view/supervisor ledger currently read
  `state.verdict`/`state.prUrl` from old files. Reader shim (se side):
  `const verdict = state.result?.verdict ?? state.verdict` for one
  release; the ledger schema itself is se-owned so renaming there is
  free.

### M3. Extension-owned data access (abstract/override where core needs a hook)

- GET /beads/:id/description moves behind a GENERIC on-demand-detail
  hook: extensions may register `{ id, title, html, js,
  detailLookup?: (state, id) => {text, updatedAt} | null }` and core
  serves GET /extensions/:extId/detail/:itemId by delegating to that
  extension's detailLookup. findBeadById() moves verbatim into the beads
  extension module (packages/apra-fleet-se/auto-sprint/
  viewer-extensions.mjs) as its detailLookup.
  Client compat: the extension js (which owns the "more..." UI per the
  eft.27 user feedback) calls the new route; the old /beads/:id/
  description route stays as a 302/alias for one release, then dies.
- This is the abstract/override pattern the design allows: core defines
  the hook surface (template method), se overrides with sprint behavior.
  If further core/se seams appear during implementation, prefer the same
  shape: core calls a named optional hook with a default no-op.

## Enforcement (so it stays fixed)

- New unit test in packages/apra-fleet-workflow/test:
  boundary-no-domain-leakage.test.mjs -- greps src/ (not test/) for
  forbidden identifiers in CODE (string-literal and identifier positions;
  comments excluded by stripping): `sprintId`, `sprint-logs`,
  `old_sprints`, `verdict`, `prUrl`, `beads`, `sprintTasks`,
  `backlogTasks`. Allowlist: the two explicit back-compat shims (legacy
  opts.sprintId acceptance; old_sprints read fallback), each tagged with
  a `BOUNDARY-COMPAT` comment the test recognizes and counts (exactly 2
  allowed; a third occurrence fails).
- The word "sprint" in prose comments is allowed only in the compat
  shims and historical bead references; opportunistically reword the
  rest to "run"/"workflow".

## Acceptance criteria (for the bead's [test] child)

1. A non-se workflow (hello-world) run has NO sprintId/verdict/prUrl keys
   anywhere in its /state payload or persisted running/<runId>.json, and
   its viewer renders (including Save) with zero beads/sprint strings in
   the served HTML outside extension script tags.
2. auto-sprint still shows verdict badge + PR link (now via extension) and
   its history view resolves both old_sprints/ and old_runs/ files.
3. On-demand bead description still works via the generic extension
   detail route; the "more..." activity control (eft.27 feedback) uses
   the generic full-output route -- no core code names beads.
4. boundary-no-domain-leakage test passes and fails on a seeded
   violation (mutation check in the test itself).
5. Full workflow + se suites green; goldens updated where dispatch/state
   shapes changed.

## Suggested decomposition (planner may adjust)

- [impl] M1 rename + path/dir migration with read fallback (core + 4 se
  consumer files + cli.mjs opts)
- [impl] M2 opaque result surface + generic Result strip + se extension
  badge/link rendering + reader shim
- [impl] M3 extension detailLookup hook + beads lookup relocation +
  route alias
- [impl] boundary enforcement test (+ comment rewording sweep)
- [test] acceptance criteria 1-3 as an e2e (hello-world negative +
  auto-sprint positive)

## Non-goals

- No change to the workflow ENGINE's execution semantics, the runner, or
  any se-internal naming (sprint-logs/ as a repo convention, supervisor
  ledger fields) beyond the listed reader shims.
- No renaming of user-facing auto-sprint surfaces (CLI flags, dashboard
  wording) -- auto-sprint remains proudly sprint-shaped; only CORE goes
  domain-neutral.
