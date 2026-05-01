# Plan Review — issue #215 (provision_llm_auth cross-provider)

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Branch:** plan/issue-215
**Verdict:** CHANGES NEEDED

---

## Checklist

| # | Criterion | Pass | Notes |
|---|-----------|------|-------|
| 1 | Clear "done" criteria on every task | YES | Each task has a concrete "Done when" clause |
| 2 | High cohesion within tasks, low coupling between | YES | Probe, Flow-A fix, OOB improvement are well-separated concerns |
| 3 | Key abstractions in earliest tasks | PARTIAL | `probeExistingAuth()` is introduced in Task 2 but no shared cross-provider helper is factored out for Tasks 3-4 to reuse |
| 4 | Riskiest assumption validated early | YES | Audit is Task 1; probe (the riskiest runtime change) is Task 2 |
| 5 | Later tasks reuse early abstractions (DRY) | PARTIAL | Tasks 5-6 test against Tasks 2-4 but no shared fixture or factory is mentioned |
| 6 | Phase boundaries at cohesion boundaries | NO | See STRUCTURAL below |
| 7 | Tiers monotonically non-decreasing within phases | YES | cheap -> cheap -> standard (once phase structure is fixed) |
| 8 | Each task completable in one session | YES | All are scoped tightly |
| 9 | Dependencies satisfied in order | NO | See BLOCKER below |
| 10 | Any vague tasks two developers would interpret differently | YES | See VAGUE below |
| 11 | Any hidden dependencies | YES | See HIDDEN DEPS below |
| 12 | Risk register present and complete | PARTIAL | See RISK below |
| 13 | Plan aligns with requirements intent | PARTIAL | See ALIGNMENT below |

---

## Issues

### STRUCTURAL — Phase headings are broken

All six tasks are nested under the single `### Phase 1: Audit and compatibility matrix` heading. Phases 2-4 exist only as `VERIFY` labels but have no corresponding section headers. This makes the plan hard to navigate and ambiguous about which tasks belong to which phase.

**Fix:** Add explicit phase headers:
- Phase 1: Audit (Task 1)
- Phase 2: Pre-auth probe (Task 2)
- Phase 3: Cross-provider flow fixes (Tasks 3-4)
- Phase 4: Tests (Tasks 5-6)

### BLOCKER — Missing dependency declarations

- **Task 5** ("Unit tests for pre-auth probe") depends on Task 2 which implements `probeExistingAuth()`. Currently says "Blockers: none".
- **Task 6** ("Unit tests for cross-provider flow selection") depends on Tasks 3-4. Currently says "Blockers: none".

**Fix:** Task 5 blockers: Task 2. Task 6 blockers: Tasks 3, 4.

### VAGUE — Gemini pre-auth probe doesn't validate auth

Task 2 specifies `gemini --version` as the probe for Gemini, with the note "version check is sufficient for Gemini." But `--version` only confirms the CLI is installed, not that the user is authenticated. The requirements say "detect if already authenticated." Two developers would interpret this differently — one might ship `--version`, another would use a real Gemini API call.

Checked the codebase: `verifyWithVersion` in provision-auth.ts is used for post-provisioning verification (confirming the CLI runs), not for auth validation. Using the same weak check as a pre-auth probe would create false positives — the probe would say "already authenticated" when only the CLI binary is present.

**Fix:** Specify the exact Gemini probe command that validates auth (e.g., `gemini -p "hello"` with a timeout), or document explicitly why `--version` is sufficient for Gemini's auth model (e.g., if Gemini CLI refuses to run `--version` without valid credentials, say so).

### HIDDEN DEPS — Task 3 done-when assumes orchestrator provider is known

Task 3's done-when says: "claude->gemini with no local Gemini OAuth -> logs 'cross-provider: no local Gemini credentials...'". This requires `provisionAuth` to know the orchestrator's own provider to detect the cross-provider case. Currently `provisionAuth` only calls `getProvider(agent.llmProvider)` for the *target* member's provider — there is no existing mechanism to resolve the orchestrator's own provider identity within that function.

**Fix:** Task 3 should specify how the orchestrator's provider is obtained (e.g., from server config, from a new parameter, or by reading the local machine's active provider). This is an implementation detail that affects the function signature.

### RISK — Two missing risks

The risk register is solid but omits two scenarios:

1. **False-positive probe:** Pre-auth probe returns exit 0 but the token is actually expired, scoped incorrectly, or (for Gemini with `--version`) the CLI is installed but unauthenticated. Provisioning is skipped, member fails later. Impact: high — this is exactly the silent failure the issue is trying to eliminate.
   - **Mitigation:** probe should use a real API call (not just version check) and treat non-zero exit OR error response as "not authenticated."

2. **Race with token refresh during cross-provider copy:** OAuth credential files are read and copied, but between read and write the local token auto-refreshes, leaving the member with a stale copy.
   - **Mitigation:** low probability, existing `validateCredentials` likely covers this, but should be noted.

### ALIGNMENT — Requirements ask for 6-combination coverage in implementation, not just audit

The requirements say "Implement the three-strategy flow for cross-provider cases" and list 6 specific provider combinations. The plan audits all 6 in Task 1 but the implementation tasks (2-4) are generic — they don't specify per-combination behavior. Notably, codex and copilot return `null` from `oauthCredentialFiles()` and have different CLI names, so their probe commands and flow paths differ from claude/gemini. Task 6 says "npm test covers all 6 cross-provider combinations" but no implementation task defines what the correct behavior is for each combination.

**Fix:** Either:
- (a) Add sub-bullets in Tasks 2-4 specifying the probe command, OAuth path, and OOB prompt for each of codex and copilot, OR
- (b) Explicitly state that codex/copilot are API-key-only (probe -> OOB, skip Flow A) and that this is a deliberate design decision derived from their `null` OAuth support.

---

## Summary

The plan has the right shape — audit first, then probe, then fix flows, then test. The individual tasks are well-scoped and the risk register covers real concerns. However: phase structure is broken (all tasks under Phase 1), two blocker declarations are missing, the Gemini probe doesn't actually validate auth, the orchestrator-provider detection mechanism is unspecified, and the implementation tasks need to be explicit about per-provider behavior. These are all fixable without restructuring the plan's task sequence.
