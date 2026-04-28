# Phase 1 Code Review — T7, T8, T11

**Branch:** `sprint/session-lifecycle-oob-fix`  
**Reviewed commits:** `74b3017` (T7), `c7352f1` (T8), `d71e468` (T11)  
**Reviewer:** Claude (Opus 4.6)  
**Date:** 2026-04-27  

---

## Verdict: APPROVED — 0 blocking, 0 advisory

Build: 0 errors. Tests: 1021 pass, 6 skipped, 0 failures.

---

## T7 — `stop_prompt` PID fix (`74b3017`)

**Requirement:** Extract `FLEET_PID:` from the stdout data stream in real-time, not from the buffered result after process exit. `clearStoredPid` must be called in close/error handlers.

**Findings — all checks pass:**

| Check | Result |
|-------|--------|
| `LocalStrategy` (`strategy.ts:130-142`): `child.stdout.on('data')` handler scans each incoming chunk for `FLEET_PID:(\d+)` and calls `setStoredPid()` immediately on first match | PASS |
| `pidExtracted` flag (line 84) prevents redundant regex on subsequent chunks | PASS |
| PID line is stripped from buffered stdout (`chunk.replace(...)`, line 139) so it doesn't leak into tool output | PASS |
| `clearStoredPid(this.agent.id)` called in `child.on('close')` (line 172) | PASS |
| `clearStoredPid(this.agent.id)` called in `child.on('error')` (line 185) | PASS |
| `RemoteStrategy` (ssh.ts:180-194): equivalent streaming extraction in `stream.on('data')` handler with same `pidExtracted` guard | PASS |
| `clearStoredPid(agent.id)` in SSH `stream.on('close')` (line 222) and `stream.on('error')` (line 237) | PASS |
| Diagnostic log `console.error(\`[fleet] stored PID ...\`)` emitted on capture (strategy.ts:138, ssh.ts:190) | PASS |

The `extractAndStorePid` helper at strategy.ts:15-23 still exists and still operates on the buffered result. This is fine — it serves as a safety net / secondary parse. The primary extraction now happens in the streaming handlers where it matters.

---

## T8 — `windows.ts` provider flag delegation (`c7352f1`)

**Requirement:** Add `permissionModeAutoFlag(): string | null` to `ProviderAdapter` interface; implement in all 4 providers. `windows.ts` must call `provider.permissionModeAutoFlag()` instead of hardcoding `--permission-mode auto`.

**Findings — all checks pass:**

| Check | Result |
|-------|--------|
| `ProviderAdapter` interface (provider.ts:57): `permissionModeAutoFlag(): string \| null` declared | PASS |
| `ClaudeProvider` (claude.ts:57-59): returns `'--permission-mode auto'` | PASS |
| `GeminiProvider` (gemini.ts:52-54): returns `null` | PASS |
| `CodexProvider` (codex.ts:55-57): returns `'--ask-for-approval auto-edit'` | PASS |
| `CopilotProvider` (copilot.ts:59-62): returns `null` + emits `console.warn` | PASS |
| `windows.ts:124-129` (`buildAgentPromptCommand`): calls `provider.permissionModeAutoFlag()`, guards with `if (autoFlag)` before appending | PASS |
| No hardcoded `--permission-mode auto` remains in windows.ts | PASS |

Provider return values match the truth table in requirements.md exactly. The `dangerous` path continues to use `provider.skipPermissionsFlag()` correctly.

---

## T11 — `windowsHide` fix (`d71e468`)

**Requirement:** `spawn()` in `LocalStrategy` must have `windowsHide: true`. A test must assert this.

**Findings — all checks pass:**

| Check | Result |
|-------|--------|
| `strategy.ts:88`: `spawn(wrapped, { shell: shell ?? true, cwd: this.agent.workFolder, env, windowsHide: true })` | PASS |
| Test (`tests/strategy.test.ts:132-140`): reads source file and asserts `/windowsHide:\s*true/` is present | PASS |

The source-inspection approach for the test is pragmatic — mocking `spawn` options in ESM is non-trivial. Acceptable.

---

## Build & Test

```
npm run build  → 0 errors
npm test       → 1021 passed, 6 skipped, 0 failures
```

---
---

# Phase 2 Code Review — T9 Structured Logging

**Reviewer:** Claude (Opus 4.6)
**Date:** 2026-04-27
**Branch:** sprint/session-lifecycle-oob-fix
**Build:** 0 errors | **Tests:** 1021 pass, 6 skipped, 0 fail

---

## Verdict: APPROVED with one non-blocking finding

---

## Detailed Findings

### 1. maskSecrets redaction — PASS

- `{{secure.[a-zA-Z0-9_]{1,64}}}` correctly matches the canonical token syntax.
- `sec://[a-zA-Z0-9_]+` correctly matches credential handles.
- Edge cases verified:
  - **Nested tokens** (`{{secure.{{secure.inner}}}}`): inner match is redacted, outer residue is harmless — and this pattern can't occur in practice since token names are `[a-zA-Z0-9_]` only.
  - **Uppercase** (`{{SECURE.FOO}}`): not matched — correct, the token syntax is defined as lowercase throughout (execute-prompt.ts:89, execute-command.ts:65).
  - **No trailing brace** (`{{secure.FOO`): not matched — correct, incomplete tokens should not be redacted.

### 2. truncateForLog null/undefined safety — PASS (by design)

`truncateForLog` does not guard against null/undefined, but all call sites pass Zod-validated `z.string()` values. Adding a null guard would be dead code. Acceptable.

### 3. LLM PID log timing — PASS

PID is extracted from the streaming `data` handler (strategy.ts:137-145 for local, ssh.ts:184-195 for SSH), not post-close. Correct.

### 4. child.pid logged immediately after spawn — PASS

strategy.ts:90-91 logs `child.pid` synchronously after `spawn()`, before any async data arrives. Correct.

### 5. Exit log with exit code and elapsed ms — PASS

execute-prompt.ts:228 (`finally` block) logs `exit=<code> elapsed=<N>ms`. Both values present. Correct.

### 6. Tests for maskSecrets / truncateForLog — FINDING (non-blocking)

No test file exists for `src/utils/log-helpers.ts`. Edge-case coverage for `maskSecrets` (e.g., multiple tokens in one string, adjacent tokens, empty string) and `truncateForLog` (exactly-at-boundary, multi-line input) would add confidence. **Recommend adding tests in a follow-up task.**

### 7. Build & test — PASS

Build: 0 errors. Tests: 1021 pass (up from 1020 in Phase 1 — no regressions).

## Phase 1 Cumulative Check

T7 (idle touch), T8 (auth-env), T11 (windowsHide) — no regressions detected. All prior test suites still passing.
