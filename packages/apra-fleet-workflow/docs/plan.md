# Remediation Plan, Round 2: apra-fleet-workflow + apra-fleet-se/auto-sprint

**Date:** 2026-07-11
**Input:** `docs/feedback-reassessment.md` (new findings N1-N18, plus F/A residues folded into
them: F3's inert budget -> N10, F6's replay defects -> N5/N6, F10's plan-reviewer scope -> N1,
A7's re-entry -> N3).
**Supersedes:** the round-1 plan (epic `apra-fleet-unw`, closed). Git history preserves it.
**Tracking:** beads epic `apra-fleet-unw2` with 20 child issues. This document is a map onto
the beads DB, not a duplicate of it -- each issue's description is self-contained (finding
refs, file scope, work items, acceptance criteria). Run `bd ready` for the next unit(s);
`bd show <id>` for the full spec.

**Ordering principle (different from round 1):** round 1 was derived bottom-up (harness ->
contracts -> phases -> verification) because nothing was verifiable. That foundation now
exists and is green (WF 86/86, SE 95/95). Round 2 is ordered strictly by SEVERITY: the
reassessment's center of gravity is seam defects between independently-approved halves, and
the most severe one (N1) breaks every real sprint. So: Group A (critical contract
realignment + its regression tripwire) first, then Group B (highs), Group C (mediums),
Group D (lows), with a parallel vendor track.

**Hard constraints (unchanged from round 1):**

- No changes to the apra-fleet MCP server (`apra-fleet.exe`, external repo).
- **NO push of vendor/apra-pm to `Apra-Labs/apra-pm`.** All vendor work stays on the local
  branch `tmp/unw13-vendor-agent-defs` (worktree `C:\akhil\git\wt-unw13\vendor\apra-pm`),
  unpushed, pending the user's explicit sign-off. This plan does not change that gate.
- Outer-repo work lands on `feat/fleet-reorg` via the ritual below.

---

## 1. State of the world this plan assumes (verified 2026-07-11, post-merge)

- `feat/fleet-reorg` HEAD `2d621dc`: the `contracts.mjs` consumer-side rename
  (`<role>.json` -> `<role>-output.json`) and the fixture regeneration
  (`SE/test/fixtures/vendor-apra-pm-schemas/*-{input,output}.json`) HAVE merged since the
  reassessment was written. N2's "rename already broke the lookup" clause is therefore
  resolved; N2's remaining scope is fallback observability + fixture/vendor consistency
  (Group B below).
- The authoritative vendored role contracts live at
  `C:\akhil\git\wt-unw13\vendor\apra-pm` on local branch `tmp/unw13-vendor-agent-defs`
  (HEAD `352a5c8`), NOT at the outer repo's stale submodule pointer. Exact contract
  requirements the runner must satisfy (read from the real files, do not re-derive):
  - `agents/schemas/plan-reviewer-input.json`: required `["scope"]` (string -- "the sprint
    root / open beads subtree this review pass covers").
  - `agents/schemas/doer-input.json`: required `["branch"]` (string -- sprint track branch).
  - `agents/schemas/reviewer-input.json`: required `["base-branch", "branch"]`.
  - `agents/schemas/harvester-input.json`: required
    `["analysisArtifactFile", "analysisText", "costAnalysis", "base-branch", "branch"]`.
  - `agents/planner.md` Step 3: model tier is recorded via
    `bd create ... --metadata '{"model": "..."}'` and NOWHERE else (explicitly "not in
    `--notes`"); `agents/plan-reviewer.md` criterion 10 hard-fails any task missing the
    `model` METADATA key.
- Paths as in the reassessment: `WF` = `packages/apra-fleet-workflow`,
  `SE` = `packages/apra-fleet-se`, `VP` = `wt-unw13/vendor/apra-pm`.

---

## 2. The per-issue ritual (binding, replayed for every issue)

Same core ritual as round 1, with the model tier now carried as concrete metadata:

| Step | Actor | Action |
|------|-------|--------|
| 1. Claim | Orchestrator (separate Claude Code session) | `bd update <id> --claim`; read `bd show <id>` and the cited reassessment finding(s). |
| 2. Implement | **Doer agent** on the model named in the issue's `--metadata` `model` key (`fable`/`opus`/`sonnet`/`haiku`) | Works in an **isolated git worktree** (one per issue -- parallel doers NEVER share a checkout). Implements strictly within the issue's declared "Scope (files)". Writes/extends tests named for the finding IDs. Commits on its issue branch. **Never merges, never closes its own issue.** |
| 3. Test run | Cheap/background agent | Runs `npm test` (package-scoped + full workspace) and reports pass/fail + failure text verbatim -- an independent execution, never the implementer's claim. |
| 4. Adversarial review | **Separate reviewer agent, fresh context, at or above the doer's model tier** (review must never be weaker than the work it judges) | Independently re-verifies every claim: re-runs the tests, reads the full diff, hand-constructs adversarial inputs for the failure scenario the finding describes (e.g. for N3: a `newTasks.title` containing `` $(...) ``, backticks, trailing `\`). Checks scope fence, acceptance criteria, revert-sensitivity of tests. Verdict: **APPROVED** (close) or **CHANGES NEEDED** with file:line findings (reopen). |
| 5. Merge + close | Orchestrator only | On APPROVED: merges the issue worktree's branch into `feat/fleet-reorg` **serially** (one merge at a time, re-running the suite after each), then `bd close <id>`. CHANGES NEEDED -> back to step 2, max 3 rounds, then escalate to the human. Never proceed unapproved. |

**Anti-drift guardrails (unchanged from round 1):** scope fence enforced by the reviewer;
mid-issue discoveries become `bd create --deps discovered-from:<id>` issues, never inline
fixes; issue N+1 in a dependency chain does not start until N is closed.

### Vendor-submodule work pattern (read this if your issue touches vendor/apra-pm)

New doer agents do not have this session's history, so the pattern is spelled out:

- The ONLY current source of truth for vendored agent defs is the worktree checkout
  `C:\akhil\git\wt-unw13\vendor\apra-pm`, local branch `tmp/unw13-vendor-agent-defs`
  (unpushed; `Apra-Labs/apra-pm` upstream does NOT have this work).
- **NEVER run `git submodule update --init` (or `--remote`) for vendor/apra-pm** -- it
  fetches the stale upstream and can clobber/hide the local branch. Do not touch the outer
  repo's submodule pointer in this round at all.
- To work on a vendor issue, use the established two-level-worktree pattern:
  1. Create your outer-repo worktree for the issue as usual.
  2. Inside it, do NOT init the submodule. Instead create a nested worktree of the wt-unw13
     checkout: `git -C C:/akhil/git/wt-unw13/vendor/apra-pm worktree add
     <your-vendor-workdir> -b tmp/<issue-id>-vendor tmp/unw13-vendor-agent-defs`
     (i.e. fork from the CURRENT tip of `tmp/unw13-vendor-agent-defs`).
  3. Commit vendor changes on your `tmp/<issue-id>-vendor` branch. The reviewer reviews
     that branch. On APPROVED, the orchestrator fast-forwards/merges it back into
     `tmp/unw13-vendor-agent-defs` inside the wt-unw13 checkout -- still unpushed.
- Nothing in this plan pushes vendor/apra-pm anywhere. Upstream PR + submodule bump remain
  a separate, user-gated step.

---

## 3. Execution groups (severity-ordered) -> beads issues

Epic: **`apra-fleet-unw2`** -- `[EPIC] Remediate feedback-reassessment.md findings (N1-N18)` (P1).

Every issue carries `--metadata '{"model": "<fable|opus|sonnet|haiku>"}'` naming the doer
model. Reviewer runs at >= that tier.

### Group A -- CRITICAL: runner/vendor contract realignment + its tripwire (P1)

These two can START in parallel (.2 needs only the read-only vendored input schemas); the
orchestrator merges .1 first, then .2's test must pass against the fixed runner.

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.1` | opus | **N1** (all three divergences; absorbs F10 residue) | Outer repo, `SE/auto-sprint/runner.js`: (a) `buildPlannerPrompt` switches from `bd update ... --notes="model: <tier>"` to `bd create ... --metadata '{"model": "..."}'` per `VP/agents/planner.md` Step 3, and updates the long convention comment (runner.js:259-306); (b) replace the context-free plan-reviewer dispatch (`'Review the plan per your agent contract.'`, runner.js:739) with a real prompt builder supplying the sprint root/scope (`scope` = target issue ids + goal) per `plan-reviewer-input.json`; (c) `buildDoerPrompt` (runner.js:410) gains the required `branch`. All three verified against the REAL vendored files at wt-unw13 (section 1 above), not guessed. Mock personas in `advanced-mock-runner-test.mjs` updated to ENFORCE the contracts (reject dispatches missing scope/branch/metadata convention) so the mock obeys the CONTRACTS, not the runner. |
| `unw2.2` | opus | **N13** (regression guard for N1's whole failure class) | Outer repo, `SE/test/`: a static contract test that, for each role runner.js dispatches, builds the same context object the corresponding prompt builder consumes and asserts `validateRoleInput(role, ctx).valid` against the real vendored `<role>-input.json` schemas (fixture snapshot mirrors them; `contracts.mjs` already exposes `validateRoleInput`). Harvester is included with an explicit expected-fail/skip marker referencing `unw2.13` (its inputs are wired there). Acceptance: the test FAILS on the pre-`unw2.1` runner for exactly the three N1 divergences (that failure is the proof the tripwire works) and passes after `unw2.1` merges. Also add the process note from N1's fix direction (e): the vendor sign-off checklist must include re-running this test against any candidate submodule commit. |

### Group B -- HIGH (P1/P2)

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.3` | sonnet | **N3** shell injection via reviewer `newTasks` -> `bd create` (P1) | Outer repo, `SE/auto-sprint/runner.js:1039-1047` (+ tests): validate before interpolation -- `priority` must match `/^P[0-4]$/` (typed failure otherwise); title/description allowlisted to a safe character class (given Windows/POSIX member-shell divergence, allowlisting over escaping); rejected task -> logged + surfaced, never executed. Regression test hand-constructs `` $(...) ``, backtick, and trailing-`\` payloads and asserts no shell metacharacters reach `command()`. |
| `unw2.4` | opus | **N4** branch ensured on one member only; unspecified multi-member topology (P1) | Outer repo, `SE/auto-sprint/runner.js` + `SE/bin/cli.mjs` + docs: (a) dispatch the branch-ensure to EVERY member in the union of orchestrator/doer/reviewer pools before the first doer round; (b) add a CLI-precondition topology check (compare `git rev-parse` / beads DB identity across members; refuse to start on mismatch unless single-member); (c) document that single-member (or shared-workspace) is the only SUPPORTED real-fleet mode until cross-member bd/git sync exists (deferred, section 5); (d) extend the mock so git/gh commands and beads state can be per-member, and add a 2-member regression test that fails on the pre-fix behavior. Decision (made here, not re-decided by the doer): ensure-everywhere + validate-shared-state, not a sync layer. |
| `unw2.5` | sonnet | **N2** residue: silent-fallback observability (rename itself already merged, see section 1) | Outer repo, `SE/auto-sprint/contracts.mjs` + `SE/test/`: (a) when `vendor/apra-pm/agents/schemas/` EXISTS but an expected `<role>-output.json` is absent, warn loudly (console.warn + emitted event) with an explicit allowlist for roles that legitimately have none (planner); full-directory absence (submodule not initialized) stays the quiet documented fallback; (b) a consistency test: when the vendored dir exists, every resolved SCHEMAS entry came from a vendored file AND each fallback literal deep-equals its vendored counterpart (failure = update the literal in the same commit as any bump); (c) a small script to regenerate `SE/test/fixtures/vendor-apra-pm-schemas/` mechanically from a vendored checkout, plus a test that the fixture matches what the script would produce. |

### Group C -- MEDIUM (P2)

Two chains, ordered inside each chain by file-region coupling (all `runner.js` issues are
serialized to keep orchestrator merges conflict-free; likewise the WF replay-path issues):

**Runner chain (continues from `unw2.4`):**

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.6` | sonnet | **N8** `lastReviewVerdict` lifecycle | `runner.js`: reset `lastReviewVerdict = null` at the top of each cycle; treat CHANGES_NEEDED with empty `reopenIds` AND empty `newTasks` as a reviewer contract violation (retry the review once, then surface distinctly -- never silently stall); add a "re-review before exit" dispatch when the exit check would otherwise rely on a verdict from an earlier cycle. Tests for both scenarios in N8 (stale-approval exit, unsatisfiable-exit misreported as stalled). |
| `unw2.7` | sonnet | **N9** stall detection defeated by close/reopen oscillation | `runner.js`: progress = new all-time-high of the closed count (high-water mark), not any change; additionally flag any bead reopened more than K times (K=3) as thrash and surface it in the stall error. Regression test drives the 5,4,5,4 oscillation and asserts stall-abort fires. |
| `unw2.8` | sonnet | **N10** cost/budget pipeline inert (F3 residue) | `runner.js` + `WF/src/workflow/pricing.mjs` + docs: after `unw2.1`, the planner records `{"model": ...}` metadata -- the runner reads it back (`bd show` already fetched for dispatch) and passes `opts.model` on doer dispatches, plus a documented default model for the fixed roles; refresh the pricing table with current per-model rows for the four fleet models, clearly labeled estimates; document that budget enforcement is estimate-based until the fleet echoes the resolved model (server-side, deferred). Test: a mock sprint accrues nonzero `_spent` and can trip `BudgetExceededError`. |
| `unw2.9` | sonnet | **N11** publish phase not idempotent, verdict-blind | `runner.js` + mock: `gh pr view <branch>` before `gh pr create` (or parse "already exists" and continue); include the final verdict (PASS/FAIL) in PR title/body; explicit decision: a FAIL verdict still publishes, with the verdict stated in the body (human reviews); extend the mock with an injectable git/gh failure mode and add the re-run-same-branch regression test. |
| `unw2.10` | sonnet | **N12** harvester dispatch violates its own contract | `runner.js`: wire real values for the five required harvester inputs -- `analysisArtifactFile` (chosen path under the repo), `analysisText` (assembled from the run's event stream/journal), `costAnalysis` (from the budget object, honest "unknown" lines where cost is null), `base-branch`, `branch` -- and delete the "treat as UNAVAILABLE" instruction; flip `unw2.2`'s harvester expected-fail marker to green. Do NOT change the vendored contract (runner-side wiring chosen over contract loosening). |
| `unw2.11` | sonnet | **N15** `'Orchestrator'` casing/enum stray | `runner.js`: handle `orchestrator` deliberately as a documented application-level pseudo-role (not added to vendored ROLES); normalize all `roleMap` keys via `normalizeRole()` at validation time; test that `roleMap: { orchestrator: [...] }` is honored. |

**WF replay/extraction chain (independent of the runner chain):**

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.12` | sonnet | **N7** `command()` double `activity:end` | `WF/src/workflow/index.mjs`: mirror `agent()`'s catch (skip re-emission for WorkflowError before `softFail()`); journal test asserting exactly one `activity:end` per activity id on the failure path. |
| `unw2.13` | sonnet | **N5** replay breaks the failSoft contract (F6 residue) | `WF/src/workflow/{index,journal}.mjs`: journal the failSoft flag or the shaped result; on replay, reconstruct the shape the caller asked for. Resume test whose journal includes a probe command; assert Deploy/Integ are NOT silently skipped on replay. |
| `unw2.14` | opus | **N6** replay keys sequence-numbered through `parallel()` (F6 residue) | `WF/src/workflow/{index,journal}.mjs`: per-branch sub-sequences -- `parallel()` already forks the store; give each fork `activitySeq = { value: 0, prefix: parentSeq + ':' + branchIndex }` (or equivalent order-independent keying); emit a hinting `journal:diverged` warning when divergence occurs inside a parallel region; document the semantics. Also absorbs the N18 doc item: document (and test) that replayed agent activities re-debit the budget (total-spend semantics). Resume test with a 2-streak parallel develop phase asserting cache hits across the barrier. |
| `unw2.15` | sonnet | **N17** fenced-block preference hides valid JSON | `WF/src/workflow/index.mjs` `extractStructuredOutput()`: try fenced candidates first, then FALL THROUGH to the balanced scan of the remaining text instead of either/or. Test: reply with a fenced shell snippet + valid JSON outside the fences parses without burning repair attempts. |

### Group D -- LOW (P3)

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.16` | sonnet | **N14** CLI robustness | `SE/bin/cli.mjs`: `parseArgs` strict (unknown flags fail loudly); missing members abort unless `--allow-missing-members`; expose `--requirements-file` and `--role-map` so the skill-advertised features are reachable; run the `bd show` issue precondition on the orchestrator MEMBER (or document the local/member DB seam and verify both); `--viewer-port` flag + `error` handler on `server.listen`. |
| `unw2.17` | sonnet | **N16** unw.19 determinism fixes unprotected | `SE/test/`: a 3-bead golden variant that snapshots ONLY the order-sensitive artifacts (streak-assignment prompt text, reviewer prompt's bead-id list), sidestepping the parallel-completion race the single-bead golden rightly avoids. Acceptance: reverting the runner.js sort lines (806-807, 850-851, 979-984) fails this test. |
| `unw2.18` | haiku | **N18** runner minors | `runner.js`: add `deferred` to `NOT_DONE_STATUSES` (+ exit-check test with a deferred goal-priority bead); wrap the reviewer prompt's embedded `bd show --json` in `wrapUntrustedBlock` for A7 consistency. |
| `unw2.19` | haiku | **N18** viewer cancelled state | `WF/src/viewer/index.mjs:359`: treat `cancelled` as terminal in the browser poll error path so a CANCELLED run does not render OFFLINE. |

### Vendor track (parallel; two-level-worktree pattern from section 2; NEVER pushed)

| Issue | Model | Finding | Fix |
|---|---|---|---|
| `unw2.20` | sonnet | **N18** vendored defs instruct `bd remember` (round-1 V4 parenthetical, still unresolved) | `VP/agents/{doer,reviewer,integ-test-runner}.md`: `bd remember` does not exist in the current `bd` CLI -- replace with a real command (`bd note` / `bd comment`) or remove the instruction, consistently across the three files. Fork from the CURRENT tip of `tmp/unw13-vendor-agent-defs`; merged back into that branch only; NOT pushed. |

### Dependency sketch (blocked-by edges as wired in beads)

```
Group A:  unw2.1 (N1, opus)        unw2.2 (N13 tripwire, opus)     [both start-ready; merge .1 first]
             |
Group B:  unw2.3 (N3) -> unw2.4 (N4)                unw2.5 (N2, independent)
             (runner chain continues)
Group C:  unw2.4 -> unw2.6 (N8) -> unw2.7 (N9) -> unw2.8 (N10) -> unw2.9 (N11) -> unw2.10 (N12; also <- unw2.2)
          WF chain: unw2.12 (N7) -> unw2.13 (N5) -> unw2.14 (N6) -> unw2.15 (N17)
Group D:  unw2.10 -> unw2.11 (N15) -> unw2.18 (N18 runner minors)
          unw2.4 -> unw2.16 (N14 CLI)      unw2.10 -> unw2.17 (N16 golden)
          unw2.19 (N18 viewer, independent)
Vendor:   unw2.20 (independent track)
```

`bd ready` at epic start therefore surfaces: `unw2.1` + `unw2.2` (the P1 critical pair --
the correct next units), plus the legitimately parallel independent tracks `unw2.5` (P2,
contracts.mjs -- no file overlap with the runner chain), `unw2.12` (P2, head of the WF
chain), and the P3 independents `unw2.19`/`unw2.20`. Severity order is carried by priority;
parallel starts are safe because every listed parallel pair is file-disjoint and each doer
works in its own worktree.

---

## 4. Why the chains are shaped this way

- **All runner.js issues are one serial chain** (`unw2.1 -> .3 -> .4 -> .6 -> .7 -> .8 ->
  .9 -> .10 -> .11 -> .18`), severity-ordered within: round 1 learned that parallel edits
  to one 1300-line file guarantee merge conflicts even with worktree isolation -- the
  orchestrator pays for them at merge time. Same rule for the WF replay chain
  (`index.mjs`/`journal.mjs`).
- **`unw2.2` (tripwire) is deliberately NOT blocked by `unw2.1`**: it is written against the
  read-only vendored input schemas and the runner's CURRENT prompt builders; its initial
  red state on the three N1 divergences is its own validation. The orchestrator merges
  `unw2.1` first, then requires `unw2.2` green before closing either.
- **`unw2.8` (N10) sits after `unw2.1` in the chain** because the model-metadata read-back
  it needs only exists once the planner prompt writes `--metadata '{"model": ...}'`.
- **`unw2.17` (golden variant) waits for the end of the prompt-changing chain** (`unw2.10`)
  so its snapshots are written once, against final prompt text.

---

## 5. Deferred this round (explicitly, with reasons)

| Item | Why deferred |
|---|---|
| **N4's full multi-member state model** (cross-member bd/git sync, per-member beads reconciliation) | Cannot be validated without a real multi-member fleet; any sync layer built against the mock would be speculative. This round ships ensure-branch-everywhere + a topology precondition check + an honest "single-member/shared-workspace is the only supported real-fleet mode" statement (`unw2.4`). Revisit when a real 2-member fleet is available to test against. |
| **N10's root fix** (price from the model the fleet actually resolved) | Server-side: requires `apra-fleet.exe` to echo the resolved model alongside usage. Stays on the round-1 descoped-server-side list; `unw2.8` ships the client-side estimate path and documents the gap. |
| **N18: per-error-type doer retry policy** (skip blind re-dispatch after `AgentOutputError`) | A cost optimization that only matters once budgets bite on real runs; sequenced behind `unw2.8` landing and real-fleet usage data. File under a future epic if cost amplification is observed. |
| **F1 residue: `import()` module caching** (same-path scripts share module state) | Harmless for current stateless scripts; a doc note, not a defect. Fold into any future engine doc pass rather than spending a review cycle now. |
| **F9/N-residue: viewer single-run group/phase tracking** despite the engine supporting concurrent runs | Accepted single-tenant usage; making the viewer multi-run is a feature, not a fix. Documenting the limitation rides along with `unw2.19`'s viewer touch. |
| **Vendor push / upstream PR / submodule bump** | Unchanged hard gate: requires the user's explicit sign-off. Nothing in this round pushes vendor/apra-pm or moves the outer repo's submodule pointer. When sign-off comes, the vendor checklist MUST include re-running `unw2.2`'s contract test against the candidate submodule commit (N1 fix direction (e)) -- see the mandatory step below. |

### Vendor sign-off checklist -- mandatory contract re-run (N1 fix direction (e))

Before ANY candidate `vendor/apra-pm` submodule commit is pushed / the outer-repo
submodule pointer is bumped, the sign-off MUST re-run the role-input contract tripwire
against that candidate's real `agents/schemas/*-input.json` (not the pinned fixture
snapshot) and confirm it is green:

- Test: `packages/apra-fleet-se/test/runner-role-input-contract.test.mjs` (`unw2.2`, the
  N13 tripwire). It reconstructs, for every role runner.js dispatches, the exact context
  the runner's prompt builder consumes, and asserts `validateRoleInput(role, ctx).valid`
  against the vendored `<role>-input.json`.
- Point it at the candidate vendored schemas via
  `APRA_FLEET_SE_VENDOR_SCHEMAS_DIR_TEST_OVERRIDE=<candidate>/agents/schemas` and run
  `node --test packages/apra-fleet-se/test/runner-role-input-contract.test.mjs`.
- A red run means the candidate vendored contract has re-diverged from the runner's
  prompt builders (the exact N1 failure class). Do NOT push / bump until it is green
  (either the runner or the vendored contract is corrected first). Also regenerate the
  fixture snapshot (`unw2.5`'s regenerate script) from the candidate so the pinned net
  tracks the pushed truth.
- Reminder: the harvester subtest is `test.skip` until `unw2.10` wires real harvester
  inputs -- do not count that skip as a pass, and un-skip it once `unw2.10` lands.

---

## 6. Definition of done (whole epic)

1. All 20 child issues closed via the ritual's adversarial APPROVED (no self-approved
   closes, orchestrator-only merges, serial).
2. `unw2.2`'s contract tripwire is green against the merged runner AND is documented as a
   mandatory step in the vendor sign-off checklist -- the N1 failure class cannot silently
   recur.
3. A hand-constructed injection payload through reviewer `newTasks` cannot reach a member
   shell (`unw2.3`'s adversarial review reproduces the attack).
4. A 2-member mock sprint passes with per-member git/beads state, or the runner refuses to
   start on an unsupported topology with a clear message (`unw2.4`).
5. Both suites green and deterministic on Windows; the 3-bead order-sensitive golden
   variant fails on revert of the unw.19 sort fixes.
6. A mock sprint accrues real (estimate-labeled) spend and can trip `BudgetExceededError`.
7. vendor/apra-pm remains unpushed on `tmp/unw13-vendor-agent-defs`; the only vendor delta
   this round is the `bd remember` correction, merged back into that local branch.
