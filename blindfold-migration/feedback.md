# blindfold-migration - Phase 5 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-05-20 14:50:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews.

---

## Phase 5 - move egress-confirm from `secret --confirm` to `auth --confirm` (commit 8b1bdd6)

### Diff scope

Commit 8b1bdd6 touches 7 files: 233 insertions, 103 deletions.
`git log --oneline ed9dbe1..HEAD` shows 2 commits since Phase 4: the Phase 4
review commit (f2765da) and the Phase 5 work commit (8b1bdd6). Scope matches
expectations.

Files changed:

- `blindfold-migration/progress.json` (M) - expected
- `docs/features/oob-auth.md` (M) - `secret --confirm` -> `auth --confirm`
- `docs/tools-infrastructure.md` (M) - `secret --confirm` -> `auth --confirm` (heading + 3 references)
- `src/cli/auth.ts` (M) - added `handleConfirm`, updated dispatch and help text
- `src/cli/secret.ts` (M) - removed `handleConfirm`, `--confirm` dispatch, and `--confirm` help text
- `src/index.ts` (M) - help text: removed `secret --confirm`, added `auth --confirm`
- `tests/auth-cli.test.ts` (A) - 2 new tests for auth --confirm

### 5a. Deletion of old path (`secret --confirm`)

**PASS.** `grep -rn "secret --confirm\|secret_--confirm" src/ tests/ docs/ README.md`
returns zero matches. The old code path is fully removed:

- `src/cli/secret.ts`: `handleConfirm` function deleted (92 lines), `--confirm`
  dispatch branch removed, `--confirm` removed from help text.
- `src/index.ts`: `apra-fleet secret --confirm` help line removed.
- `docs/`: no references remain.

### 5b. Presence of new path (`auth --confirm`)

**PASS.** `auth --confirm` is present in all expected locations:

- `src/cli/auth.ts:21` - dispatch: `args.includes('--confirm')` returns early to `handleConfirm(args)`
- `src/cli/auth.ts:32` - usage text: `apra-fleet auth --confirm <credential-name>`
- `src/cli/auth.ts:42-138` - full `handleConfirm` implementation
- `src/index.ts:32` - help text: `apra-fleet auth --confirm <credential-name>`
- `docs/features/oob-auth.md:102` - `! apra-fleet auth --confirm <memberName>`
- `docs/tools-infrastructure.md:68,71,93` - heading, usage, and example updated

### 5c. auth.ts handleConfirm analysis

**PASS.** Verified src/cli/auth.ts:20-138:

- **Dispatch order:** `--confirm` at line 21, before `--oauth` (line 24) and
  `--api-key` (line 27). Correct - confirm runs first.
- **Name validation:** line 50: `NAME_REGEX.test(credentialName)` with
  `NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/` at line 9. Rejects invalid names
  with usage message and `process.exit(1)`.
- **Input sanitization:** `--context` (line 56-58) and `--on` (line 60-62)
  both sanitized via `CONTROL_CHARS = /[\x00-\x1f\x7f]/g` at line 10.
  Strips all control characters including NUL, TAB, LF, CR, ESC, DEL.
- **ASCII-only output:** Lines 64-73 print only ASCII text. No em-dashes,
  smart quotes, or other non-ASCII in the handleConfirm function.
- **Readline input:** Lines 76-90 use `readline.createInterface` with
  `process.stdin`/`process.stderr`, prompt `Type "yes" to allow`, resolves
  on answer. Properly closes rl on completion.
- **Confirmation check:** Line 92 checks `inputValue.toLowerCase() !== 'yes'`.
  NOTE: uses case-insensitive match (`toLowerCase()`), accepting "YES", "Yes",
  etc. This is reasonable UX.
- **Socket communication:** Line 98: `getSocketPath()` imported from `blindfold`
  (line 7). Line 101-102: connects via UDS, sends
  `{type:"auth", member_name:credentialName, password:inputValue}` as JSON + newline.
- **Response handling:** Lines 107-128: parses JSON response, prints success/error,
  properly closes client.

### 5d. secret.ts verification

**PASS.** Confirmed:

- No `handleConfirm` function exists in the file.
- No `--confirm` dispatch branch (the `else if (args[0] === '--confirm')` line is gone).
- No `apra-fleet secret --confirm` in help text (lines 9-17).
- Only 4 subcommands remain: `--set`, `--list`, `--update`, `--delete`.
- Dead imports cleaned up: `net` and `readline` imports are retained but still
  used by `handleSet` and `handleDelete`.

### 5e. index.ts help text

**PASS.** Line 32: `apra-fleet auth --confirm <credential-name>` present.
No `apra-fleet secret --confirm` line. The `secret` block (lines 29-31) shows
only `--set`, `--list`, `--delete`.

### 5f. Build

**PASS.** `npm run build` (tsc) exits 0 with clean output on Node 20.20.1.

### 5g. Tests + INC-1 isolation

**PASS.** 1169 passing, 3 failing, 5 skipped (72 test files).

Failure breakdown (all pre-existing baseline):

| Test file | Failure | Classification |
|---|---|---|
| tests/platform.test.ts | linux: returns pristine env from login shell | Pre-existing (platform) |
| tests/time-utils.test.ts:30 | IST timezone offset | Pre-existing (time-utils) |
| tests/time-utils.test.ts:57 | minute preservation | Pre-existing (time-utils) |

Test count increased from 1167 (Phase 4) to 1169: the 2 new tests in
`tests/auth-cli.test.ts` account for the difference.

**INC-1 isolation:** Registry diff = 0 lines. Snapshotted
`~/.apra-fleet/data/registry.json` before and after `npm test`;
`diff pre post | wc -l` -> 0. Hardening holds.

### 5h. Help smoke test

**PASS.** `node dist/index.js --help | grep -i confirm` returns exactly one line:

```
  apra-fleet auth --confirm <credential-name>                 Confirm network egress for that credential (interactive)
```

Zero `secret --confirm` references.

### 5i. Bad-name rejection

**PASS.** `node dist/index.js auth --confirm "bad name with spaces"` prints:

```
Usage: apra-fleet auth --confirm <credential-name>
  Name must match [a-zA-Z0-9_-]{1,64}
```

Exit code: 1 (verified directly; the task-prescribed pipe to `head -5` masks
the exit code because `$?` captures `head`'s exit status, not node's).

### 5j. Spurious OOB terminal pops

**PASS.** No OS-level GUI terminal windows were spawned during the test run.

### 5k. ASCII + AI attribution

**PASS.** `git log -1 --pretty=full 8b1bdd6` shows commit message:
`feat(cli): move egress-confirm from 'secret --confirm' to 'auth --confirm'`.
ASCII-only. No Claude/Anthropic/AI attribution. Matches PLAN.md Phase 5
commit message.

The Phase 5 diff (`git diff ed9dbe1..8b1bdd6`) contains zero non-ASCII
characters in new code. The only non-ASCII in the diff is the pre-existing
em-dash pattern in `progress.json` step descriptions (present in all phases
0-6, not introduced by Phase 5).

Pre-existing non-ASCII characters in auth.ts (checkmark/cross-mark in
`handleOAuth`/`handleApiKey`/`parseTokenArgs`) are unchanged by this commit.

### 5l. New test coverage (tests/auth-cli.test.ts)

**PASS.** The new test file adds 2 well-structured tests:

1. Happy path: mocks readline to answer "yes", simulates socket connect/response,
   verifies JSON payload is `{type:"auth", member_name:"TEST_CRED", password:"yes"}`
   and socket path is `/tmp/test-fleet.sock`.
2. Bad name rejection: verifies `runAuth(['--confirm', 'bad name!'])` triggers
   `process.exit(1)` before any socket connection (socket path remains empty).

Tests properly mock `blindfold`, `node:readline`, and `node:net`.

### 5m. Doc changes

**PASS.** All 4 doc references updated:

- `docs/features/oob-auth.md:102` - `secret --confirm` -> `auth --confirm`
- `docs/tools-infrastructure.md:68` - heading updated
- `docs/tools-infrastructure.md:71` - usage block updated
- `docs/tools-infrastructure.md:93` - example updated

---

## Summary

**Verdict: APPROVED**

Phase 5 gate results:

- (5a) Zero `secret --confirm` references: **PASS** (count: 0)
- (5b) `auth --confirm` present (auth.ts, index.ts, docs): **PASS**
- (5c) handleConfirm correctness (dispatch order, validation, sanitization, socket): **PASS**
- (5d) secret.ts clean (no handleConfirm, no --confirm dispatch): **PASS**
- (5e) index.ts help text (no secret --confirm, has auth --confirm): **PASS**
- (5f) Build green: **PASS**
- (5g) Tests 1169/3 (all 3 pre-existing baseline): **PASS**
- (5g) INC-1 registry isolation (diff lines: 0): **PASS**
- (5h) Help smoke (only auth --confirm): **PASS**
- (5i) Bad-name rejection (exit code 1): **PASS**
- (5j) Spurious OOB terminal pops: **PASS** (none)
- (5k) ASCII + no AI attribution: **PASS**
- (5l) New test coverage (2 tests): **PASS**
- (5m) Doc updates (4 references): **PASS**

**HIGH findings:** 0
**MEDIUM findings:** 0
**LOW findings:** 0
