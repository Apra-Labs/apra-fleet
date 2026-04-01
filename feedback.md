# Plan Review Findings — Issue #40: provision_auth env var visibility

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-01 (re-review)
**Plan:** PLAN.md
**Requirements:** requirements.md

---

## Re-review: Prior Findings Resolution

### Finding 1: Task 8 ambiguity ("verify and maybe add" language)
**RESOLVED** — Former Task 8 is now Task 9. It states a clear decision: "registry deletion is sufficient" with three concrete reasons (encrypted at rest, atomic file overwrite, JS strings are immutable/GC'd). No ambiguity remains.

### Finding 2: Risk register missing
**RESOLVED** — Dedicated "Risk Register" section added with 5 risks (shell escaping, concurrent provision_auth, encrypted value size, long-running tasks, OOB terminal failure). Each has impact and mitigation columns. Covers all risks identified in the prior review.

### Finding 3: Requirements discrepancies undocumented
**RESOLVED** — "Requirements Deviation Notes" table added with 6 entries covering every deviation (Windows setEnv, CLAUDE_PATH targets, revoke_vcs_auth, integration tests, Windows escaping, long-running tasks). Each has rationale. Plan is now self-documenting.

### New requirement: OOB API key entry
**ADDRESSED** — Task 6 added, covering CLI changes (`--api-key` flag), socket service (`collectOobApiKey()`), and provision-auth integration. Matches requirements.md security consideration ("use the same out-of-band terminal prompt mechanism used for SSH passwords"). Headless fallback documented. VERIFY 2 includes OOB-specific checkpoints.

---

## Full Checklist

### 1. Does every task have clear "done" criteria?
**PASS** — All 11 tasks have "Done:" sections with specific, testable outcomes.

### 2. High cohesion within each task, low coupling between tasks?
**PASS** — Each task has a single concern. Task 6 (OOB key entry) touches 3 files but they form one cohesive feature (CLI + socket + tool integration).

### 3. Are key abstractions and shared interfaces in the earliest tasks?
**PASS** — Task 1 introduces `encryptedEnvVars` type field and `buildAuthEnvPrefix()` helper, used by Tasks 4, 5, and 10.

### 4. Is the riskiest assumption validated in Task 1?
**PASS** — Inline env var injection is built and unit-tested in isolation before integration.

### 5. Later tasks reuse early abstractions (DRY)?
**PASS** — Tasks 4, 5 reuse `buildAuthEnvPrefix()`. Task 6 reuses existing `collectOobPassword()` mechanics and socket infrastructure.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?
**PASS** — Phase 1: 3+V, Phase 2: 3+V, Phase 3: 3+V, Phase 4: 2+V.

### 7. Each task completable in one session?
**PASS** — All tasks are focused (1-3 files). Task 6 is the largest but has clear subtask breakdown.

### 8. Dependencies satisfied in order?
**PASS** — Type+helper (T1) -> storage (T2) -> injection (T4/T5) -> OOB entry (T6) -> rename/fix (T7/T8) -> verify cleanup (T9) -> tests (T10/T11).

### 9. Any vague tasks that two developers would interpret differently?
**PASS** — Previously failed on Task 8 ambiguity. Now resolved — Task 9 states the decision clearly.

### 10. Any hidden dependencies between tasks?
**PASS** — Task 6 depends on Task 2 (needs `provisionApiKey()` to already accept keys), which is satisfied by phase ordering.

### 11. Does the plan include a risk register?
**PASS** — Five risks with impact and mitigation. Includes all risks from prior review plus OOB terminal failure.

### 12. Does the plan align with requirements.md intent?
**PASS** — All requirements addressed. Deviations documented with rationale. OOB key entry added per security considerations. Out-of-scope items match requirements.

---

## Verdict

**APPROVED**

All three items from the prior review are resolved. The new OOB key entry requirement is fully addressed in Task 6. The plan is ready for implementation.
