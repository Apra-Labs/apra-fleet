# Review: commit 390c4ca — `fix: unknown subcommand error, update --check, secret in help`

**Branch:** `fixes/after_v0.1.8`
**Verdict: CHANGES NEEDED**

---

## Findings

### 1. `src/index.ts` — Unknown subcommand error handling

**PASS.** The unknown-command fallback (line 58-60) correctly errors for `apra-fleet foo`, and the `arg === undefined` guard (line 55) ensures no error when invoked with no arg (stdio mode).

### 2. `src/index.ts` — `update` / `update --check` dispatch

**PASS.** Both cases are handled:
- `update --check` (line 47-50): imports `runUpdateCheck()` and runs it.
- `update` alone (line 51-53): prints a "coming soon" message with a manual download link.

Minor note: `restArgs = process.argv.slice(2)` at line 46 includes `'update'` itself in the array, but this is harmless because it only checks for `--check`.

### 3. `src/index.ts` — `--help` text

**PASS (with caveat).** Help text correctly shows `secret --set/--list/--delete` (lines 26-28) and does NOT show `auth`. The `auth` subcommand is still handled silently at line 41 (hidden/internal), which is fine.

### 4. `src/index.ts` — Missing `secret` subcommand dispatch (BUG)

**FAIL.** The help text advertises `apra-fleet secret --set <name>`, `--list`, and `--delete`, but there is **no `else if (arg === 'secret')` branch** in the CLI dispatch (lines 36-61). Running `apra-fleet secret --set foo` will hit the unknown-command error at line 58:

```
apra-fleet: unknown command 'secret'
```

This is a user-facing bug — the help promises a command that doesn't work.

### 5. `src/services/update-check.ts` — `runUpdateCheck()` correctness

**PASS.** The function correctly:
- Fetches the latest release from GitHub (line 70)
- Uses a 5s abort timeout (line 66-67)
- Compares versions using the existing `isNewer()` helper (line 91)
- Prints a clear "available" or "up to date" message (lines 92-94)
- Handles network failure gracefully: catch block at line 97 prints a helpful fallback message, no crash
- Handles non-ok response (line 78) and missing `tag_name` (line 85) gracefully

### 6. `src/services/update-check.ts` — Pre-release filtering inconsistency

**ISSUE.** `checkForUpdate()` (line 50) explicitly skips pre-release tags (`alpha`, `beta`, `rc`):
```ts
if (!tagName || /-(alpha|beta|rc)\b/i.test(tagName)) return;
```
But `runUpdateCheck()` does NOT apply this filter. If the latest GitHub release is a pre-release tag, the CLI will report it as available to the user, while the background check would silently ignore it. This is inconsistent.

### 7. `src/services/update-check.ts` — Duplication

**ACCEPTABLE (with note).** `runUpdateCheck()` duplicates ~20 lines of fetch/abort/parse logic from `checkForUpdate()`. The two functions have different concerns (silent cache vs. CLI print-and-exit), so the duplication is tolerable for now. A shared `fetchLatestTag()` helper would reduce this, but it's not blocking. If the pre-release filter is added to `runUpdateCheck`, the duplication argument becomes stronger — consider extracting at that point.

---

## Test Gap Analysis

**Test count: 1075 passed (unchanged from prior baseline).** No tests were added or removed by this commit.

### Missing test coverage

1. **`runUpdateCheck()`** — No tests exist. The existing `tests/update-check.test.ts` covers `checkForUpdate`, `isNewer`, and `getUpdateNotice`, but not the new `runUpdateCheck` function. Needed tests:
   - Newer version available: prints "is available" message
   - Up to date: prints "is up to date" message
   - Network failure: prints fallback message (no crash)
   - Non-ok HTTP response: prints fallback message
   - Missing `tag_name`: prints fallback message

2. **Unknown subcommand path** — No tests cover the CLI dispatch error for unknown commands. Lower priority since this is a simple branch, but would be nice for regression safety.

---

## Recommendations

1. **Add `secret` subcommand dispatch** in `src/index.ts` — add an `else if (arg === 'secret')` branch that imports and runs the credential-store CLI handler. Without this, the help text is misleading.

2. **Add pre-release filter** to `runUpdateCheck()` — match the behavior of `checkForUpdate()` by skipping alpha/beta/rc tags.

3. **Add tests for `runUpdateCheck()`** — at minimum cover the happy path (newer available, up to date) and error paths (network failure, non-ok response).
