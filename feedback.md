# apra-fleet #216 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-04 11:05:00-04:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior feedback.md history

```
f921d84 review: plan/issue-216 — fleet-rev          (initial plan review, CHANGES NEEDED — 6 findings)
788e440 review: plan/issue-216 re-review — fleet-rev (plan re-review, APPROVED)
3229d49 review: plan/issue-216 Phases 1–3 code review — APPROVED (T1–T4)
9b42d49 review: plan/issue-216 Phases 1–3 — CHANGES NEEDED (network policy default)
```

This review covers **Phase 4** (Tasks T5, T6) and verifies that prior blocking findings have been addressed. Scope: all commits from `8b99ef4` through `b1f0714`.

---

## Build & Test

- `npm run build`: **PASS** — clean TypeScript compilation, zero errors.
- `npm test`: 1143 passed, 6 skipped, 3 failed across 67 test files.
- **auth-socket.test.ts failures (3):** All 3 failures are in `tests/auth-socket.test.ts` — socket cleanup timing (EADDRINUSE on named pipes, test timeout on cleanup-during-wait). `git diff main..plan/issue-216 -- tests/auth-socket.test.ts` shows only cleanup-improvement changes (`0ee1a74`), not structural changes. These are pre-existing timing flakes, not introduced by T5/T6. **PASS (pre-existing)**
- **CI:** No CI runs for `plan/issue-216`. **NOTE** — not blocking since local build+test pass clean.

---

## Prior Blocking Finding: Still Open

**BLOCKING — Wrong default network policy (`src/cli/secret.ts` lines 252, 261):** The previous review (`9b42d49`) flagged that `credentialSet(name, secretValue, true, 'confirm')` uses `'confirm'` as the network policy default. Requirements.md is explicit: "Default network policy (no flag): `deny`" (line 47). Furthermore, `'confirm'` is "reserved for future" and "not in V1" (lines 99–100).

**This has NOT been fixed.** Lines 252 and 261 still read `'confirm'`. **FAIL**

Additionally, the new T5 tests codify the incorrect behavior:
- `tests/secret-cli.test.ts` line 96: `mockCredentialSet.mockReturnValue({ ..., network_policy: 'confirm', ... })` — mock uses `'confirm'`
- `tests/secret-cli.test.ts` line 241: `expect(mockCredentialSet).toHaveBeenCalledWith('my_secret', 'my-secret-value', true, 'confirm')` — assertion expects `'confirm'`

**Fix (4 lines):**

In `src/cli/secret.ts`:
```typescript
// Line 252: change 'confirm' to 'deny'
credentialSet(name, secretValue, true, 'deny');
// Line 261: change 'confirm' to 'deny'
credentialSet(name, secretValue, true, 'deny');
```

In `tests/secret-cli.test.ts`:
```typescript
// Line 96: change network_policy in mock default
network_policy: 'deny',
// Line 241: change assertion to expect 'deny'
expect(mockCredentialSet).toHaveBeenCalledWith('my_secret', 'my-secret-value', true, 'deny');
```

---

## Phase 4: Tests (T5, T6)

### T5 — Secret CLI Unit Tests (`tests/secret-cli.test.ts`)

**33 tests** covering:

- **No-arg / help (2 tests):** Exits 1 with no args, exits 0 for `--help`. **PASS**
- **Name validation via `--delete` (6 tests):** Accepts lowercase, uppercase+digits, 64-char max. Rejects hyphens, spaces, >64 chars. Error message includes regex. **PASS**
- **`--list` (3 tests):** Empty list message, table headers (NAME/SCOPE/POLICY/MEMBERS/EXPIRES), "—" for missing expiry. No secret values shown. **PASS**
- **`--set` (6 tests):** Missing name, invalid name, empty value, cancelled input, no-server-no-persist error, persist-only store, OOB delivery. All error messages correct. **PASS** (except network policy value — see blocking finding above)
- **`--delete` (6 tests):** Missing name, invalid name, not-found, success message, `--all` cancel, `--all` confirm+delete. **PASS**
- **`--update` (8 tests):** Missing name, invalid name, zero-flag error (new — addresses prior non-blocking note #2), not-found, `--allow`, `--deny`, `--members`, `--ttl`, invalid TTL. **PASS**

**Non-blocking note #2 from prior review (zero-flag `--update`) addressed:** `handleUpdate()` in `src/cli/secret.ts` now checks `Object.keys(patch).length === 0` and exits 1 with "No fields to update" message. T5 includes a test for this. **PASS**

Test infrastructure is well-structured: hoisted mocks, `ExitError` capture pattern for `process.exit`, proper cleanup in `afterEach`.

**Done-when:** `npm test` passes (33/33 in this file). **PASS**

### T6 — Credential-Store Path Derivation Tests (`tests/credential-store-path.test.ts`)

**7 tests** covering:

- **Call-time env var resolution (4 tests):**
  1. Writes `credentials.json` under `APRA_FLEET_DATA_DIR`. **PASS**
  2. Changing env var mid-process redirects subsequent writes to new dir. **PASS**
  3. Credential in dir-A not visible from dir-B (isolation). **PASS**
  4. Auto-creates data directory if missing (nested). **PASS**

- **Read/write path consistency (3 tests):**
  5. `credentialSet` → `credentialResolve` round-trip in same dir. **PASS**
  6. `credentialList` reads from `APRA_FLEET_DATA_DIR`. **PASS**
  7. `credentialDelete` removes from `APRA_FLEET_DATA_DIR`. **PASS**

All tests use temp dirs under `os.tmpdir()` with cleanup in `afterEach`. Env var properly restored. **PASS**

**Non-blocking note #3 from prior review (DRY dedup) addressed:** `loadCredentialFile()` and `saveCredentialFile()` in `src/services/credential-store.ts` now derive directory from `path.dirname(getCredentialsPath())` instead of independently reading `APRA_FLEET_DATA_DIR`. Single source of truth. **PASS**

**Done-when:** `npm test` passes (7/7 in this file). **PASS**

---

## Phases 1–3 Regression Check

- All Phase 1–3 code unchanged since prior APPROVED review (`3229d49`), except:
  - `src/cli/secret.ts`: +5 lines for zero-flag validation (improvement, PASS)
  - `src/services/credential-store.ts`: DRY refactor in `loadCredentialFile`/`saveCredentialFile` (improvement, PASS)
  - `tests/auth-socket.test.ts`: `0ee1a74` added `await cleanupAuthSocket` for test stability (improvement, PASS)
- Existing credential-store tests (29) still pass.
- No API changes, no removed exports.

**PASS — no regressions.**

---

## Security Review (Phase 4 additions)

| Check | Status |
|-------|--------|
| T5 tests don't leak real secrets (all mocked) | **PASS** |
| T6 tests use isolated temp dirs, restore env | **PASS** |
| No test fixtures contain secrets or credentials | **PASS** |
| T6 cleanup removes temp credentials from default dir | **PASS** |

---

## Summary

**Verdict: CHANGES NEEDED**

**One blocking finding (carried from prior review, still unfixed):**
- `src/cli/secret.ts` lines 252, 261: default network policy is `'confirm'` instead of `'deny'`. The new T5 test at line 241 also asserts the wrong value. Four-line fix across two files.

**Phase 4 code quality:**
- T5 (33 tests) and T6 (7 tests) are well-written, comprehensive, and pass cleanly.
- Two prior non-blocking notes have been addressed: zero-flag `--update` validation and `getCredentialsPath()` DRY dedup.
- Auth-socket cleanup improvement (`0ee1a74`) is a reasonable stability fix.

**Once the `'confirm'` → `'deny'` fix is applied to both source and test, Phase 4 is ready to APPROVE.**
