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

## Phase 1 Code Review (Tasks 1-3)

**Commits reviewed:** d47403c → 8f35f1a (5 commits)
**Test results:** 35/35 test files pass, 549 tests passed, 4 skipped

### Task 1: Add `encryptedEnvVars` to Agent type + `buildAuthEnvPrefix()` helper

**Files:** `src/types.ts`, `src/utils/auth-env.ts` (new)

**Findings:**
- `encryptedEnvVars?: Record<string, string>` added to `Agent` interface at `src/types.ts:28` — correct type, optional field, backwards compatible
- `buildAuthEnvPrefix()` in `src/utils/auth-env.ts`:
  - Correctly handles undefined/empty `encryptedEnvVars` (returns empty string)
  - Linux/macOS path uses `escapeDoubleQuoted()` from `shell-escape.ts` — reuses existing battle-tested escaping
  - Windows path uses PowerShell single-quote escaping (`value.replace(/'/g, "''")`) — matches `windows.ts:envPrefix()` pattern as specified in plan
  - Correct join separators: `' && '` for Linux/macOS, `'; '` for Windows
  - Trailing separator included so prefix can be prepended directly to commands

**Verdict:** Matches plan specification exactly. No issues.

### Task 2: Update `provisionApiKey()` to store encrypted API key in registry

**File:** `src/tools/provision-auth.ts`

**Findings:**
- `encryptPassword` and `updateAgent` imports added correctly
- Storage call at line 140: `updateAgent(agent.id, { encryptedEnvVars: { ...agent.encryptedEnvVars, [envVarName]: encryptPassword(apiKey) } })`
  - Correctly merges with existing env vars via spread operator (won't clobber other keys)
  - Uses `encryptPassword()` for at-rest encryption — consistent with `encryptedPassword` field pattern
- Placement is correct: after the `setEnv` loop (shell profile writes), before verification
- Success message updated to mention "stored in member config"

**Verdict:** Matches plan specification exactly. No issues.

### Task 3: Fix macOS `setEnv()`/`unsetEnv()` for `.zshenv`

**File:** `src/os/macos.ts`

**Findings:**
- `setEnv()`: `.zshenv` write added between `.zshrc` and `.profile` — now returns 5 commands (was 4)
- `unsetEnv()`: `.zshenv` cleanup added between `.zshrc` and `.profile` — now returns 5 commands (was 4)
- Correct format: uses same `escapeDoubleQuoted()` escaping as other profiles
- `.zshenv` is the correct file — it's the only file sourced in non-interactive zsh sessions on macOS
- Tests updated in `tests/platform.test.ts`: command count assertions updated from 4→5, `.zshenv` presence asserted

**Verdict:** Matches plan specification exactly. No issues.

### VERIFY 1 Checklist

- [x] `Agent` type has `encryptedEnvVars` field — `src/types.ts:28`
- [x] `buildAuthEnvPrefix()` returns correct strings for linux, macos, windows — `src/utils/auth-env.ts`
- [x] `provisionApiKey()` stores encrypted key via `updateAgent()` — `src/tools/provision-auth.ts:140-142`
- [x] macOS `setEnv()`/`unsetEnv()` include `.zshenv` — `src/os/macos.ts:26,37`
- [x] All existing tests pass — 35/35 files, 549/549 tests

### Regression Check
No regressions. All changes are additive:
- New optional field on `Agent` type (backwards compatible)
- New utility file `auth-env.ts` (not yet consumed — that's Phase 2)
- `.zshenv` added to macOS commands (additive profile write)
- `provisionApiKey()` adds registry storage after existing shell profile writes

### Security Review
- API keys encrypted before storage using existing `encryptPassword()` — no plaintext at rest
- Shell escaping uses `escapeDoubleQuoted()` for Linux/macOS and PowerShell single-quote escape for Windows — correct for each platform
- No secrets in logs or command output

---

## Verdict

**APPROVED**

Phase 1 (Tasks 1-3) is complete and correct. All code matches PLAN.md specifications. All 549 tests pass. No regressions, no security issues. Ready for Phase 2.
