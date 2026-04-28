# Final Cumulative Review — Sprint `session-lifecycle-oob-fix`

**Reviewer:** Claude (Opus 4.6)  
**Date:** 2026-04-27  
**Branch:** `sprint/session-lifecycle-oob-fix`  
**Commits reviewed:** 66 commits (`ac57213..66d93e4`)  
**Build:** 0 errors | **Tests:** 1010 passed, 6 skipped, 0 failures

---

## Verdict: APPROVED — ship it

All 10 requirements (T1–T10) plus the bonus T11 are implemented, verified, and regression-free. No blocking findings. No advisory findings.

---

## Phase-by-Phase Summary

### Phase 1 — T7, T8, T11 (Core Bugs)

| Task | Description | Status |
|------|-------------|--------|
| T7 | `stop_prompt` PID fix — extract from stdout stream in real-time | ✅ Verified |
| T8 | `windows.ts` provider flag delegation via `permissionModeAutoFlag()` | ✅ Verified |
| T11 | `windowsHide: true` in `spawn()` to suppress cmd.exe flashes | ✅ Verified |

**T7** was the critical bug. PID is now extracted in the `child.stdout.on('data')` handler (strategy.ts:137–145) and the SSH `stream.on('data')` handler (ssh.ts:184–195), with `clearStoredPid()` in both close and error handlers. The streaming approach means `stop_prompt` can actually kill running processes.

**T8** added `permissionModeAutoFlag()` to the `ProviderAdapter` interface with correct per-provider returns: Claude → `--permission-mode auto`, Codex → `--ask-for-approval auto-edit`, Gemini → `null`, Copilot → `null` + warning.

### Phase 2 — T9 (Structured Logging)

| Task | Description | Status |
|------|-------------|--------|
| T9 | Structured logging for `execute_prompt` and `execute_command` | ✅ Verified |

Logging via `console.error` (stderr — correct for MCP server). Secret masking covers `{{secure.*}}` and `sec://` patterns. Truncation at 80 chars. Entry/exit/PID logs all present. Helper in `src/utils/log-helpers.ts`.

### Phase 3 — T1, T2, T3 (Skill Docs)

| Task | Description | Status |
|------|-------------|--------|
| T1 | SKILL.md per-provider unattended flag table | ✅ Verified against source |
| T2 | `credential_store_update` added to Core Fleet Tools table | ✅ Verified |
| T3 | Copilot unattended limitation documented | ✅ Verified |

All 8 cells in the provider flag table verified against source code (claude.ts, gemini.ts, codex.ts, copilot.ts). Zero factual errors.

### Phase 4 — T4, T5, T6 (Docs & Shell Quoting)

| Task | Description | Status |
|------|-------------|--------|
| T4 | Gemini mechanic in doer-reviewer.md → SKILL.md cross-reference | ✅ Verified |
| T5 | Sub-bullet formatting fix in doer-reviewer.md | ✅ Verified |
| T6 | `${credFile}` double-quoted in linux.ts shell strings | ✅ Verified (5 sites) |

**T6** is defense-in-depth — the label regex prevents metacharacters today, but quoting protects against future relaxation. Test assertion updated to match.

### Phase 5 — T10 (Test Audit)

| Task | Description | Status |
|------|-------------|--------|
| T10 | Test suite audit — remove 11 duplicate tests | ✅ Verified |

**Deletion verification (all 11 tests):**

1. **`tests/unit/inactivity-timer.test.ts`** (3 tests, entire file deleted): Exact duplicates of `tests/integration/session-lifecycle.test.ts` "Inactivity timer — integration (T13)" describe block. Same shell commands, same assertions, same timeout values. The integration test is the canonical home.

2. **`tests/unattended-mode.test.ts`** (4 tests, describe block removed): "WindowsCommands.buildAgentPromptCommand: unattended flag" — identical coverage in `tests/windows-pid-wrap.test.ts` section 4 "buildAgentPromptCommand: unattended modes produce correct ArgumentList". Same 4 scenarios (auto, dangerous, false, undefined), same assertions.

3. **`tests/unit/pid-wrapper.test.ts`** (4 tests removed from "pidWrapWindows string structure"): FLEET_PID marker, `$_fleet_proc.Id`, ProcessStartInfo/UseShellExecute, WaitForExit/ExitCode — all covered by `tests/windows-pid-wrap.test.ts` sections 1–2 with finer-grained assertions.

**Security boundary tests:** Zero deleted. Credential scoping (17 tests), TTL rejection, label injection, and member identity tests all intact in `credential-scoping-ttl.test.ts` and `vcs-isolation.test.ts`.

**Coverage gaps:** None introduced. Every deleted test has a verified surviving counterpart at the same or higher abstraction level.

---

## Cross-Cutting Checks

### Build & Type Safety
- `npm run build` (tsc): **0 errors**
- No `any` casts introduced
- Provider interface changes propagated to all 4 implementations

### Test Suite
- **1010 tests pass**, 6 skipped, 0 failures
- 60 test files (down from 61 after inactivity-timer.test.ts deletion)
- No flaky tests observed

### Security Review
- Credential values never logged (maskSecrets redacts `{{secure.*}}` and `sec://`)
- Shell injection surface hardened (T6 quoting)
- PID lifecycle prevents stale PID accumulation (clearStoredPid on close/error)
- Label regex constraint (`/^[a-zA-Z0-9_-]{1,64}$/`) unchanged and intact

### Regressions
- No regressions detected across any phase
- All prior sprint work (PID lifecycle, inactivity timers, OOB auth, headless detection) remains functional

---

## Requirements Traceability

| Req | Severity | Commit(s) | Verified |
|-----|----------|-----------|----------|
| T1 | Blocking | `5d49a1a` | ✅ |
| T2 | Non-blocking | `7f60fce` | ✅ |
| T3 | Non-blocking | `cd1df24` | ✅ |
| T4 | Advisory | `b45f6c9` | ✅ |
| T5 | Advisory | `1180f0c` | ✅ |
| T6 | Advisory | `307d35d`, `cd89686` | ✅ |
| T7 | Critical | `74b3017` | ✅ |
| T8 | Bug | `c7352f1` | ✅ |
| T9 | Feature | `9d5854f` | ✅ |
| T10 | Refactor | `5e5cd80` | ✅ |
| T11 | Bonus | `d71e468` | ✅ |

**All 11 items addressed. Sprint is complete.**
