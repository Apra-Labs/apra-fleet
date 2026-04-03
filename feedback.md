# Reviewer Verdict: Phase 4

**Status:** CHANGES NEEDED

## Summary

Token accumulation logic (add-not-overwrite) is correct and well-tested. Tool registration is clean. Docs are clear. However, a file-naming bug in `update_task_tokens` means the updated JSON never actually overwrites `progress.json` on the member — it lands as a timestamped copy, silently breaking the workflow.

## Test Results

- 38 test files passed, 603 tests passed, 4 skipped (607 total)
- All 6 `update-task-tokens` tests pass — but the `sendFiles` mock masks the filename bug

## Issues (CHANGES NEEDED)

### 1. CRITICAL — Temp file basename prevents overwrite (`src/tools/update-task-tokens.ts:69`)

The temp file is written as `progress-<timestamp>.json`:
```ts
const tmpFile = path.join(tmpDir, `progress-${Date.now()}.json`);
```

`sendFiles` (via both SFTP and local strategies) uses `path.basename(localPath)` to determine the remote filename (`src/services/sftp.ts:67`, `src/services/strategy.ts:87`). So the file lands on the member as `progress-1680000000.json` instead of overwriting `progress.json`. The subsequent `git add progress.json` then stages the *original, unmodified* file.

**Fix:** Name the temp file `progress.json` (or use a temp directory to avoid collisions):
```ts
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tokens-'));
const tmpFile = path.join(tmpDir, 'progress.json');
```
Then clean up the temp directory after send.

### 2. MINOR — Shell injection surface (`src/tools/update-task-tokens.ts:30,88`)

Both `progress_json` and `task_id` are interpolated into shell commands without escaping:
```ts
command: `cat ${input.progress_json}`,
command: `git add ${input.progress_json} && git commit -m "chore: update token counts for task ${input.task_id}"`,
```

The project has `escapeShellArg()` in `src/utils/shell-escape.ts`. While the caller is an LLM with shell access, defense-in-depth is warranted — a path with spaces or special characters would break the commands even without malicious intent.

**Fix:** Use `escapeShellArg` for both values.

## Minor Notes (non-blocking)

- `tpl-progress.json`: `tier` is only on work tasks, not verify — makes sense, not an issue.
- Tests mock `sendFiles` and `executeCommand`, so the filename bug is invisible in the test suite. Consider adding a test that asserts the temp file basename is `progress.json`.
- The docs in `doer-reviewer.md` (lines 57-71) are clear and actionable. The regex, field mapping, and "skip if absent" guidance are unambiguous.
