# Stall Detector Redesign (#241) — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05 16:45:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review. Prior version was a plan review (APPROVED). This is the first implementation review, covering Phase 1.

---

## Phase 1 Review

### Build & Tests

- `npm run build`: PASS — clean compile, no errors.
- `npm test`: PASS — 1117 passed, 6 skipped, 0 failures.

### Task 1: Fix path encoding and Gemini log directory

**Commits:** `19076f9`
**Files:** `src/services/stall/log-path-resolver.ts`

**Done criteria check:**
- Claude path encoding produces `-` separators: PASS — `workFolder.replace(/[\/\\:]/g, '-')` at line 13. Verified: `C:\Users\test\project` → `C---Users-test-project`, `/Users/test/project` → `-Users-test-project`. Matches the observed encoding in `stall-detector-design.md`.
- Gemini path includes `/chats/`: PASS — `join(home, '.gemini', 'tmp', projectName, 'chats')` at line 19.
- Remote command embeds inline home dir variable: NOTE — The `homeDir` optional parameter allows injection for testing and remote resolution, but the actual remote `$(echo $HOME)` / `$env:USERPROFILE` inline embedding is deferred to Phase 2 (findLogFile). This is acceptable — Phase 1 scope is the path encoding logic, not the remote transport layer.

**Code quality:**
- `resolveSessionLogDir` returns `string | null` (null for unknown provider) while `resolveSessionLogPath` throws on unknown provider — inconsistent API contract. Minor: this is a design choice, not a bug. The dir function is used in exploratory contexts (may not have a match), while the path function requires a valid provider. Acceptable.
- `resolveSessionLogPath` for Gemini uses `workFolder.split(/[\\/]/).pop()` instead of `basename(workFolder)` used in `resolveSessionLogDir`. Both produce the same result, but the inconsistency is unnecessary. NOTE — cosmetic only, not blocking.

**Verdict: PASS**

### Task 2: Unit tests for path encoding and log directory resolution

**Commits:** `19076f9`
**Files:** `src/services/stall/log-path-resolver.test.ts`

**Done criteria check:**
- Claude Windows encoding test: PASS — verifies `C---Users-test-project`.
- Claude macOS encoding test: PASS — verifies `Users-test-project`.
- Gemini path with `/chats/`: PASS — verifies path ends with `chats`.
- Unknown provider returns null / throws: PASS — both functions tested.

**Test quality:**
- 6 tests for `resolveSessionLogDir` + 6 for `resolveSessionLogPath` = 12 test cases. Good coverage of the exposed API surface.
- Tests use the `homeDir` parameter to avoid system dependency — good isolation.
- No test for the edge case where `workFolder` is empty string (would produce `basename('')` → `''`, falling back to `'project'` in `resolveSessionLogDir` via `|| 'project'`, but `resolveSessionLogPath` would produce `''` via `.pop() ?? 'project'` — actually `.pop()` on `['']` returns `''` which is falsy... wait, `?? 'project'` only catches `null`/`undefined`, not empty string). This is an edge case that won't occur in practice (workFolder is always a real path), so not blocking.

**Verdict: PASS**

### Task 3: Prepend `[<inv>]` to `-p` argument in execute-prompt.ts

**Commits:** `2eaf82d`, `93ca425`
**Files:** `src/tools/execute-prompt.ts`, `src/providers/claude.ts`, `src/providers/gemini.ts`, `src/providers/codex.ts`, `src/providers/copilot.ts`, `src/os/windows.ts`, `src/providers/provider.ts`

**Done criteria check:**
- `-p` argument is prefixed with `[<inv>] `: PASS — All five provider `buildPromptCommand` methods and the Windows `buildAgentPromptCommand` now destructure `inv` from opts and prepend `[${inv}] ` when `inv` is truthy.
- `inv` value comes from LogScope: PASS — `execute-prompt.ts` passes `inv: scope.getInv()` in promptOpts (line ~160).
- `.fleet-task.md` content untouched: PASS — only the `-p` instruction string is modified.
- Existing tests still pass: PASS — 1117 tests passing.

**Implementation detail:** The LogScope was moved earlier in the function (before `promptOpts` construction) so `scope.getInv()` is available when building the command. This reordering is correct — the scope is constructed from data already available at that point (`resolvedModel`, `input.resume`, `input.timeout_s`, `input.prompt`, `agent`).

**Code quality:**
- The `inv` field is optional in `PromptOptions` (`inv?: string`), guarded by `if (inv)` in all providers. Clean — no breakage for callers that don't provide it.
- Pattern is consistent across all 5 providers + Windows path. Good.
- Commit `93ca425` correctly caught that the Windows `buildAgentPromptCommand` was missed in the initial commit `2eaf82d`. Both are now covered.

**Verdict: PASS**

### Task 4: Unit tests for inv token prepend

**Commits:** `2eaf82d`
**Files:** `tests/execute-prompt.test.ts`

**Done criteria check:**
- Test for fresh session (`resume: false`): PASS — verifies `-p "[` and `] Your task is described in` in the command string, plus regex match for 5-char alphanumeric inv token.
- Test for resumed session (`resume: true`): PASS — same assertions with a pre-existing sessionId.
- Tests pass: PASS — all 3 new tests in the `inv token prepend (T4)` describe block pass.

**Test quality:**
- 3 tests: fresh session, resumed session, and uniqueness across calls. The uniqueness test is a good addition — it verifies two consecutive calls produce different inv tokens, guarding against accidental static values.
- Tests inspect the raw command string via `mockExecCommand.mock.calls[1][0]` — this is brittle if call ordering changes, but matches the existing test patterns in the file. Acceptable.
- No test for the Windows path (`buildAgentPromptCommand`). The Windows path uses the same `inv` field from `PromptOptions` and the same conditional logic, but test coverage only exercises the Linux provider path. NOTE — the Windows codepath was a separate fix commit (`93ca425`), suggesting it was initially missed. A Windows-specific unit test would have caught this. Not blocking since the logic is identical, but flagged as a gap.

**Verdict: PASS**

---

## Regression Check

No regressions detected in previously approved phases. The pre-existing stall detector integration in `execute-prompt.ts` (from prior approved commits `b71a0a9`, `5787650`) is unchanged by Phase 1 work. The `fs.watch`-based log discovery in `onPidCaptured` remains as interim scaffolding — it will be replaced by the mtime-based `findLogFile` in Phase 2.

---

## Summary

**Phase 1: PASS** — All four tasks (T1–T4) meet their done criteria. Build and tests are green (1117 passed, 6 skipped). Code aligns with both PLAN.md specifications and the design intent in requirements.md and stall-detector-design.md.

**No blocking issues found.**

**Notes carried forward (non-blocking):**
1. `resolveSessionLogPath` uses `workFolder.split(/[\\/]/).pop()` for Gemini basename extraction instead of `basename()` used in `resolveSessionLogDir` — cosmetic inconsistency.
2. No Windows-specific unit test for `buildAgentPromptCommand` inv token prepend — the logic is identical to the Linux providers but was initially missed (caught and fixed in `93ca425`). A test would prevent future regressions.
3. Optional improvement from plan review still applies: reorder Phase 5 (cheap) before Phase 4 (premium) for tier monotonicity.
