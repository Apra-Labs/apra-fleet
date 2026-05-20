# blindfold-migration - Phase 4 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-05-20 14:35:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews.

---

## Phase 4 - delete fleet's stale security modules and unit tests (commit ed9dbe1)

### Diff scope

Commit ed9dbe1 touches 19 entries: 16 deletions (D) + 3 modifications (M).
`git log --oneline 0133e0a..HEAD` shows 2 commits since Phase 3:
the Phase 3 review commit (f3c1266) and the Phase 4 work commit (ed9dbe1).
Scope matches expectations.

Modified files beyond deletions:

- `blindfold-migration/progress.json` (M) - expected
- `src/cli/auth.ts` (M) - retargeted 1 stale dynamic import
  (`credentialResolve` from `../services/credential-store.js` -> `blindfold`)
- `src/index.ts` (M) - retargeted 2 stale dynamic imports
  (`purgeExpiredCredentials` from `./services/credential-store.js` -> `blindfold`,
  `cleanupAuthSocket` from `./services/auth-socket.js` -> `blindfold`)

These 3 dynamic imports were missed in Phase 2's mechanical rewrite. Fixing
them here is correct -- without it, the build would fail on the deleted files.

### 4a. Deletion set verification

**PASS.** Exactly 16 files deleted, matching PLAN.md Phase 4 specification:

Source (9):

- `src/services/auth-socket.ts` (D)
- `src/services/credential-store.ts` (D)
- `src/utils/crypto.ts` (D)
- `src/utils/secure-input.ts` (D)
- `src/utils/file-permissions.ts` (D)
- `src/utils/shell-escape.ts` (D)
- `src/utils/oob-timeout.ts` (D)
- `src/utils/credential-validation.ts` (D)
- `src/utils/collect-secret.ts` (D)

Tests (7):

- `tests/auth-socket.test.ts` (D)
- `tests/crypto.test.ts` (D)
- `tests/shell-escape.test.ts` (D)
- `tests/credential-validation.test.ts` (D)
- `tests/credential-cleanup.test.ts` (D)
- `tests/credential-scoping-ttl.test.ts` (D)
- `tests/credential-store-path.test.ts` (D)

No extra deletions. No expected files missing. Verified none of the 16 files
exist on disk after checkout.

### 4b. Leftover imports

**PASS.** Ran:

```
grep -rn "from '../(services/(auth-socket|credential-store)|utils/(crypto|secure-input|file-permissions|shell-escape|oob-timeout|credential-validation|collect-secret))'" src/ tests/
```

Zero matches. All import paths to deleted modules have been cleaned up,
including the 3 stale dynamic imports fixed in this commit.

### 4c. Build

**PASS.** `npm run build` (tsc) exits 0 with clean output on Node 20.20.1.

### 4d. Tests + INC-1 isolation

**PASS.** 1167 passing, 3 failing, 5 skipped (71 test files).

Failure breakdown (all pre-existing baseline):

| Test file | Failure | Classification |
|---|---|---|
| tests/platform.test.ts | linux: returns pristine env from login shell | Pre-existing (platform) |
| tests/time-utils.test.ts:30 | IST timezone offset | Pre-existing (time-utils) |
| tests/time-utils.test.ts:57 | minute preservation | Pre-existing (time-utils) |

No new regressions. The Phase-4-deletable test
(credential-scoping-ttl.test.ts:297) that appeared in Phase 3 results is
now correctly gone with the file deletion.

**INC-1 isolation:** Registry diff = 0 lines. Snapshotted
`~/.apra-fleet/data/registry.json` before and after `npm test`;
`diff pre post | wc -l` -> 0. Hardening holds.

### 4e. Coverage delegation spot-check

**PASS.** Blindfold's `tests/` directory contains matching test files that
cover the same behaviors as the deleted fleet tests:

| Deleted fleet test | Blindfold test | Coverage confirmed |
|---|---|---|
| tests/auth-socket.test.ts | blindfold/tests/auth-socket.test.ts | Socket path, pending auth, OOB password/API-key/confirm flows, cleanup, graphical display detection |
| tests/crypto.test.ts | blindfold/tests/crypto.test.ts | Encrypt/decrypt roundtrip, ciphertext uniqueness, tamper detection |
| tests/shell-escape.test.ts | blindfold/tests/shell-escape.test.ts | Single-quote wrapping, double-quote escaping, Windows/PowerShell/batch escaping, grep pattern escaping |

Additional blindfold tests also cover deleted fleet tests not spot-checked:

- `blindfold/tests/credential-store.test.ts` covers credential-cleanup,
  credential-scoping-ttl, and credential-store-path behaviors
- `blindfold/tests/credential-validation.test.ts` covers credential-validation

### 4f. Spurious OOB terminal pops

**PASS.** No OS-level GUI terminal windows were spawned during the test run.

### 4g. ASCII + AI attribution

**PASS.** `git log -1 --pretty=full ed9dbe1` shows commit message:
`chore(blindfold): delete fleet's stale security modules and unit tests`.
ASCII-only. No Claude/Anthropic/AI attribution. Matches PLAN.md Phase 4
commit message.

The 3 modified lines (import path changes) are ASCII-only. Pre-existing
non-ASCII characters in surrounding context lines (e.g. a checkmark in
auth.ts, an em-dash in index.ts) are unchanged by this commit.

---

## Summary

**Verdict: APPROVED**

Phase 4 gate results:

- (4a) Deletion set (exactly 16 files): **PASS**
- (4b) Leftover imports (count: 0): **PASS**
- (4c) Build green: **PASS**
- (4d) Tests 1167/3 (all 3 pre-existing baseline): **PASS**
- (4d) INC-1 registry isolation (diff lines: 0): **PASS**
- (4e) Coverage delegation spot-check (3/3 confirmed): **PASS**
- (4f) Spurious OOB terminal pops: **PASS** (none)
- (4g) ASCII + no AI attribution: **PASS**

**HIGH findings:** 0
**MEDIUM findings:** 0
**LOW findings:** 0
