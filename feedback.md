# apra-fleet #212 — Cumulative Code Review (Re-review)

**Reviewer:** fleet-rev
**Date:** 2026-05-02
**Verdict:** APPROVED

---

## Re-review: Non-blocking fixes verification

Three non-blocking notes were raised in the prior review (commit 412748e). The doer addressed all three across commits 23c583d, 8fcdad7, 979b079, 12de0e8, and 54e3a96.

### NOTE 1 — File stream flush race: RESOLVED

**Prior finding:** `fileStream.end()` was called synchronously, then `chmodSync` and `spawn` proceeded without awaiting the `finish` event.

**Fix (23c583d, 54e3a96):** `fileStream.end()` is now wrapped in a `new Promise` that resolves on `finish` and rejects on `error`. The `chmod` and `spawn` only execute after the promise resolves. Verified at `src/cli/update.ts:65-69`. The second commit fixes a minor TS error (`resolve(undefined)` instead of bare `resolve`). Correct.

### NOTE 2 — Missing `update --help` subcommand: RESOLVED

**Prior finding:** `apra-fleet update --help` was not handled and would trigger the full update flow.

**Fix (8fcdad7):** `src/index.ts:44-52` now checks for `--help` or `-h` in the rest args before dispatching to `--check` or `runUpdate()`. Prints a clear usage synopsis and exits with code 0. The check is ordered before `--check` dispatch, so `--help` always takes priority. Correct.

### NOTE 3 — Config path indirection: RESOLVED

**Prior finding:** Config path used `path.join(FLEET_DIR, '..', 'data', 'install-config.json')` — going up then back down unnecessarily.

**Fix (979b079):** Simplified to `path.join(FLEET_DIR, 'install-config.json')`. Verified at `src/cli/update.ts:75`. Correct.

### Test update (12de0e8)

The `tests/update.test.ts` mock for `createWriteStream` was updated to simulate the `finish` event callback, ensuring the stream flush promise resolves in tests. Progress notes updated accordingly. Correct.

---

## Build & Test Verification (re-review)

`npm run build` — **PASS.** TypeScript compiles cleanly, no errors or warnings.

`npm test` — **PASS.** 1072 tests passed, 6 skipped, 0 failures across 63 test files.

---

## Regression check

No regressions introduced by the three fixes:
- The stream flush fix is additive (wraps existing `end()` in a promise) — no change to the happy path behavior.
- The `--help` handler is inserted before existing dispatch logic, only matching `--help`/`-h` — no interference with `--check` or bare `update`.
- The config path change resolves to the same directory (`FLEET_DIR` is `~/.apra-fleet/data`), so runtime behavior is identical.

---

## Prior review findings (carried forward, all still valid)

All four phases (T1-T6) were reviewed and approved in commit 412748e. The full phase-by-phase review findings remain valid — no code in T1, T4, T5, or the non-fix portions of T2/T3 was modified by the fix commits. Key points:

- **T1 (install persistence):** `install-config.json` written with correct path, content, and `0o600` permissions.
- **T2 (runUpdate):** 10-step implementation verified — GitHub fetch, version compare, platform detection, download, chmod, config replay, detached spawn.
- **T3 (CLI wiring):** `--check` and bare `update` dispatched correctly with error handling.
- **T4 (notice string):** Updated to reference `apra-fleet update`.
- **T5/T6 (tests):** 8 test cases covering install persistence and update flow including edge cases.
- **Security:** No injection vectors, config read from local file only, permissions restricted.
- **Consistency:** Dynamic imports and error handling match existing patterns.

---

## Summary

All three non-blocking notes from the prior review are correctly resolved. Build passes, all 1072 tests pass, no regressions detected. The branch is ready to merge.
