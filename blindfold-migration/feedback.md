# blindfold-migration - Phase 2 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-05-20 14:15:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews.

---

## Phase 2 - mechanical import rewrite (commit a60be8b)

### Grep: zero stale fleet-local security imports

**PASS.** Ran the grep from the task spec against src/ and tests/,
excluding the source definition files themselves:

```
grep -rn "from '\.\.[/.]*\(services/auth-socket\|..." src/ tests/ \
  | grep -vE "src/services/auth-socket\.ts|..."
```

Zero matches. All consumer files now import from `'blindfold'`.

### Test mock targets retargeted to 'blindfold'

**PASS (with expected exception).** Ran:

```
grep -rn "vi.mock(...../src/services/...|.../src/utils/...)" tests/
```

One match: `tests/credential-scoping-ttl.test.ts:39` still mocks
`'../src/services/auth-socket.js'`. This file is in the Phase 4
deletion list (PLAN.md Phase 4 "Delete tests" section). Acceptable --
no live test files have stale mock targets.

### Build

**PASS.** `npm run build` (tsc) exits 0 with clean output on
Node 20.20.1.

### Tests + failure categorization

**PASS.** 1279 passing, 4 failing, 5 skipped (78 test files).

Failure breakdown:

| Test file | Failure | Classification |
|---|---|---|
| tests/platform.test.ts | linux: returns pristine env from login shell | Pre-existing baseline (same as Phase 0/1) |
| tests/time-utils.test.ts (x2) | IST timezone offset + minute preservation | Pre-existing baseline (same as Phase 0/1) |
| tests/credential-scoping-ttl.test.ts | execute_command credential scoping rejection | Phase-4-deletable (file listed for deletion in PLAN.md Phase 4) |

No new regressions introduced by Phase 2.

### INC-1 isolation held (registry diff)

**PASS.** Registry isolation verified empirically:

1. Snapshotted ~/.apra-fleet/data/registry.json before tests
2. Ran `rm -rf /tmp/apra-fleet-test-data && npm test`
3. Snapshotted registry after tests
4. `diff pre post | wc -l` -> **0**

Zero diff lines. INC-1 hardening (vitest.config.ts top-level env +
tests/setup.ts fail-fast guard) continues to hold.

### Spurious OOB terminal pops during test run

**PASS.** No OS-level GUI terminal windows were spawned during the
test run. All OOB code paths are properly mocked in test files.

### Import block hygiene (sampled files)

**PASS.** Sampled three files per the task spec:

- `src/tools/execute-command.ts:11` -- imports `escapeShellArg`,
  `escapePowerShellArg`, `credentialResolve`, `registerTaskCredentials`,
  `collectOobConfirm` from `'blindfold'`. No `.js` extension. No
  relative path. Correct.
- `src/services/ssh.ts:7` -- imports `decryptPassword` from
  `'blindfold'`. No `.js` extension. No relative path. Correct.
- `src/utils/auth-env.ts:3` -- imports `decryptPassword`,
  `escapeDoubleQuoted` from `'blindfold'`. Type import on line 1 from
  `'../types.js'` (non-security, correct). No relative security paths.

All three conform to the Phase 2 convention.

### ASCII + AI attribution

**PASS.** Scanned the cumulative diff (excluding blindfold submodule)
for non-ASCII characters. Found only pre-existing content:

- Em-dash in progress.json step description ("Phase 2 --" was already
  present before Phase 2 commit)
- UTF-8 BOM in `src/os/linux.ts` and `src/os/windows.ts` (pre-existing,
  visible in diff context lines only, not in Phase 2 additions)

Phase 2 itself introduced zero new non-ASCII characters.

No Claude/Anthropic/AI attribution in the commit message or new code.
The word "claude" appears in `tests/provision-auth.test.ts` comment and
progress.json notes referring to `claudeAiOauth` -- this is a legitimate
credential-type field name in the product, not AI attribution.

### OOB_TIMEOUT_MS status

**NOTE (LOW).** PLAN.md Phase 2 "Done when" states `grep -rn
"OOB_TIMEOUT_MS" src/ tests/` should return zero. The constant still
appears in 4 files: `src/services/auth-socket.ts`,
`src/utils/collect-secret.ts`, `src/utils/oob-timeout.ts`, and
`tests/auth-socket.test.ts`. All four are scheduled for deletion in
Phase 4. The doer's note in progress.json explains: "OOB_TIMEOUT_MS not
replaced in callers: only used inside files scheduled for Phase 4
deletion." This is a pragmatic deviation -- replacing the constant in
files that will be deleted next phase would be wasted churn. Verified
that zero non-deletion files reference OOB_TIMEOUT_MS. Acceptable.

---

## Summary

**Verdict: APPROVED**

Phase 2 gate results:

- Zero stale relative-path security imports (3b): **PASS**
- All vi.mock targets retargeted to 'blindfold' (3c): **PASS** (1 exception in Phase-4-deletable file)
- Build green (3a): **PASS**
- Tests: only pre-existing + Phase-4-deletable failures (3e): **PASS** (1279/1283, 4 failing -- 3 pre-existing + 1 Phase-4-deletable)
- INC-1 isolation held (3d): **PASS** (diff lines: 0)
- No spurious terminal pops (3f): **PASS**
- Import-block hygiene on sampled files (3g): **PASS**
- ASCII + no AI attribution (3h): **PASS**

**HIGH findings:** 0
**MEDIUM findings:** 0
**LOW findings:** 1 -- OOB_TIMEOUT_MS not replaced in Phase-4-deletable
files (pragmatic, no action needed)
