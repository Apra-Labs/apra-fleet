# Code Review — Issues #44, #45, #46, #47 (commits bf4f9c4, da9476d)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-02
**Branch:** feature/multi-provider (after previously-approved 139839f)
**Test results:** 37/37 files, 586 passed, 4 skipped. TypeScript: clean (`tsc --noEmit` exit 0).

---

## Issue #44: Fresh session per phase rule

**Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`

**Findings:**
- SKILL.md execution loop (line 63): updated to show `resume=false` at phase start, `resume=true` within phase. Standalone "Doer session rules" paragraph at line 72 elaborates clearly.
- doer-reviewer.md (lines 35-37): "Doer session rules" section added with identical semantics — `resume=false` at new phase, resume allowed within a phase.
- Both files are consistent and the rule is unambiguous.

**Verdict:** PASS — no issues.

---

## Issue #45: Provider Recommendations in user-guide.md

**File:** `docs/user-guide.md`

**Findings:**
- Lines 150-158: Provider Recommendations table added.
- Opens with "These are recommendations, not restrictions — your choice is final." — appropriately non-prescriptive.
- Orchestrator recommendation for Claude is justified with a concrete technical reason (Gemini lacks background agents, serializes fleet operations).
- Doer row says "Any provider" — fully neutral.
- Reviewer row: see #47 finding below.

**Verdict:** PASS on #45's own requirement (no hard-sell). The Reviewer cell wording is a #47 concern addressed below.

---

## Issue #46 Part A: Non-blocking Gemini + --skill warning

**File:** `src/cli/install.ts`

**Findings:**
- Lines 303-305: `console.warn()` fires when `llm === 'gemini' && installSkill`. Non-blocking — does not exit or throw.
- Message content: states the limitation (no background agents, sequential operations), suggests Claude as alternative, references docs.
- Test output confirms the warning appears on `--skill --llm gemini` runs and does not appear on non-Gemini installs.

**Verdict:** PASS — no issues.

## Issue #46 Part B: Timeout guidance for Gemini

**File:** `skills/pm/SKILL.md`

**Findings:**
- Line 127: New row in Provider Awareness table — "Gemini members are slower — use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members."
- Clear, actionable, placed in the correct reference table.

**Verdict:** PASS — no issues.

---

## Issue #47: Provider-agnostic reviewer tier

**Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`, `docs/user-guide.md`

**Findings:**

**SKILL.md (line 74) — PASS:** Reviewer assignment uses conditional logic: "If any Claude member exists, dispatch reviews with `model: "opus"` (Claude members can run any tier). For non-Claude providers, use the highest tier via `modelTiers()`. If no premium option exists, use what is available. User's choice is final." This is provider-agnostic strategy with a Claude-specific optimization — correct.

**doer-reviewer.md (line 15) — PASS:** Same conditional logic, consistent with SKILL.md. Adds "no warning needed" for non-premium fallback — good UX.

**user-guide.md (line 158) — RESOLVED (13af9d1):** Previously used "Opus-tier models" as a generic tier name. Now reads:

> | **Reviewer** | Highest-tier models (use premium tier) | Highest review quality; catches subtle issues that smaller models miss. |

Provider-neutral. Remaining "Opus" mentions (lines 156, 167) are in explicitly Claude-specific contexts (Orchestrator recommendation and mix-and-match example) — acceptable.

---

## Regression Check (Previously Approved Phases)

Spot-checked all previously approved code (Phases 1-4 of #40, Phases 1-4 of #43, Phase 5A-5E):
- No regressions detected. All prior code paths intact.
- Changes in this review are additive (doc updates + one `console.warn` guard).

---

## Summary

| Issue | Status | Notes |
|-------|--------|-------|
| #44 | PASS | Fresh session rule in SKILL.md + doer-reviewer.md |
| #45 | PASS | Recommendations table is non-prescriptive |
| #46A | PASS | Non-blocking Gemini warning in install.ts |
| #46B | PASS | Timeout multiplier in SKILL.md |
| #47 | PASS | Fixed in 13af9d1 — now reads "Highest-tier models (use premium tier)" |

---

**APPROVED**
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

## Phase 2 Code Review (Tasks 4-6)

**Commits reviewed:** 2430a9c → 958de8c (5 commits)
**Test results:** 35/35 test files pass, 549 tests passed, 4 skipped

### Phase 1 Regression Check

No regressions in Phase 1 code:
- `src/types.ts:28` — `encryptedEnvVars` field intact
- `src/utils/auth-env.ts` — `buildAuthEnvPrefix()` unchanged, now consumed by Tasks 4 and 5
- `src/os/macos.ts` — `.zshenv` in `setEnv()`/`unsetEnv()` intact
- `src/tools/provision-auth.ts` — `provisionApiKey()` still stores encrypted key via `updateAgent()`

### Task 4: Inject auth env vars in `execute_prompt`

**File:** `src/tools/execute-prompt.ts`

**Findings:**
- `buildAuthEnvPrefix` imported at line 7, computed once at line 52 — correct (avoids redundant decryption)
- Prefix prepended to all 3 command builds:
  - Initial command: line 54 (`authPrefix + cmds.buildAgentPromptCommand(...)`)
  - Stale session retry: line 74 (`authPrefix + cmds.buildAgentPromptCommand(...)`)
  - Server error retry: line 82 (`authPrefix + cmds.buildAgentPromptCommand(...)`)
- `getAgentOS(agent)` called once for authPrefix — matches existing usage pattern in the file
- Prefix is empty string when no env vars stored, so no-op for agents without provisioned keys

**Verdict:** Matches plan. All retry paths covered. No issues.

### Task 5: Inject auth env vars in `execute_command`

**File:** `src/tools/execute-command.ts`

**Findings:**
- `buildAuthEnvPrefix` imported at line 5, computed at line 77
- Prefix prepended to regular (synchronous) path only: line 78 (`authPrefix + cmds.wrapInWorkFolder(...)`)
- Long-running nohup path (lines 39-73) correctly excluded — per risk register, injecting secrets into a wrapper script written to disk is a different security model (out of scope for #40)
- Placement is correct: prefix goes before `wrapInWorkFolder`, which handles `cd` into work folder

**Verdict:** Matches plan. Long-running exclusion is intentional and documented. No issues.

### Task 6: Add OOB API key entry to `provision_auth`

**Files:** `src/cli/auth.ts`, `src/services/auth-socket.ts`, `src/tools/provision-auth.ts`

**Findings:**

**CLI (`src/cli/auth.ts`):**
- `--api-key` flag detection at line 68: `args.includes('--api-key')` — simple and correct
- `memberName` parsing at line 69: `args.find(a => !a.startsWith('--'))` — skips flags correctly
- Conditional prompt text (lines 77-83), input label (line 87), empty check (line 95), success message (line 120) — all switch correctly based on `isApiKey`
- Socket message still uses `password` field name (line 104) — correct, it's an opaque secret on the wire, no protocol change needed
- Usage string updated to show `[--api-key]` optional flag

**Socket service (`src/services/auth-socket.ts`):**
- `collectOobApiKey()` at lines 243-275 — mirrors `collectOobPassword()` structure exactly
- Passes `['--api-key']` to `launchAuthTerminal()` at line 263
- Same pending auth, timeout, and fallback handling as password flow
- `getAuthCommand()` extended with optional `extraArgs` parameter (line 281) — forwards to spawn args
- `launchAuthTerminal()` extended with optional `extraArgs` parameter (line 313) — passes to `getAuthCommand()`
- Fallback message uses "API key" phrasing and instructs user to retry without `api_key` param

**Provision-auth (`src/tools/provision-auth.ts`):**
- `decryptPassword` import added (line 11) — needed to decrypt OOB-collected key
- `collectOobApiKey` imported from auth-socket (line 13)
- Lines 205-208: Non-Claude providers without `api_key` now call `collectOobApiKey()` instead of returning an error
- `decryptPassword(oob.password)` at line 208 — correct: OOB socket handler encrypts the key, `provisionApiKey()` needs plaintext to call `setEnv()` and `encryptPassword()`
- `provisionApiKey()` call with explicit `api_key` param (line 200-201) still takes priority — automation path preserved

**Test (`tests/tool-provider.test.ts`):**
- `collectOobApiKey` properly mocked (lines 34-37)
- Test at line 182 verifies: OOB function called with correct args, fallback message returned
- Replaced the old "rejects OAuth flow" test — the behavior changed from error to OOB prompt

**Verdict:** Matches plan. Clean separation of concerns (CLI/socket/tool). No issues.

### VERIFY 2 Checklist

- [x] `execute_prompt` command string includes auth env export prefix — line 54
- [x] `execute_command` command string includes auth env export prefix — line 78
- [x] All retry paths in `execute_prompt` include the prefix — lines 54, 74, 82
- [x] `provision_auth` without `api_key` for non-Claude providers calls OOB — lines 205-208
- [x] `provision_auth` with `api_key` still works (no OOB prompt) — lines 200-201
- [x] Headless fallback returns useful message — line 267
- [x] All existing tests pass — 35/35 files, 549/549 tests, 4 skipped

### Security Review

- Auth env prefix built from encrypted-at-rest values, decrypted only at command build time — no plaintext persisted
- `decryptPassword(oob.password)` in provision-auth: decrypted key is passed to `provisionApiKey()` which encrypts it again for storage — plaintext only lives in function scope
- OOB terminal prompt prevents API keys from appearing in conversation context, MCP logs, or tool call history
- No new secrets in logs or command output

---

## Cumulative Verdict (Phases 1+2)

**APPROVED**

Phases 1 and 2 (Tasks 1-6) are complete and correct. All code matches PLAN.md specifications. All 549 tests pass across 35 test files. No regressions in Phase 1. No security issues. Ready for Phase 3.

---

## Phase 3 Code Review (Tasks 7-9)

**Commits reviewed:** 1abccb1 → 862d2b3 (5 commits)
**Test results:** 35/35 test files pass, 549 tests passed, 4 skipped

### Phase 1+2 Regression Check

No regressions in previously approved phases:
- `src/types.ts:28` — `encryptedEnvVars` field intact
- `src/utils/auth-env.ts` — `buildAuthEnvPrefix()` unchanged, still consumed by execute-prompt/execute-command
- `src/os/macos.ts` — `.zshenv` in `setEnv()`/`unsetEnv()` intact
- `src/tools/provision-auth.ts` — `provisionApiKey()` still stores encrypted key; OOB flow intact
- `src/tools/execute-prompt.ts` — `authPrefix` applied to all 3 command builds (lines 54, 74, 82)
- `src/tools/execute-command.ts` — `authPrefix` applied to regular path (line 78), long-running excluded per design

### Task 7: Rename `CLAUDE_PATH` to `CLI_PATH`

**Files:** `src/os/linux.ts`, `src/os/windows.ts`

**Findings:**
- `linux.ts`: `CLAUDE_PATH` renamed to `CLI_PATH` at line 6. All 6 references updated (lines 69, 72, 81, 92, 94). Clean find-replace, no functional change.
- `windows.ts`: `CLAUDE_PATH` renamed to `CLI_PATH` at line 6. All 5 references updated (lines 78, 81, 90, 97). Clean find-replace, no functional change.
- Grep confirms zero remaining `CLAUDE_PATH` references in `src/` — rename is complete.
- Existing tests pass — they test command output (which is unchanged), not constant names.

**Verdict:** Matches plan specification exactly. No issues.

### Task 8: Fix Gemini session resume

**File:** `src/providers/gemini.ts`

**Findings:**
- `buildPromptCommand()` (line 34): Changed from `cmd += ' --resume'` to `cmd += ' --resume latest'` — correct, Gemini CLI requires `--resume latest` to resume the most recent session
- `parseResponse()` (lines 55, 62): Both JSON-parse success and catch branches now return `sessionId: result.code === 0 ? 'gemini-latest' : undefined` — correct sentinel behavior:
  - On success (code 0): returns `'gemini-latest'` so `execute_prompt` stores it as `agent.sessionId`
  - On failure (code != 0): returns `undefined` so no stale session is persisted
- `resumeFlag()` (line 78): Returns `'--resume latest'` regardless of `_sessionId` arg — correct, Gemini doesn't use session IDs
- Test coverage updated in `tests/providers.test.ts`:
  - `buildPromptCommand` with session resume asserts `--resume latest` (line 186)
  - `parseResponse` successful response asserts `sessionId: 'gemini-latest'` (line 202)
  - `resumeFlag` asserts `'--resume latest'` with and without args (lines 211-213)
  - Default command (no sessionId) asserts `--resume` is NOT present (line 180) — correct, no resume without session

**Non-blocking note:** No explicit test for `parseResponse` returning `sessionId: undefined` on non-zero exit code for Gemini. The logic is trivially correct (`result.code === 0 ? 'gemini-latest' : undefined`), and the Claude provider tests cover the error-case pattern. Phase 4 tests could add this for completeness.

**Verdict:** Matches plan specification exactly. Correct Gemini CLI behavior.

### Task 9: Verify `remove_member` cleanup of stored env vars

**Files:** `src/tools/remove-member.ts` (verification only, no code changes)

**Findings:**
- Confirmed per PLAN.md: `remove_member` calls `unsetEnv(provider.authEnvVar)` for shell profile cleanup and `removeAgent()` for full registry deletion including `encryptedEnvVars`
- No code changes needed — this is a verification-only task
- Plan rationale for no explicit zeroing is sound: values are encrypted at rest, file is overwritten atomically, and JS strings are immutable/GC'd

**Verdict:** Verification complete. No issues.

### VERIFY 3 Checklist

- [x] `CLAUDE_PATH` renamed to `CLI_PATH` in linux.ts and windows.ts — no functional change
- [x] No remaining `CLAUDE_PATH` references in `src/` (grep verified)
- [x] Gemini `parseResponse()` returns `sessionId: 'gemini-latest'` for successful responses
- [x] Gemini `parseResponse()` returns `sessionId: undefined` for failed responses
- [x] Gemini `resumeFlag()` returns `'--resume latest'`
- [x] Gemini `buildPromptCommand()` uses `--resume latest` when sessionId is present
- [x] `remove_member` deletes stored env vars via registry deletion (verified, no code change)
- [x] All existing tests pass — 35/35 files, 549/549 tests, 4 skipped

### Security Review

- No new secrets handling in Phase 3
- `CLI_PATH` rename is cosmetic only — no change to command execution security model
- Gemini session resume uses sentinel string `'gemini-latest'`, not a user-controlled value — no injection risk

---

## Cumulative Verdict (Phases 1+2+3)

**APPROVED**

Phases 1-3 (Tasks 1-9) are complete and correct. All code matches PLAN.md specifications. All 549 tests pass across 35 test files. No regressions in Phases 1 or 2. No security issues. One non-blocking note: Phase 4 tests should add a Gemini `parseResponse` error-case test asserting `sessionId: undefined` on non-zero exit code. Ready for Phase 4.

---

## Phase 4 Code Review (Tasks 10-11) — Final Cumulative

**Commits reviewed:** d2be2e6 → 4139623 (4 commits)
**Test results:** 36/36 test files pass, 565 tests passed, 4 skipped
**TypeScript:** No errors (`npx tsc --noEmit` clean)

### Phase 1+2+3 Regression Check

No regressions in any previously approved phase:
- `src/types.ts:28` — `encryptedEnvVars` field intact
- `src/utils/auth-env.ts` — `buildAuthEnvPrefix()` unchanged
- `src/os/macos.ts:26,37` — `.zshenv` in `setEnv()`/`unsetEnv()` intact
- `src/tools/provision-auth.ts` — `provisionApiKey()` stores encrypted key; OOB flow intact; `decryptPassword(oob.password)` still correct
- `src/tools/execute-prompt.ts:54,74,82` — `authPrefix` applied to all 3 command builds
- `src/tools/execute-command.ts:77-78` — `authPrefix` applied to regular path, long-running excluded
- `src/os/linux.ts:6`, `src/os/windows.ts:6` — `CLI_PATH` rename complete, zero `CLAUDE_PATH` references remain
- `src/providers/gemini.ts:34,55,62,78` — `gemini-latest` sentinel and `--resume latest` intact
- `src/cli/auth.ts` — `--api-key` flag handling intact
- `src/services/auth-socket.ts` — `collectOobApiKey()` intact

### Task 10: Tests for platform fixes + auth env prefix helper

**File:** `tests/auth-env.test.ts` (new, 93 lines)

**Findings:**
- 9 test cases covering all `buildAuthEnvPrefix()` paths:
  - Undefined `encryptedEnvVars` → empty string (linux, macos, windows)
  - Empty `encryptedEnvVars` → empty string (linux, windows)
  - Linux export format with double-quoted value
  - macOS export format matches linux (same code path)
  - Windows PowerShell `$env:` format with single-quoted value
  - Multiple env vars with correct join separators (`&&` / `;`)
  - Special character escaping: double-quote, dollar sign, backslash (linux)
  - PowerShell single-quote escaping (windows)
- Uses `encryptPassword()` in the helper to create realistic encrypted test data — tests the full decrypt→escape→format pipeline
- Test structure is clean: helper function `makeAgent()` for minimal agent construction

**Verdict:** Comprehensive coverage. All plan-specified test cases present. Adversarial key values tested as specified in risk register.

### Task 11: Tests for OOB API key + Gemini fixes

**File:** `tests/auth-socket.test.ts` (4 new tests added to existing file)

**Findings — collectOobApiKey tests:**
- "launches terminal with --api-key flag" — verifies `launchFn` called with `['--api-key']`, result contains encrypted password
- "returns encrypted key when pending auth already has password" — tests pre-entered key path, verifies `launchFn` not called
- "returns fallback on timeout" — tests with 100ms timeout, verifies fallback message contains 'timed out' and tool name
- "returns fallback when terminal launch fails" — tests headless fallback, verifies error message propagation
- Proper cleanup with `afterEach(() => cleanupAuthSocket())`

**File:** `tests/providers.test.ts` (3 new Gemini parseResponse error-case tests)

**Findings — Phase 3 suggestion addressed:**
- "parses response with non-zero exit code — sessionId is undefined" — `makeResult(JSON.stringify({...}), 1)` → `isError: true`, `sessionId: undefined`
- "parses non-JSON response with zero exit code — sessionId is gemini-latest" — raw text + code 0 → `sessionId: 'gemini-latest'`
- "parses non-JSON response with non-zero exit code — sessionId is undefined" — raw text + code 1 → `sessionId: undefined`, `isError: true`
- These 3 tests directly address the Phase 3 non-blocking note about missing Gemini error-case coverage

**Verdict:** All Phase 3 suggestions implemented. Test quality is strong — covers success, error, and edge cases.

### VERIFY 4 Checklist (Final)

- [x] All new tests pass — 12 new tests (9 auth-env + 3 Gemini error-case)
- [x] `collectOobApiKey` tests pass — 4 tests covering launch, pre-entered, timeout, headless
- [x] All existing tests pass — 36/36 files, 565/565 tests, 4 skipped
- [x] No TypeScript errors — `npx tsc --noEmit` clean
- [x] No regressions in Phases 1, 2, or 3

### Test Quality Assessment

- **Coverage gaps:** None identified. All public APIs and error paths from Tasks 1-9 have corresponding tests.
- **Redundancy:** No overlapping/redundant tests. Each test case covers a distinct code path.
- **auth-env.test.ts** tests the full pipeline (encrypt → decrypt → escape → format), not just format strings — this is the right approach since it catches integration issues between crypto and shell escaping.
- **Gemini error-case tests** fill the gap identified in Phase 3 review — the ternary `result.code === 0 ? 'gemini-latest' : undefined` is now explicitly tested for both branches in both JSON and non-JSON paths.

### Security Review

- No new secrets handling in Phase 4 (test-only changes)
- Test API keys are plaintext literals in test files (`test-key-123`, etc.) — appropriate for unit tests, no real credentials
- `encryptPassword()` used in test helper to create realistic encrypted values — demonstrates the encrypt/decrypt cycle works

---

## Final Cumulative Verdict (Phases 1+2+3+4, Tasks 1-11)

**APPROVED**

All 11 tasks and 4 verify checkpoints are complete. 36/36 test files pass (565 tests, 4 skipped). No TypeScript errors. No regressions across any phase. All Phase 3 review suggestions addressed. Code matches PLAN.md specifications and satisfies requirements.md intent.

Summary of changes delivered:
1. **Env var persistence + injection** — API keys stored encrypted in registry, injected inline into every `execute_prompt` and `execute_command` call (Tasks 1-2, 4-5)
2. **macOS .zshenv fix** — non-interactive SSH sessions now source auth env vars (Task 3)
3. **OOB API key entry** — secure out-of-band terminal prompt for non-Claude providers (Task 6)
4. **Provider-neutral rename** — `CLAUDE_PATH` → `CLI_PATH` (Task 7)
5. **Gemini session resume** — `gemini-latest` sentinel + `--resume latest` (Task 8)
6. **Cleanup verification** — `remove_member` confirmed to delete stored env vars (Task 9)
7. **Test coverage** — 16 new tests covering all new code paths (Tasks 10-11)
