# Plan Review -- Code Intelligence Hardening (PLAN.md vs requirements.md)

Reviewer: pm-plan-reviewer
Date: 2026-07-06
Verdict: **CHANGES NEEDED**

## Summary

The plan is strong: full requirement coverage, F3.2 correctly front-loaded as
Task 1, exact models on every work task, VERIFY checkpoints closing every phase
with build + test + push (no PR, never main), and self-contained task
descriptions whose factual anchors I spot-checked against the source -- nearly
all verified accurate. One factual claim is wrong and biases a task toward
silently missing requirement F1.3; it needs a one-sentence correction before
execution.

## Findings

### 1. [MEDIUM] T3.3 asserts tpl-planner.md carries CI guidance -- it does not

PLAN.md (T3.3) states: "Planning-time grep found kb_session_prime + CI guidance
hits in all three (tpl-planner.md line 8, tpl-doer.md lines 47/57,
tpl-reviewer.md lines 76-79), so the expected outcome is confirmation with NO
edits."

Verified against the source: `skills/pm/tpl-planner.md` contains the
kb_session_prime instruction (line 8) but NO code intelligence tool guidance --
grep for `code_graph|code_impact|code_query|code_context|code intelligence|
gitnexus|Glob/Grep` (case-insensitive) returns zero hits in that file.
tpl-doer.md (lines 47, 57) and tpl-reviewer.md (lines 76, 78) do carry both
elements as claimed; tpl-planner.md carries only the KB element.

Why this matters: T3.3 is assigned claude-haiku-4-5 and primed with "expected
outcome is confirmation with NO edits". A doer anchored on that expectation may
record confirmation without a real per-file check, leaving F1.3 unmet (the
requirement explicitly says "fix only if a gap is found" -- and a gap exists).
The task's fallback instruction ("if a template lacks one of the two elements,
add it") is correct, but the false expectation works against it.

Fix: in T3.3, correct the planning-time claim to state that tpl-planner.md has
kb_session_prime only and LACKS code intelligence tool guidance, and change the
expected outcome to: tpl-doer.md and tpl-reviewer.md confirm with no edits;
tpl-planner.md needs a code intelligence paragraph added (same style as its
siblings, e.g. use code_query/code_context to locate implementations while
planning; prefer CI tools over Glob/Grep for structural questions), committed as
`docs(pm): fill code intelligence gaps in fleet-mode templates`.

## Verified-accurate claims (spot-checked, no action needed)

- `src/tools/code-intelligence-gitnexus.ts`: 53 lines; `sharedClient` /
  `connectionPromise` at lines 5-6; `getGitNexusClient()` lines 8-30; spawns
  `npx -y gitnexus mcp` with `stderr: 'pipe'`; methods map to
  call_graph/impact/query/context. A rejected connectionPromise is indeed
  cached forever and there are no transport close/error handlers -- the F3.2
  bugs are real as described.
- `src/tools/code-intelligence.ts`: all four zod schemas carry an OPTIONAL
  `repo` param; `getProvider()` reads
  `~/.apra-fleet/data/code-intelligence/config.json`, defaults to gitnexus;
  no tool-level description strings live here (T3.1's single-registration-point
  claim is correct).
- `src/index.ts`: code_* tool registrations at lines 310-325 with the
  description as the second argument; `fleet_status` registered at line 286.
- `src/tools/check-status.ts`: `fleetStatus()` at line 194; supports
  `format: 'compact' | 'json'`.
- `tests/code-intelligence.test.ts`: uses `vi.hoisted` + `vi.mock` of
  `@modelcontextprotocol/sdk/client/index.js` and `client/stdio.js`; 4
  GitNexusProvider tests + 3 getProvider tests as stated. The plan's warning
  that module-level singleton state requires `vi.resetModules()` + dynamic
  import for reset/reconnect tests is well taken.
- `package.json`: no lint script -- VERIFY tasks correctly run build + test
  only and note the skip.
- `skills/pm/doer-reviewer-loop.md`: doer template block at lines 161-180 with
  the VERIFY sentence ("run it -- build, linter, and full test suite") at line
  167 and the KB/CI paragraph at lines 174-179; reviewer template at lines
  184-194 carries NO KB/CI paragraph (F1.2 gap confirmed real).
- `skills/pm/index.md` has a "When to run" section (line 24) as T2.2 targets.

## Review checklist

- [OK] Coverage: F3.1->T1.2, F3.2->T1.1, F3.3->T1.3, F2.1->T2.2, F2.2->T2.1,
  F1.1->T3.1, F1.2->T3.2, F1.3->T3.3; done criteria precise and testable.
- [OK] Risk front-loading: F3.2 is Task 1 (T1.1, opus) as requirements mandate.
- [OK] Every work task has an exact model; T1.4/T2.3/T3.4 VERIFY tasks end each
  phase with build + test + push.
- [OK] Task descriptions self-contained: verbatim message strings, file paths,
  line anchors, edge cases, and test recipes included.
- [OK] Required tests planned: F3.1 missing-index (T1.2), F3.2
  connection-promise reset (T1.1), F2.2 freshness pure function (T2.1).
- [OK] Repo rules: ASCII only, never push to main, no PR this sprint --
  restated in the plan and in every VERIFY task.
- [X] Factual claims: one inaccuracy (Finding 1); all other spot-checked
  claims verified.

## Decision

CHANGES NEEDED -- fix Finding 1 (a one-sentence correction to T3.3 plus its
expected-outcome/done-criteria wording). Everything else is approved as-is; no
other task needs revision.
