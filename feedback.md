# Plan Re-Review — issue #215 (provision_llm_auth cross-provider)

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Branch:** plan/issue-215
**Verdict:** APPROVED with minor nits

---

## Prior Findings Status

The original review (commit 64c0291) raised 6 findings. Checking each against the revised PLAN.md (commit dd27118):

| # | Finding | Resolved? | Notes |
|---|---------|-----------|----------|
| 1 | 4-phase structure restored with VERIFY sections | YES | Phases 1-4 have proper `###` headers and VERIFY blocks |
| 2 | Tasks 5-6 declare blockers on Tasks 2-4 | YES | Both say "Blockers: Tasks 2, 3, 4 must be complete" |
| 3 | Gemini probe uses actual auth call (not --version) | YES | Now specifies `gemini -p "hello" --output-format json --max-turns 1` |
| 4 | Task 3 describes orchestrator provider detection mechanism | YES | Specifies `%%FLEET_PROVIDER%%` env var with fallback to local agent config |
| 5 | Two new risks added (false-positive probe + token-refresh race) | YES | Both present in risk register with mitigations |
| 6 | All 6 provider combinations explicitly called out in Tasks 2-4 | YES | Task 2 lists all 6 with probe strategy; Tasks 3-4 reference per-combination approach (codex/copilot deferred to Task 1 audit, which is correct) |

**6 of 6 findings resolved.**

---

## Full 13-Point Checklist

| # | Criterion | Pass | Notes |
|---|-----------|------|-------|
| 1 | Clear "done" criteria on every task | YES | Each task has concrete "Done when" |
| 2 | High cohesion within tasks, low coupling between | YES | |
| 3 | Key abstractions in earliest tasks | YES | `probeExistingAuth()` in Task 2; orchestrator detection in Task 3 |
| 4 | Riskiest assumption validated early | YES | Audit Task 1; probe (riskiest change) Task 2 |
| 5 | Later tasks reuse early abstractions (DRY) | YES | Tasks 5-6 test against probe/flow abstractions |
| 6 | Phase boundaries at cohesion boundaries | YES | 4 clean phases: audit, probe, flows, tests |
| 7 | Tiers monotonically non-decreasing within phases | YES | cheap → cheap → standard → standard |
| 8 | Each task completable in one session | YES | |
| 9 | Dependencies satisfied in order | YES | Tasks 5-6 block on 2-4 |
| 10 | Any vague tasks two developers would interpret differently | NO | Probe commands now explicit per provider |
| 11 | Any hidden dependencies | NO | Orchestrator detection mechanism specified |
| 12 | Risk register present and complete | YES | 6 risks, all with mitigations |
| 13 | Plan aligns with requirements intent | YES | 6 combinations covered; codex/copilot appropriately deferred to audit |

---

## Minor Nits (non-blocking)

1. **Markdown escaping issue:** Several strings in Tasks 2-4 have garbled quoting (e.g., `\hello\`, `\already" authenticated "skipping\`, `\cross-provider:" no local...`). These appear to be escaped quotes that weren't properly rendered. Cosmetic only — intent is clear.

2. **Trailing whitespace:** Lines end with double-space (markdown line break). Not harmful but unusual for a plan document.

3. **Task 5 blockers are broader than needed:** Task 5 tests only the pre-auth probe (Task 2), but declares blockers on Tasks 2, 3, AND 4. Strictly, Task 5 only needs Task 2 complete. This is conservative (not wrong), but could delay test writing unnecessarily.

---

## Summary

Plan is **approved**. All 6 original findings have been addressed. The 4-phase structure is clean, dependencies are declared, probe commands are explicit per provider, orchestrator detection is specified, and the risk register is comprehensive. The plan is ready for implementation.
