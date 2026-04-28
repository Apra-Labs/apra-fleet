# #201 Pino JSONL Logging — Phase 2 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28 12:05:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review. Prior version was the Phase 1 code review (APPROVED, ee86440). This is the cumulative review covering Phase 1 + Phase 2, with focus on Phase 2 tasks T4, T5, and the V2 checkpoint.

---

## Phase 1 Regression Check — PASS

Phase 1 files (`log-helpers.ts`, `execute-prompt.ts`, `execute-command.ts`, `stop-prompt.ts`, `provision-vcs-auth.ts`, `revoke-vcs-auth.ts`, `ssh.ts`, `strategy.ts`) are unchanged between the V1 commit (4641d15) and HEAD. No regressions introduced by Phase 2 work.

---

## T4: Full console.* audit — PASS

### Methodology

Ran `grep -rn 'console\.\(error\|warn\|log\)' src/ --include='*.ts'` on the working tree. Compared against the PLAN.md audit summary and done criteria.

### Migrated call sites

| File | Calls replaced | Level used | memberId | Correct? |
|---|---|---|---|---|
| `src/providers/copilot.ts` | 3 `console.warn` → `logWarn` | warn | Omitted (ProviderAdapter methods have no agent param) | PASS |
| `src/services/auth-socket.ts` | 2 `console.error` → `logError` | error | Omitted (no member context in terminal launch) | PASS |
| `src/utils/crypto.ts` | 1 `console.warn` → `logWarn` | warn | Omitted (utility function, no member context) | PASS |
| `src/index.ts` | 2 `console.error` → `logLine` | info | Omitted (CLI dispatch catch handlers, no member context) | PASS |

All four files in the PLAN.md T4 scope are covered. The level choices are appropriate: `logWarn` for warnings, `logError` for error conditions, `logLine` (info) for the CLI catch handlers which are informational error reports.

### Remaining console.* calls — justified

| File | Count | Justification |
|---|---|---|
| `src/utils/log-helpers.ts` | 3 | Internal: the `console.error` calls inside `logLine`/`logWarn`/`logError` themselves — this is the stderr parity mechanism. |
| `src/cli/install.ts` | 20 | CLI installer user-facing output. Fully exempt per PLAN.md decision. `APRA_FLEET_DATA_DIR` may not exist yet. |
| `src/cli/auth.ts` | 15 | CLI auth prompts — user-facing stderr interaction. Exempt. |
| `src/smoke-test.ts` | 18 | Standalone test harness script. Exempt. |
| `src/index.ts` | 2 | `console.log` for `--version` and `--help` — intentional stdout output for CLI UX. Exempt. |

**Total remaining:** 58 calls — all either in `log-helpers.ts` (internal) or in exempt CLI/test scripts producing user-facing output. Zero unjustified `console.*` calls remain in server-side code.

### copilot.ts — additional changes noted

The diff against main shows `copilot.ts` also gained a `permissionModeAutoFlag()` method and the `buildPromptCommand()` signature changed from `dangerouslySkipPermissions` to `unattended`. These are PR #183 changes already on the branch before this sprint, not T4 work. The T4-specific changes are limited to the 3 `console.warn` → `logWarn` replacements plus the `logWarn` import — correct and in scope.

**Done criteria met:** grep returns only `log-helpers.ts` internal calls and justified CLI user-facing output. All replaced calls use appropriate log levels.

---

## T5: Tests — PASS

### Test file: `tests/log-helpers.test.ts` (131 lines, 7 tests)

Reviewed against PLAN.md's 6 required test cases:

| # | PLAN.md case | Test | Verdict |
|---|---|---|---|
| 1 | First logLine creates `logs/` dir and log file | "creates APRA_FLEET_DATA_DIR/logs/ directory on first logLine call" | PASS — asserts `fs.existsSync(logsDir)` false→true |
| 2 | Written line is valid JSON with `ts`, `pid`, `level`, `tag`, `msg` | "writes with tag and msg fields; level/pid formatters produce correct shape" | PASS — asserts `mockInfo` called with `{ tag: 'mytag' }` + msg; verifies formatter outputs for level, pid, and ts (ISO 8601 pattern) |
| 3 | `memberId` populates `member_id`; omitting excludes it | "populates member_id when memberId provided; excludes it when omitted" | PASS — two assertions: with memberId checks `member_id` present, without checks property absent |
| 4 | `maskSecrets()` applied — `{{secure.MY_KEY}}` → `[REDACTED]` | "applies maskSecrets() — {{secure.MY_KEY}} is written as [REDACTED]" | PASS — asserts the msg argument to pino is redacted |
| 5 | Log rotation config (10 MB / 3 files) | "verifies pino-roll rotation config: 10m size cap, 3 rotated files" | PASS — asserts transport options `size: '10m'` and `limit: { count: 3 }` |
| 6 | `console.error` still called | "still calls console.error on each logLine call" | PASS — spies on `console.error`, asserts called once with tag and message |

All 6 PLAN.md cases are covered. The 7th test ("configures pino with fleet-<pid>.log file path and correct transport options") provides additional coverage of the transport initialization — it verifies the file path contains `fleet-${process.pid}.log` and that pino is called with the expected options shape.

### Test quality assessment

- **Mock strategy is sound.** Tests mock pino at the module level (`vi.doMock('pino', ...)`) and verify the call arguments rather than testing pino's own behavior. This is the right level of abstraction for unit tests — it tests the integration wiring without requiring actual file I/O through pino.
- **Module isolation.** `vi.resetModules()` in `beforeEach` ensures each test gets a fresh `_logger` singleton. This prevents test ordering issues from the lazy initialization pattern.
- **No redundant tests.** Each test covers a distinct concern; no overlapping assertions.
- **Untested surface — `logWarn`/`logError` variants.** NOTE. The tests only exercise `logLine` (info level). `logWarn` and `logError` are thin wrappers with the same pattern, so the risk is low. Not blocking — the console.error spy test confirms the mechanism works, and the formatters test verifies level label production.

### providers.test.ts update — PASS

Two Copilot test cases updated to spy on `console.error` instead of `console.warn` (because `logWarn` routes through `console.error`). This is the correct adaptation per T5 done criteria: "Update any existing tests that assert on `console.error` output from `logLine` if the format changed."

**Done criteria met:** All new tests pass; no existing tests broken; `npm test` — 0 failures.

---

## V2: Build + Test Checkpoint — PASS

1. **`npm run build`** — 0 errors. TypeScript compiles cleanly.
2. **`npm test`** — 61 test files, 1017 tests passed, 6 skipped, 0 failures.

Test count increased from Phase 1 (1010 → 1017): 7 new tests in `log-helpers.test.ts`. Test file count increased from 60 → 61 (new file). Skipped count unchanged (6, pre-existing).

### CI status

Branch has not been pushed to remote — no GitHub Actions CI run exists. Local build and test both pass. CI verification will apply on push.

---

## Scope Hygiene

The Phase 2 diff (4641d15..48760c1) touches 8 files: 4 source files for T4 migrations, 1 new test file (T5), 1 existing test file update, `progress.json`, and `feedback.md`. All changes are within the sprint scope. No out-of-scope modifications detected.

---

## Summary

**Phase 2 APPROVED.** T4 (console.* audit) correctly migrates all 8 server-side `console.error`/`console.warn` calls across 4 files to `logLine`/`logWarn`/`logError` with appropriate levels. The 58 remaining `console.*` calls are all in exempt locations (log-helpers.ts internals, CLI scripts, smoke test). T5 (tests) covers all 6 PLAN.md test cases with clean mocking and no redundancy. Build passes with 0 errors; tests pass with 0 failures. No Phase 1 regressions. Phase 3 (T6 docs) can proceed.
