# apra-fleet npm Packaging -- Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 01:04:05-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> This is a first-pass review (the prior feedback.md commits in history belong to
> unrelated sprints; no PLAN.md predecessor to diff against).

---

## 1. Requirements coverage: Scope and Acceptance Criteria

I walked each Scope item in `.sprint/requirements.md` against the plan and the codebase.

- **Req 1 (package.json)** -- PASS. Task 1 covers `bin`, `files`, `engines.node>=22`,
  `publishConfig.access=public`, `prepublishOnly`, `repository`, scoped name, description/author.
  The plan correctly adopts the *targeted* `scripts/` whitelist (S6.3 variant) rather than the
  bare `scripts/` glob, which is the better of the two options the design doc left open -- it
  keeps the seven build-only `.mjs` files out of the tarball. The "no shebang script needed"
  invariant is honored: I confirmed `src/index.ts:1` is `#!/usr/bin/env node` and Task 2/VERIFY
  re-checks it survives `tsc`.

- **Req 2 (install.ts gates + npm detection + service manager)** -- PASS with a justified
  reduction. The requirement text and design S8.1 call for teaching the *service manager*
  (windows.ts/linux.ts/macos.ts) to register a `node <script.js>` command. I verified against
  the codebase: `src/services/service-manager/` **does not exist**, there is no `serviceStep`,
  no `register()`/`unregister()`, and `install.ts` has **no OS service registration step at
  all**. The plan therefore cannot "remove the isSea() gate from service registration" (S8.1)
  because there is no such gate -- the only `isSea()` gates that exist are binary-copy (494),
  MCP config (548), skill extraction (578/595), and the running-process guard (469). Task 5
  correctly targets exactly those four. The npm-detection (`isNpmGlobalInstall()`),
  binary-copy three-branch, MCP-config `node <abs-path>` rewrite, and the running-process-guard
  extension are all present and correctly line-cited (I confirmed each line number against the
  file). This is the right scope for what the repo actually supports.

- **Req 3 (update.ts npm redirect + skill-refresh reminder)** -- PASS. Task 7 adds the early
  return with `npm update -g @apra-labs/apra-fleet` and the `apra-fleet install` skill-refresh
  reminder (S14.4). I confirmed `update.ts` currently has no `isSea` import and that `isSea()`
  in install.ts is **not exported** (only `_setSeaOverride` is) -- Task 7 correctly notes it
  must add `export`. Good catch by the planner; the design doc's parenthetical ("already
  exported as `_setSeaOverride` exists") is loose, but the plan resolves it correctly.

- **Req 4 (version.ts ESM fallback)** -- PASS. I read `version.ts`: the dev fallback uses
  `require('node:fs')` and bare `__dirname` (lines 15-19), which throw under ESM, so npm users
  get `v0.0.0-unknown`. Task 3 refactors via `import.meta.url` + `typeof __dirname` detection,
  keeps the `BUILD_VERSION` SEA path first, and preserves synchronicity (required because
  `serverVersion` is a module-scope const). Correct.

- **Req 5 + Req 6 (service overwrite warning S14.2; status/health mode reporting S14.3)** --
  **DESCOPE JUSTIFIED.** This is the load-bearing judgement call. I verified all three
  premises the descope rests on:
  - No `src/cli/status.ts` and no `status`/`start`/`stop`/`restart` CLI dispatch in
    `index.ts` (the dispatch table is install/secret/uninstall/auth/update/default only --
    design S1.3's claim that these commands exist is wrong).
  - No `/health` endpoint anywhere in `src/` (grep returned nothing).
  - No service-manager infrastructure, so there is no unit/bat/plist to read back and compare
    for the S14.2 overwrite warning.
  Both Req 5 and Req 6 are therefore **un-buildable as written** -- they depend on code the
  design doc assumed but that is not in the repo. The plan does not silently drop them: it
  substitutes a `getDeliveryMode()` / `getDeliveryInfo()` utility (Task 9) and surfaces
  mode + binary path in `--version` output, which delivers the *diagnostic intent* of S14.3
  (a user can tell which delivery mode is active) through the one channel that does exist.
  The service-overwrite warning (S14.2) is genuinely deferred and is recorded as such in the
  Risk Register. I judge this honest and correct: building a status CLI and a health endpoint
  from scratch is a separate sprint, not a line item hidden inside npm packaging. **NOTE for
  the orchestrator:** acceptance criterion line 78 ("`apra-fleet status` reports delivery
  mode") cannot be literally satisfied because the command does not exist; the plan satisfies
  it via `--version` instead. This is a requirements/reality mismatch the planner inherited,
  not a planning defect -- but the PM should explicitly accept the `--version` substitution
  when signing off, since the written acceptance text references a nonexistent command.

- **Req 7 (CI npm-publish job)** -- PASS. Covered below in section 4.

**Acceptance criteria** (requirements lines 71-80): pack-dry-run whitelist (Task 1 + Task 2
+ Phase 7), local tarball install smoke (Task 2, Task 13), full suite + new tests + SEA build
green (every VERIFY + Task 13 step 10), mode reporting (Task 9, via `--version`), CI job
present-and-not-triggered (Task 11/12), reviewer-approved-PR-not-merged (process). All mapped.

---

## 2. Risk-first ordering

PASS. The requirements name the riskiest assumption explicitly (lines 82-87): that the
dev-mode asset path (`findProjectRoot` 2-hop) and the ESM `dist/*.js` entry already work for
npm without architectural change. Phase 1 (Tasks 1-2) does exactly the right thing -- it puts
a real `npm pack` + local global install + `--help` + shebang check *before any code is
written on top*. If the global install fails or the shebang is absent, the whole approach is
invalidated at the cheapest possible point, before version.ts/install.ts/update.ts work
begins. Task 2's "Done when" explicitly makes invalidation a stop condition. This is textbook
risk-first sequencing.

One nuance: `--version` will still print `v0.0.0-unknown` at Phase 1 (version.ts is not fixed
until Phase 2). The plan calls this out in Task 2 so it is not mistaken for a failure. Good --
that is the kind of expectation-setting that prevents a false abort.

---

## 3. Per-task "Done when" criteria and test coverage

PASS. Every code task is paired with a test task in the very next slot (3->4, 5->6, 7->8,
9->10, 11->12), satisfying the requirements' "all new behaviour is unit tested, no change
merges without tests" mandate (lines 61-63). The "Done when" criteria are concrete and
machine-checkable: they name the exact command (`node dist/index.js --version`), the exact
expected string transition (`v0.0.0-unknown` -> real semver), the exact files that must/must
not appear in `npm pack --dry-run`, and the exact regression guard (existing `install.test.ts`
uses `_setSeaOverride(false)` and must stay green -- I confirmed `_setSeaOverride` exists at
install.ts:22).

Specific strengths:
- Task 4 covers all four version.ts branches (ESM, CJS/SEA via BUILD_VERSION, fallback,
  git-hash) and correctly notes `vi.resetModules()` is needed because `serverVersion` is a
  module-scope const.
- Task 12 anticipates that `js-yaml` is not a dependency (I confirmed it is absent from
  node_modules) and prescribes a regex/line-based structural assertion instead. That avoids
  introducing a devDependency just for a test.

Minor, non-blocking observations (do not require a re-plan):
- **Task 5 `isNpmGlobalInstall()` heuristic is the one genuinely fuzzy spec.** "`process.argv[1]`
  contains `node_modules` AND is not the dev dist path" is sound for the global-install and
  dev cases, but two developers could implement the dev-path exclusion differently (string
  compare vs `findProjectRoot()` join vs realpath). Task 6 pins the *behavior* with three
  explicit cases (npm true, dev false, SEA false), which constrains the ambiguity enough that
  the test is the contract. Acceptable, but the doer should make the dev-path check robust to
  path separators and symlinks (npm global dirs are often symlinked, e.g. nvm), since
  `process.argv[1]` may be a realpath while `findProjectRoot()` is not. Flagging as an
  implementation watch-item, not a plan defect.
- **Task 9** assigns `getDeliveryInfo().binary` to `process.argv[1]` for both npm and dev,
  which is correct, but note `process.argv[1]` can be undefined in some embed contexts; a
  `?? process.execPath` guard would harden it. Test Task 10 should assert the npm and dev
  binary values to lock this.
- **ASCII constraint:** install.ts:504 already contains a non-ASCII em-dash ("Dev mode -- "),
  which means the pre-commit ASCII hook does not retroactively scan unchanged lines. The risk
  register flags this. Any task that *edits the surrounding block* (Task 5 edits 494-505) will
  bring that line into the diff and may trip the hook -- the doer should normalize it to `--`
  while in there. Captured in the risk register already.

---

## 4. Hard constraint: NO actual npm publish

PASS -- confirmed at multiple layers.

- Task 11 authors the `npm-publish` job with `if: startsWith(github.ref, 'refs/tags/v')`. I
  confirmed the existing `ci.yml` triggers the workflow on tag pushes matching `v*`, and the
  sprint pushes no such tag, so the job is authored but never enters its run condition.
- No task anywhere runs `npm publish` against the live registry. I read every task: Task 2 and
  Task 13 run `npm pack` / `npm pack --dry-run` / local `npm i -g ./*.tgz` only -- all of which
  the requirements explicitly bless (line 56: dry-run/local pack is fine; live publish is not).
- The actual `npm publish --access public --provenance` line lives **only inside the
  tag-gated CI job body** (design S13.2), guarded additionally by the `check-published`
  idempotency step and requiring `secrets.NPM_TOKEN` (a human-provisioned secret the sprint
  does not set). Three independent gates: tag condition, missing secret, idempotency check.
- Task 12 adds a structural test asserting the job exists, is tag-gated, has
  `id-token: write`, and that `release` does NOT list `npm-publish` in `needs` (matching design
  S13.6's independent-consumer graph). This locks the safety properties against future edits.

The constraint is satisfied and defended in depth.

---

## 5. Tier vs concrete model assignment (informational)

Every task carries `Tier: cheap` (Task 1 only) or `Tier: standard` (all others). No task is
tier `premium`, and tiers are monotonically non-decreasing within each phase (Phase 1 goes
cheap -> standard; every other phase is uniformly standard), satisfying the no-downgrade-mid-
phase rule. For *execution* this is sufficient as a routing signal, but it is **not** a
concrete model binding -- the orchestrator's tier->model map must resolve "standard" to an
actual model. My assessment: the tiering is appropriately conservative. The two validation-only
tasks (2 and 13) are correctly marked `standard` despite running no code, because they require
judgement to interpret pack output and smoke-test results. The single `cheap` task (package.json
field edits) is genuinely mechanical. No task here needs `premium`: the hardest reasoning is the
`isNpmGlobalInstall()` heuristic and the version.ts ESM refactor, both well-bounded single-file
changes. **Recommendation to orchestrator:** the tier labels are execution-ready as-is; no
per-task model pinning is required, but if the tier->model map treats "standard" as a mid
capability, confirm it is strong enough for the version.ts ESM refactor (Task 3) and the
install.ts multi-gate edit (Task 5), which are the two tasks where a too-cheap model would most
likely introduce a regression in the SEA path.

---

## 6. Cohesion, coupling, dependencies, DRY

PASS. Phase boundaries fall on clean cohesion lines: Phase 1 (packaging+validation), Phase 2
(version), Phase 3 (install gates), Phase 4 (update), Phase 5 (delivery-mode utility), Phase 6
(CI), Phase 7 (E2E). Each phase produces a reviewable, testable increment sharing one code path.

The key shared abstraction -- `isNpmGlobalInstall()` -- is introduced in the earliest phase
that needs it (Task 5, Phase 3) and is correctly reused downstream by Task 7 (update redirect)
and Task 9 (`getDeliveryMode`), with explicit `Blockers: Task 5` on both. That is proper DRY
and a correctly declared dependency chain. `isSea()` export is added once (Task 7) and reused
by Task 9. No abstraction is duplicated. The dependency graph is acyclic and ordered: every
"Blockers" entry points to an already-completed earlier task, and the test task always blocks
on its code task. Phase 6 (CI) is correctly noted as parallelizable but is sequenced last-ish
for monotonic tiering -- a reasonable, harmless ordering choice.

Each task is single-session sized: one file (or one file + a one-line export), or one new test
file. Nothing sprawls.

---

## 7. Risk register

PASS, and notably thorough. The register contains 10 entries covering exactly the landmines I
would have added myself: the design-doc-vs-reality drift (correctly rated "Confirmed"), the
version.ts ESM break, scoped-name availability, SEA regression, the scripts-whitelist
maintenance tradeoff, the Node>=22 engine gate, the npm-mode process-detection gap
(`isApraFleetRunning` matches `apra-fleet` not `node`), the no-publish constraint, the ASCII
hook, and the partial-coexistence descope. I have no additional risks to add -- the one I
probed for (symlinked npm global dirs defeating the `isNpmGlobalInstall` dev-path check) is a
sub-case of the existing "npm mode process detection" / heuristic-robustness theme and is
adequately captured by Task 6's behavioral tests. The mitigations are concrete and tied to
specific tasks, not hand-waving.

---

## Summary

**APPROVED.** The plan is faithful to the requirements' *intent* while being honest about the
gap between the authoritative design doc and the actual repository. I independently verified the
planner's central claim -- that the service-manager (`windows.ts`/`linux.ts`/`macos.ts`), the
`status` CLI command, and the `/health` endpoint referenced by design S1.7/S14.2/S14.3 simply
do not exist in `src/` -- and it holds. The descope of Req 5/Req 6 is therefore justified, not
a dropped deliverable; the diagnostic intent of S14.3 is preserved through `--version` mode
output, and the deferral is recorded in the risk register rather than buried.

What passed: risk-first ordering (real `npm pack` + global install gates everything in Phase 1),
full test pairing for every code change (requirements' hard mandate), the no-live-publish
constraint (tag-gated job + missing secret + idempotency, with no `npm publish` in any task),
clean phase cohesion with a single correctly-placed shared abstraction (`isNpmGlobalInstall`),
and a thorough risk register.

What the orchestrator/PM should note (none blocking):
1. Acceptance line 78 literally references `apra-fleet status`, which does not exist; the plan
   satisfies it via `--version`. PM should explicitly accept that substitution at sign-off.
2. Task 5's `isNpmGlobalInstall()` dev-path exclusion should be hardened against
   symlinked/realpath'd npm global dirs and path-separator differences; Task 6's behavioral
   tests are the contract that pins it.
3. Tier labels are execution-ready; confirm the tier->model map resolves "standard" to a model
   strong enough for the two regression-sensitive tasks (Task 3 version.ts ESM, Task 5 install
   gates).

What is deferred (intentionally, to a future sprint with the right infrastructure): the S14.2
service-overwrite warning and a full `status`/`/health` mode report, both of which require
service-manager and status-CLI code that does not yet exist.

Relevant paths:
- C:\akhil\git\apra-fleet\PLAN.md
- C:\akhil\git\apra-fleet\.sprint\requirements.md
- C:\akhil\git\apra-fleet\docs\npm-packaging-plan.md
- C:\akhil\git\apra-fleet\src\version.ts (lines 14-41: CJS-only dev fallback to fix)
- C:\akhil\git\apra-fleet\src\cli\install.ts (gates at 469, 494, 548, 578, 595; isSea unexported at 24)
- C:\akhil\git\apra-fleet\src\cli\update.ts (no isSea import today)
- C:\akhil\git\apra-fleet\src\index.ts (CLI dispatch: no status/start/stop/restart)
