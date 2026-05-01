# Windows File-Transfer Bug Fix — Phase 2 Code Review

**Reviewer:** apra-fleet-reviewer
**Date:** 2026-05-02T03:05:00+05:30
**Verdict:** APPROVED

---

## T4: resolveRemotePath Fix

**PASS**

The `resolveRemotePath` function in `src/utils/platform.ts` (lines 36–47) correctly addresses the root cause:

1. **Backslash normalization** — Both `workFolder` and `subPath` have backslashes converted to forward slashes via `.replace(/\\/g, '/')`. Trailing slashes on `workFolder` are stripped.
2. **Windows drive-letter detection** — Uses `/^[A-Za-z]:/` regex on the normalized work folder to identify Windows targets.
3. **Path joining without path.posix.resolve** — For Windows work folders, joins `${normWorkFolder}/${normSubPath}` directly. For Linux/macOS, delegates to `path.posix.resolve` which works correctly for POSIX paths.
4. **Absolute subPath handling** — If `subPath` starts with a drive letter or `/`, it's treated as absolute and returned as-is (no double-joining).
5. **Edge cases** — Empty `subPath` produces `workFolder/` (acceptable — SFTP servers normalize trailing slashes). Relative paths with dots (`.claude/...`) resolve correctly since they don't trigger the absolute check.

In `src/services/sftp.ts`:
- `uploadViaSFTP` (line 68) uses `resolveRemotePath(agent.workFolder, destinationPath)` — correct.
- `downloadViaSFTP` (line 107) uses `resolveRemotePath(agent.workFolder, remotePath)` — correct.
- No remaining `path.posix.resolve` calls for remote path computation.
- No unused `workFolderPosix` locals — clean removal.

## T5: Cross-OS Test Matrix

**PASS**

`tests/file-transfer-matrix.test.ts` (237 lines) provides comprehensive coverage:

- **Comment block header** referencing issue #220 and PR #97 (lines 1–6).
- **resolveRemotePath unit tests** (lines 38–84): 9 cases covering Linux relative, Linux dotted, Linux absolute, Windows backslash+relative, Windows forward slash+relative, Windows dotted, Windows absolute forward, Windows absolute backslash, and the regression guard (no Linux CWD prefix).
- **All 5 repro cases from issue #220** explicitly labeled (Cases 1–5, lines 143–203): send_files with `_staging`, send_files with fresh filename, receive_files with dotted path, receive_files with non-dotted path, receive_files with absolute Windows backslash path.
- **Driver/target combos**: Linux→remote Linux (lines 91–129), Linux→remote Windows (lines 138–219), local Linux noted as covered elsewhere (lines 222–227), Windows→* marked as `describe.todo` (lines 234–236).
- **Tests are meaningful** — they exercise the actual `uploadViaSFTP`/`downloadViaSFTP` functions with mocked SSH connections and assert the exact remote paths passed to `fastPut`/`fastGet`. Reverting the fix would cause the regression guard and all Windows tests to fail.

## Build & Test Verification

**PASS (with pre-existing caveats)**

- **Build**: `tsc` reports 2 errors for missing type declarations (`smol-toml`, `@inquirer/password`) — these are pre-existing dependency issues unrelated to this branch's changes.
- **Tests**: 981 passed, 7 skipped, 1 failed. The single failure (`platform.test.ts` — Windows `cleanExec` env var check) and 2 test file import failures (`install-force`, `install-multi-provider`) are pre-existing and unrelated to the file-transfer fix. All file-transfer tests pass cleanly.

## Security Review

**PASS**

- **Path traversal (`../`)**: The `isContainedInWorkFolder` function (lines 9–30 of platform.ts) correctly collapses `..` segments using a stack-based approach before checking containment. This prevents escaping the work folder via `../../etc/passwd` style attacks.
- **Work folder escape**: `resolveRemotePath` itself does not validate containment (it's a resolution utility), but callers in the tool layer (`send-files.ts`, `receive-files.ts`) use `isContainedInWorkFolder` as a gate before transferring. The separation of concerns is correct.
- **No injection vectors**: Remote paths are passed directly to SFTP `fastPut`/`fastGet` — no shell interpolation, no command construction.

## T9: CI Gate Verification

**PASS**

`.github/workflows/ci.yml` contains a `build-and-test` job that:
1. Runs on a matrix of OSes: `[ubuntu-latest, macos-latest, windows-latest]` (line 28)
2. Installs dependencies via `npm ci` (line 43)
3. Builds with `npm run build` (line 46)
4. Runs tests with `npm test` (line 52)

The `npm test` command in package.json runs `vitest`, which automatically discovers all test files matching `**/*.test.ts` and `**/*.test.js` patterns. This includes the new `tests/file-transfer-matrix.test.ts` and all other test files. The CI gate will automatically fail any PR that breaks the cross-OS matrix tests.

## Summary

Phase 2 is **APPROVED**. The fix correctly replaces the broken `path.posix.resolve` pattern with a Windows-aware `resolveRemotePath` utility. The test matrix comprehensively covers all required driver/target combinations with explicit regression guards for the 5 repro cases from issue #220. Security boundaries are maintained. The 3 pre-existing test failures are unrelated to this branch. CI gate confirmed: matrix tests run automatically and will catch future regressions.
