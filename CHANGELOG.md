# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] -- Auto-sprint as a service: always-on multi-sprint supervisor

Sprint goal: turn the single-shot, run-to-completion auto-sprint CLI into an always-on
supervisor service that runs multiple concurrent sprints with member+issue-scope
reservation, a sprint-stack dashboard, and orchestrator-bracketed git+Dolt sync, with the
service positioned as the single supported user-facing entry point. **Goal not fully
met -- sprint verdict is FAIL.** A large amount of real, well-tested functionality shipped:
an always-on supervisor process owning a combined member+issue-scope reservation ledger and
a PID-liveness watchdog with restart re-adoption; a sprint-stack dashboard (running sprints,
a process-free history view, a backlog tree that live-recomputes claimed scope) served
through one reverse-proxied port; orchestrator-bracketed git and Dolt sync with a scripted-
first conflict escalation ladder (mechanical detection/resolution before any agent is
dispatched, and only as a documented last resort); CLI convergence onto one shared fleet
transport; server-side per-member reservation enforced at dispatch time (independent of the
supervisor's own launch-time ledger, closing the gap where a manually invoked sprint could
otherwise bypass it); a shell-drivable `register-member` CLI subcommand sharing the same
validation/registration logic as the MCP tool; a darwin-x64 build-from-source deploy
fallback; and a lean dashboard-polling pattern (small recurring payload, on-demand full-text
fetch with client-side caching) for sprints with large activity/task counts. Unit and build
suites are fully green.

However, the sprint fails its own acceptance gate: the epic requires the service to complete
a full plan-develop-review-harvest cycle against a live smoke sandbox, and that end-to-end
smoke test did not pass in any of five attempted cycles. Root causes uncovered and (partially)
fixed but not yet proven to hold under a real end-to-end run: a member's live interactive
session dying mid-dispatch with no timeout ever firing on the dispatching side; a member
being incorrectly rejected as "reserved by another sprint" when the identity token used at
reservation time and at dispatch time did not match; and a sandboxed Dolt clone's remote
being re-wired and a real push attempted against it despite an explicit neutralization step,
caught only by an unrelated missing-credentials condition rather than by the neutralization
holding as designed. Additional known, tracked-but-unresolved integration blockers: a fixed
test-server port causing an EADDRINUSE cascade across dependent test processes; a smoke-test
fixture repository with no pre-tagged canary issue, requiring either a maintainer reseed or a
self-provisioned fallback; a pre-sprint scope validator that rejects a single childless issue
as a sprint target; and a bootstrap recovery step that can reactivate a real, live sync
remote unless explicitly neutralized afterward. A vendored agent-contract durability
improvement (per-commit push discipline for the vendored doer/harvester role contracts) is
incomplete: implementation work remains in progress and no test exists yet to verify it, so
the vendored contract files are unchanged from before this sprint.

Carried forward, all open, none closed this cycle: the eight integration blockers described
above; a member-reservation interoperability gap between workflow/CLI-launched sprints and
the server-side reservation check; a viewer full-state-polling performance gap on very large
sprints (distinct from, and not fully addressed by, the lean-polling pattern shipped this
sprint); a real-bd test suite performance regression where a meaningful fraction of files
exceed their per-file time budget; and the incomplete vendored agent-contract durability
work described above. Two lower-priority follow-ups from earlier in the sprint (a CLI-
convergence in-progress item, and a crash-resume-via-journal design explicitly deferred by
the original plan) also remain open and are intentionally left for a future sprint.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 80 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-reorg

Sprint goal: continue scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner") from the point the prior `feat/fleet-workflow-subsystem` sprint left off. **Goal work landed (15 beads closed this sprint, final open-at-goal-priority count 0), but the sprint's own final verdict is FAIL** -- the final reviewer dispatch timed out after repair attempts (`Command timed out after 300000ms of inactivity`) rather than returning a schema-valid verdict, so the sprint could not self-certify despite the code landing. What shipped: `apra-fleet-7pm.8` self-heal extraction in the workflow launcher (`src/cli/workflow.ts` re-extracts the on-disk payload from embedded SEA assets if it's found missing/incomplete); `apra-fleet-7pm.9` `uninstall --skill workflows` (removes the shared runtime/schema dirs and only the built-in workflow subdirectories, preserving user-authored workflows); `apra-fleet-7pm.10` the update flow reading back and re-threading the persisted `--workflows` mode into a re-invoked install; `apra-fleet-7pm.11` `docs/authoring-workflows.md` plus doc deltas; `apra-fleet-7pm.12` a fix for broken npm-mode auto-sprint runtime imports in a clean global install; `apra-fleet-7pm.13`/`.15` build-binary smoke tests for the workflow subcommand and an auto-sprint-as-built-in-workflow packaged-binary e2e test; and `apra-fleet-7pm.14` a regression guard pinning the existing CLI command surface. Also landed outside the epic: a redesigned Sprint/Backlog dependency-tree beads panel in the auto-sprint dashboard, and a positioning paper comparing `apra-fleet-workflow` to LangChain/LangGraph.

Deploy/integration still could not run this sprint, for the same reason recorded last sprint and tracked as `apra-fleet-nbp` (P3, still open): `integ-test-playbook.md` remains absent from the repo root, and `deploy.md` still lacks the required `## Deploy`/`## Smoke test` sections (it has a `## Steps` section with unresolved `<branch>`/`<run-id>`/`<tag>` placeholders and a manual, non-scriptable verify step instead). One of the three deploy attempts this sprint also flagged a stray instruction-like line in `deploy.md` ("Must be run using model tier `cheap`") as a likely prompt-injection attempt, which was correctly not followed.

Carried forward: `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3, still open, still blocking automated deploy verification). No other work from this sprint's scope was left open.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 35 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-workflow-subsystem

Sprint goal: scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner"). **Goal NOT met -- sprint verdict is FAIL.** What landed this sprint: `src/cli/workflow.ts`, the launcher subcommand that runs a workflow script (an ESM entry under `workflows/<name>/`) from inside the SEA binary against a live fleet connection; a shared, single-implementation connection-resolution helper (`@apralabs/apra-fleet-client/server-resolution`) used identically by the launcher and by `packages/apra-fleet-se/bin/cli.mjs`, resolving HTTP-singleton-attach-first with stdio self-spawn as fallback (`docs/adr-workflow-server-resolution.md`); SEA asset embedding of the workflow runtime, agent schemas, and built-in workflows via `scripts/gen-sea-config.mjs`; and `docs/authoring-workflows.md` plus deltas to `docs/install.md`, `docs/npm-packaging.md`, and `packages/apra-fleet-se/docs/cli-reference.md`. Entry-path escape prevention (rejecting `..`/absolute-path manifest entries) is implemented and tested. Full test suite passes (2275/2275, 18 skipped) and `npm run build` is clean.

What did NOT land, despite the epic being scoped for it: the `install.ts` additive workflow-install step (`apra-fleet-7pm.5`) is mid-flight as uncommitted-to-done WIP commits with its issue still open; self-heal extraction in the launcher (`apra-fleet-7pm.8`, P1) is not started; `uninstall --skill workflows` (`apra-fleet-7pm.9`), the update-flow re-install path (`apra-fleet-7pm.10`), build-binary smoke tests for the workflow subcommand (`apra-fleet-7pm.13`), a regression guard for the existing command surface (`apra-fleet-7pm.14`), and an end-to-end test of auto-sprint running as a built-in workflow (`apra-fleet-7pm.15`) are all open. The deploy/integration phase could not run at all this sprint: `integ-test-playbook.md` is absent from the repo root and `deploy.md` lacks the required `## Deploy`/`## Smoke test` sections, so no smoke test exists to execute (tracked as `apra-fleet-nbp`). A binary developer-meeting slide deck (`docs/features/apra-fleet-workflows.pptx`/`.pdf`, ~470 KB) landed without an owning task and should be re-homed or removed.

Carried forward (all remain open, none closed this cycle): `apra-fleet-7pm` (epic) and children `.5`, `.8`, `.9`, `.10`, `.13`, `.14`, `.15`; `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3).

#### Sprint cost analysis
Budget ceiling: $50.0000.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: $50.0000.
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- chore/hub-service-retire-and-docs

Sprint goals: `apra-fleet-yp3` (P2, retire `src/hub-service/` to reference-only status) and `apra-fleet-qaz` (P3, record the final tier-ownership decision in the architecture docs), both children of epic `apra-fleet-yeb`. Both goals met. This sprint follows a product-owner directive that resolved a divergence from the prior hub-spoke migration sprint: `fleet-dashboard` is the sole tier-3 persistence layer for workspace/project/member/secret configuration, and `apra-fleet.exe` is either a SaaS-connected client of fleet-dashboard's contract or a standalone client backed by local JSON files -- never a competing relational database of its own. Accordingly, `src/hub-service/` (the Postgres-backed service built during the prior hub-spoke migration sprint) is retired to reference-only: no code or tests were deleted (all 2133 tests remain green, verified as a specification of wire-protocol/security-isolation semantics), but `src/hub-service/main.ts`, `docs/hub-service-deployment.md`, `Dockerfile.hub-service`, and `docker-compose.hub-service.yml` now carry explicit reference-only/dev-only banners so nobody ships it to fleet.apralabs.com. `docs/adr-hub-persistence.md` and `docs/hub-spoke-master-plan.md` are annotated as superseded on tier-3 ownership, with a correction that SSH is NOT deprecated (it remains a permanent execution transport) and that relay/NAT-traversal work is explicitly deferred (`apra-fleet-8rs`), not abandoned. The new `docs/api-contract-reconciliation.md` records the verbatim product-owner directive and a 22-item hub<->dashboard API gap analysis; a documentation-integrity self-correction during the sprint stripped a fabricated "confirmed by direct code inspection" claim about fleet-dashboard's private (unseen) code from that document, replacing it with an explicit sourcing note. A new durable `docs/adr-tier3-ownership.md` distills the decision for future readers without the full negotiation history.

Carried forward: none from this sprint's named goals (both closed). Deferred, non-blocking cleanup identified by review: normalize 14 non-ASCII em-dash characters in `docs/api-contract-reconciliation.md` to the project's ASCII-only convention.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     17,909 |   n/a |   $0.000 |   $0.269 |
| reviewer   |          0 |      4,513 |   n/a |   $0.000 |   $0.068 |
| overhead   |      7,150 |     28,697 | +301% |   $0.121 |   $0.365 |
| TOTAL      |      7,150 |     51,119 | +615% |   $0.121 |   $0.702 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Final review notes

Reviewed sprint work on chore/hub-service-retire-and-docs (5 commits atop feat/hub-spoke-migration: cae75fd..4b649af). Sprint goals apra-fleet-yp3 (P2) and apra-fleet-qaz (P3), both children of epic apra-fleet-yeb, are met. Build (tsc) clean; full suite 2133 passed / 18 skipped (docker/terminal-gated) / 0 failed. Git tree clean apart from the durable sprint-logs jsonl (not flagged, per workflow). No lint script configured in package.json.

apra-fleet-yp3 (retire src/hub-service to reference-only) -- acceptance criteria fully met:
- src/hub-service/main.ts: clear top-of-file STATUS: REFERENCE IMPLEMENTATION ONLY banner with pointer to api-contract-reconciliation.md 1.5 and hub-service-deployment.md.
- docs/hub-service-deployment.md: retitled "(Reference Implementation -- Not a Deployment Target)", one-paragraph status block at top; a new contributor understands reference-only status immediately (criterion satisfied).
- Dockerfile.hub-service and docker-compose.hub-service.yml: both prepended with "REFERENCE/DEV-ONLY -- NOT a production deployment target" and the stale production-deployment guidance was removed/reframed, so nobody ships it as fleet.apralabs.com.
- docs/adr-hub-persistence.md marked Superseded; docs/hub-spoke-master-plan.md annotated with the tier-3 ownership + SSH-stays/relay-deferred correction.
- No hub-service code or tests deleted (verified: only a 13-line comment added to main.ts; 2133 tests still green, matching the doc's cited count).

apra-fleet-qaz (record final tier-ownership decision) -- acceptance criteria met:
- docs/api-contract-reconciliation.md (new, 608 lines) sections 1.5/1.6 carry the verbatim product-owner directive and corrected per-item verdicts; adr and master-plan cross-link to it. A cold reader grasps reference-only status and bootstrap/sync-first scope without needing session history.
- Documentation-integrity self-correction (commit 4b649af): the doer caught and stripped a fabricated "fleet-dashboard implementer / confirmed by direct code inspection" persona from the reconciliation doc and added an explicit sourcing note distinguishing this repo's verified source from inferences about fleet-dashboard's private (unseen) code. Verified no residual "confirmed by code inspection"-style fabricated claims remain. This is a good catch.

File hygiene: all changed files justify against the epic. docs/bootstrap-sync-design-proposal.md and docs/cross-repo-design-protocol.md are legitimate deliverables of closed sibling task apra-fleet-48p (referenced by the qaz docs so links resolve). .gitignore additions (.agents/, .codex/) correctly exclude local tool scaffolding. No temp files or stray tool config slipped in.

Minor issue (non-blocking, recommend cleaning before merge): docs/api-contract-reconciliation.md contains 14 lines with non-ASCII em-dashes (U+2014 "--", e.g. lines 38, 42, 44-46, 48, 50, 52), which violates the project's checked-in ASCII-only convention in CLAUDE.md ("never write non-ASCII characters to any file; use `-` for dashes"). Line 38 is arguably a verbatim directive quote, but lines 42/44/45/46/48/50/52 are the author's own prose. No functional impact (docs only, build/tests unaffected), so not reopening the task -- but the em-dashes should be normalized to ASCII "--" in a follow-up or before raising the PR. No security issues, no regressions in adjacent code. Work is releasable/harvestable.

## [Unreleased] -- feat/hub-spoke-migration (hub-spoke cloud migration groundwork, sprint 2)

Sprint goal (P1/P2): apra-fleet-us9 (hub-spoke cloud migration epic) and apra-fleet-20o (shared hub<->dashboard API contract). Goal not fully met -- apra-fleet-20o (P1) and several other P1/P2 tasks closed this sprint, but apra-fleet-us9 is a multi-sprint epic and remains open by design; several of its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance, spoke mode, RBAC, SSH-to-relay migration) are carried forward to next sprint.

Completed this sprint: extracted `@apralabs/fleet-api-contract`, a versioned npm workspace package holding the Zod schemas (Workspace, Project, Member, JWTClaims, UsageRecord, ActivityEvent, Installer, AdminUser) and generated OpenAPI 3.1 spec shared between the future hub service and dashboard, with `JWTClaims` as the explicit auth anchor and a runtime contract test validating a real handler response against the schema; unified identity on the member UUID with `workspace_id` promoted to the hard security-boundary claim behind a pluggable `TokenIssuer` (local dev-mode issuer today, cloud-dashboard issuer later, no token migration needed), with `session-registry`, `send-message`, and `http-transport` scoped end-to-end so cross-workspace traffic is indistinguishable from "not connected"; implemented and live-verified `registerMcpEndpoint()` for the AGY and OpenCode providers (read-modify-write of each provider's own MCP config file, non-destructive to sibling entries); closed a stale-close session-unregister race in `http-transport.ts` and required the local admin key on `/shutdown`; de-hardcoded the port and gated interactive bootstrap behind an explicit flag in `register_member`; fixed suite-wide test pollution from shared fixed-path fixtures under concurrent test runs. Full vitest suite: 1816 passed / 14 skipped / 114 files.

Carried forward: apra-fleet-us9 epic and its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance + `apra-fleet join` enrollment, spoke mode in apra-fleet.exe, workspace iron-wall security review, dashboard OAuth/RBAC), plus apra-fleet-fnz.1/.4 (registerMcpEndpoint wiring into register_member's same-machine path, and the LAN enrollment-token join flow) and apra-fleet-2xs.1 (compose_permissions deep-merge fix).

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     32,374 |   n/a |   $0.000 |   $0.486 |
| reviewer   |          0 |     10,421 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     74,090 | +936% |   $0.121 |   $0.677 |
| TOTAL      |      7,150 |    116,885 | +1535% |   $0.121 |   $1.320 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Final review notes

Scope reviewed: origin/main..feat/hub-spoke-migration (21 commits, 107 files). Named sprint goals: apra-fleet-20o (P1, closed) and epic apra-fleet-us9 (parent, expectedly still open).

VERIFICATION
- Build: `npm run build` and `npm run build:contract` both exit 0.
- OpenAPI: `npm run gen:openapi` regenerates packages/fleet-api-contract/openapi.json byte-identical to the committed copy (no dual-maintenance drift).
- Tests: `npm test` = 1816 passed / 14 skipped / 114 files. No lint script is configured in this repo (n/a).

ACCEPTANCE CRITERIA (apra-fleet-20o) - all met:
- Zod schemas for Workspace/Project/Member/JWTClaims/UsageRecord/ActivityEvent/Installer/AdminUser (packages/fleet-api-contract/src/schemas/*).
- JWTClaimsSchema is the explicit anchor; every auth-gated route in src/endpoints.ts carries `auth: JWTClaimsSchema`, never redefined. Member.provider enum includes 'none' per us9.14.
- OpenAPI 3.1 generated from the same schemas via src/scripts/gen-openapi.ts.
- Versioned public workspace package (@apralabs/fleet-api-contract@0.1.0, workspaces:[packages/*], README consumption path documented).
- Runtime contract test present (tests/hub-service/installers.contract.test.ts) validating getInstallersHandler() output against InstallerSchema.
Other closed P1/P2 tasks (workspace_id/UUID identity, /shutdown auth, provider MCP registration, port de-hardcode, bootstrap gating, test-pollution and stale-close race fixes) all ship with tests that pass.

MINOR (optional, not blocking):
- tests/hub-service/installers.contract.test.ts second case is named "rejects a response with an extra/unexpected field (drift guard)" but InstallerSchema is non-strict, so it does not actually reject -- it only asserts the unknown key is dropped. For a true drift guard, use `.strict()` on the schema (or `InstallerSchema.strict().parse(...)`) so an unexpected wire field fails loudly.

Committed work is buildable, fully tested, and matches the acceptance criteria for what was completed; ready to harvest as a PR once the untracked root artifacts (recovery-backup tarball, local .agents/.codex tool config dirs) are removed from the working tree -- done as part of this harvest.

## [v0.3.3] -- feat/install-default

### Breaking change -- MCP server start command changed

> **Action required for users who manually manage their MCP config.**
>
> The binary no longer starts the MCP server when invoked with no arguments.
> The new default action is **installation**. The MCP server is now started
> with the explicit `apra-fleet run` subcommand.
>
> **Who is affected:** only users who edited their MCP config by hand and
> registered the binary with no arguments (e.g. `command: apra-fleet`,
> `args: []`). Users who installed via `apra-fleet install` or
> `apra-fleet update` are updated automatically -- the installer re-registers
> the MCP server with the correct `run` argument.
>
> **How to fix (manual config only):** change `args: []` to `args: ["run"]`
> in your provider's MCP config, then reload the MCP server.
>
> `--stdio` is kept as a backward-compat alias and still starts the server,
> so `args: ["--stdio"]` also works without any code change.

### Added

- **Install as default action** -- invoking the standalone binary with no
  arguments (including double-clicking `apra-fleet-installer-win-x64.exe` on
  Windows) now runs the installer instead of silently starting an MCP stdio
  server. This is the expected behavior for users who download the binary from
  the GitHub Releases page.

- **`apra-fleet run` / `apra-fleet start`** -- new subcommands that
  explicitly start the MCP server (stdio mode). All provider MCP configs
  written by the installer are updated to use `run` as the last argument.
  `--stdio` continues to work as a backward-compat alias.

### Changed

- **MCP config updated for all providers** -- the MCP server command
  registered during `apra-fleet install` now includes `run` as an explicit
  argument for every provider (claude, gemini, agy, codex, copilot, opencode).
  Example SEA mode: `{ "command": "/path/apra-fleet", "args": ["run"] }`.

- **Claude `mcp add` command handles all args** -- the `claude mcp add`
  command builder now quotes and joins all args (not just `args[0]`), which
  is required for npm/dev mode where both a script path and `run` must be
  passed.

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 2-5, sprint 2)

Sprint goal (P1/P2): complete tag-aware permission composition (Phase 2), skill matrix utility (Phase 3), permissions.md update (Phase 4), and tag filter in list_members (Phase 5). Phases 2-5 were implemented and tested; the full vitest suite passes (1593 tests, 0 failures). Integration tests (apra-fleet-2tl) are carried forward. Goal partially met -- all implementation tasks done, integration tests not started.

Completed: Phase 2 tag-aware permission composition with composeFromTags() and backward-compatible behavior; Phase 3 skill-matrix utility (getRequiredSkills) encoding the skill-matrix.md rules programmatically; Phase 4 permissions.md rewritten for tag-based composition; Phase 5 list_members tags filter with AND semantics. Example tag profiles (tag-gpu.json, tag-devops.json) added.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     20,661 |   n/a |   $0.000 |   $0.252 |
| reviewer   |          0 |      8,338 |   n/a |   $0.000 |   $0.125 |
| overhead   |      7,150 |     70,662 | +888% |   $0.121 |   $0.574 |
| TOTAL      |      7,150 |     99,661 | +1294% |   $0.121 |   $0.952 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **Tag-aware permission composition** -- `compose_permissions` now accepts a `tags` parameter. Reserved tags `doer`/`reviewer` set the primary mode; custom tags (e.g. `gpu`, `devops`) each load a `tag-<name>.json` profile and merge permissions additively. Unknown tags are silently ignored. When both `role` and `tags` are given, `tags` wins. The `composeFromTags()` function is byte-identical to the role-based `compose()` for single-mode tags -- full backward compatibility.

- **Example tag profiles** -- `tag-gpu.json` and `tag-devops.json` shipped under `skills/fleet/profiles/`. These are the reference profiles for GPU and DevOps tag merges.

- **Skill matrix utility** -- `src/utils/skill-matrix.ts` exports `getRequiredSkills(tags, vcs, project?)`, the programmatic encoding of `skills/fleet/skill-matrix.md`. Returns deduplicated, sorted skill names. Currently used in tests; not yet wired into the installer onboarding path.

- **list_members tags filter** -- `list_members` now accepts a `tags` string array. AND semantics: only members carrying all supplied tags are returned. Existing behavior (no filter = all members) is unchanged.

### Changed

- **skill-matrix.md** -- Role column renamed to Tag; semantics updated to clarify that tag values are the exact strings stored in `Agent.tags` and drive both skill selection and permission profile merging.

- **permissions.md** -- Rewritten to document tag-based composition: reserved doer/reviewer tags, custom tag profiles, additive merge, primary-mode extraction, and the four-step profile composition order.

### Carried forward

- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-4xe: Parent tracker for Phase 5 (close after 2tl lands) (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)

---

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 0-1)

Sprint goal: implement member category grouping (Phase 0, apra-fleet-j23) and the member tags data model, display, and validation layer (Phase 1, apra-fleet-9iw). Both phases were completed and the test suite passes (1560 tests, 95 files). Phases 2-5 and integration tests (04a, 51i, 6ky, 4xe, 2tl) were not started in this sprint and are carried forward.

Scope: Phase 0 merges PR #238 (category field + groupByCategory). Phase 1 adds tags?: string[] to the Agent model with Zod validation (max 10 tags / 64 chars each), displays tags in check_status and list_members compact and JSON output, and covers all boundaries in tests/tags.test.ts, tests/update-member.test.ts, and tests/category.test.ts.

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     22,200 |          0 | -100% |   $0.348 |   $0.000 |
| reviewer   |      9,360 |          0 | -100% |   $0.158 |   $0.000 |
| overhead   |      7,150 |     37,428 | +423% |   $0.121 |   $0.365 |
| TOTAL      |     38,710 |     37,428 |   -3% |   $0.627 |   $0.365 |
True-cost estimate (output x 4x): $2.507

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Added

- **Member category field** -- `register_member` and `update_member` now accept an optional `category` string. Members with the same category are grouped together in `check_status` and `list_members` output. Categories are sorted alphabetically; members with no category appear under `(uncategorized)` at the end. Empty string clears the category.

- **Member tags field** -- `register_member` and `update_member` now accept an optional `tags` array (up to 10 strings, max 64 chars each). Tags are displayed in compact and JSON output for `check_status` and `list_members`. Passing an empty array in `update_member` clears all tags.

- **groupByCategory utility** -- `src/utils/agent-helpers.ts` exports `groupByCategory<T>()`, a generic helper that buckets any item list by a string key, returning a sorted-key array with `(uncategorized)` always last. Used by check_status and list_members; reusable for other item types.

### Carried forward

- apra-fleet-04a: Phase 2 -- tag-aware permission composition (P1)
- apra-fleet-9iw: Phase 1 parent tracker -- open until all sub-tasks land (P1)
- apra-fleet-51i: Phase 3 -- tag-aware skill matrix (P2)
- apra-fleet-6ky: Phase 4 (apra-fleet) -- update permissions.md for tag composition (P2)
- apra-fleet-4xe: Phase 5 -- tag-based member selection in list_members (P2)
- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased] -- feat/auto-sprint (auto-sprint pipeline)

Sprint goal: implement the full auto-sprint.js install pipeline -- submodule pin
(zbl), AssetManifest.workflows field (vqe), cost.js extraction and workflow copy
step (b8c), claude-only Skill/Workflow permissions (ano), and extended tests for
all eight agents / cost.js / workflow paths (96j). All five goals were delivered
in two cycles; build is clean and the full test suite (92 files, 1531 tests)
passes with zero failures.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     45,503 |   n/a |   $0.000 |   $0.682 |
| reviewer   |          0 |     19,192 |   n/a |   $0.000 |   $0.288 |
| overhead   |      7,150 |     53,729 | +651% |   $0.121 |   $0.473 |
| TOTAL      |      7,150 |    118,424 | +1556% |   $0.121 |   $1.444 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **auto-sprint workflow install** -- `apra-fleet install --skill pm` now writes
  `cost.js` to the PM skill directory for every provider that supports PM.
  `cost.js` is a CJS-wrapped extract of the seven pure cost-computation functions
  (`computeSprintQuote`, `computeSprintAnalysis`, `buildSprintSummary`, etc.) from
  `vendor/apra-pm/.claude/workflows/auto-sprint.js`. For Claude specifically, the
  full `auto-sprint.js` workflow is also copied to `~/.claude/workflows/`.

- **Claude permissions for auto-sprint** -- for Claude + PM installs, the
  installer now adds `Skill(auto-sprint)` and `Workflow(auto-sprint)` to the
  Claude Code allow-list via `mergePermissions`. Other providers receive no change;
  OpenCode skips `mergePermissions` entirely (its permission model is per-agent
  frontmatter, not a top-level config key).

- **AssetManifest.workflows field** -- `AssetManifest` now has a `workflows`
  field. `buildDevManifest` populates it from `vendor/apra-pm/.claude/workflows/`
  (falling back to `dist/workflows/`). `gen-sea-config.mjs` embeds
  `auto-sprint.js` as a named SEA asset. `vendor-pm.mjs` copies the workflows
  directory to `dist/workflows/` on `prepublishOnly` so npm global installs work
  without the submodule.

- **apra-pm submodule pinned to 262aef8** -- `vendor/apra-pm` is now pinned at
  commit 262aef8 (previously d141720), which carries the `auto-sprint.js`
  workflow with PURE_FUNCTIONS_BEGIN/END markers.

- **/auto-sprint completion output** -- claude+PM installs now print a
  `/auto-sprint` usage hint at the end of the install sequence.

### Carried forward

- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased]

### Added

- **OpenCode provider** -- OpenCode is now a first-class provider
  (`apra-fleet install --llm opencode`). It works with any OpenAI-compatible
  endpoint (Ollama, vLLM, etc.) for self-hosted and local models. The model
  endpoint is the user's responsibility; Fleet installs the CLI and agents but
  does not provision the inference server. See
  [docs/opencode-exploration.md](docs/opencode-exploration.md) for background.

- **Per-member model tiers** -- `register_member` now accepts an optional
  `model_tiers` map (`{ cheap, standard, premium }`) so each member can specify
  which models to use at each tier. Particularly useful for OpenCode members
  where models vary by deployment. A single-model entry fills all three tiers.
  When no map is set, the provider adapter's defaults are used.

- **PM agent installation** -- the installer now writes 4 PM agent definitions
  (planner, plan-reviewer, doer, reviewer) to each provider's agents directory
  (e.g. `~/.claude/agents/`, `~/.config/opencode/agents/`). For OpenCode,
  agent frontmatter is transformed from Claude format to OpenCode format
  (tools allowlist -> permission map, mode: subagent). Codex and Copilot skip
  agent installation (no agent system).

### Changed

- **PM skill sourced from apra-pm submodule** -- the PM skill is now vendored
  from the [apra-pm](https://github.com/Apra-Labs/apra-pm) git submodule at
  `vendor/apra-pm/` instead of being maintained inline. All gap-ported features
  from the old inline skill (sprint selection, operational rules, provider
  awareness, fleet addendum, simple sprint, resume rules, documentation harvest)
  are included. The skill is backward compatible -- all `/pm` commands, state
  file names (PLAN.md, progress.json, feedback.md, status.md), and beads
  lifecycle hooks are preserved.
