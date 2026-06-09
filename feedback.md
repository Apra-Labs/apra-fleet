# apra-fleet npm Packaging -- Phase 4 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 02:55:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior entries: db9936e (Phase 1 -- APPROVED), 25086a5 (Phase 2 -- APPROVED), bfc2e47
> (Phase 3 -- CHANGES NEEDED), 22235b3 (Phase 3 re-review -- APPROVED). This review covers
> Phase 4 (Task 7 / commit 04a23b9, Task 8 / commit 7d791a7, VERIFY 4445c04..200af0f).
> progress.json tasks 10, 11 are work; 12 is the Phase 4 VERIFY checkpoint.

---

## Independent verification

- `npm run build` -- clean (tsc, no errors).
- `npm test` -- **83 files passed (1 skipped), 1338 passed, 14 skipped, 0 failed.** Confirms
  the doer's 1338-passing claim exactly (Phase-3 baseline 1335 + 3 new update-npm tests).
- `node dist/index.js update` -- prints `apra-fleet is running in dev mode. Pull the latest
  source and rebuild.` No `Checking for updates...`, no fetch, no network error. PASS.
- File hygiene: `git diff --name-only 534e8dc~2..HEAD` lists only progress.json,
  src/cli/install.ts, src/cli/update.ts, tests/update-npm.test.ts, tests/update.test.ts --
  all justified (source, tests, tracking). No stray artifacts committed. The uncommitted
  CLAUDE.md/AGENTS.md and untracked .sprint/, results.json, docs plans are working-tree only,
  not in any sprint commit, and out of scope per the review brief.

---

## Focus 1 -- Redirect correctness in runUpdate() -- PASS

Read `src/cli/update.ts:11-23`. The early-return is the first statement in `runUpdate()`,
firing BEFORE any fetch/AbortController/network code (which begins at line 25
`Checking for updates...`).

- npm mode (`!isSea()` && `isNpmGlobalInstall()`): logs the four required lines including
  `  npm update -g @apra-labs/apra-fleet` AND the S14.4 skill-refresh reminder
  `  apra-fleet install`, then `return`. Correct.
- dev mode (`!isSea()` && `!isNpmGlobalInstall()`): logs the dev rebuild message, then
  `return`. Correct (verified live above).
- SEA mode (`isSea()` true): skips the entire `if (!isSea())` block and falls through to the
  existing fetch/download/spawn logic at lines 25-115 -- UNCHANGED from main
  (`git diff main..HEAD -- src/cli/update.ts` shows only the added early-return block + the
  import; no edits to the download path). Correct.

`isSea` export in install.ts (`git diff main..HEAD -- src/cli/install.ts`): the only change to
the function is `function isSea` -> `export function isSea`. Body is byte-for-byte identical
(`_seaOverride` short-circuit, `require('node:sea')`, catch->false). The `_setSeaOverride` test
hook is untouched. No behavioral change. PASS.

---

## Focus 2 -- New tests (tests/update-npm.test.ts) -- PASS

All 3 tests assert real behavior via per-test `vi.resetModules()` + `vi.doMock` of install.js,
re-importing update.js fresh each time:

- Test 1 (npm): asserts the five exact strings logged (`apra-fleet is installed via npm...`,
  `  npm update -g @apra-labs/apra-fleet`, ``, `After updating...`, `  apra-fleet install`)
  AND `fetch` NOT called. Real + non-tautological.
- Test 2 (dev): asserts the exact dev-mode string AND `fetch` NOT called. Real.
- Test 3 (SEA): mocks `isSea => true`, primes `fetch` to resolve `{ok:false}`, and asserts
  `fetch` WAS called -- proving the early return did NOT fire and the network path was
  reached. Real; the `{ok:false}` short-circuits cleanly at line 40-43 so no spawn side
  effects leak. Non-tautological.

No log-only or weak assertions found. Coverage of the new redirect surface is meaningful.

---

## Focus 3 -- Regression risk from MODIFIED tests/update.test.ts -- PASS (no weakening)

`git diff main..HEAD -- tests/update.test.ts` shows the ONLY change is an added
`vi.mock('../src/cli/install.js', () => ({ isSea: () => true, isNpmGlobalInstall: () => false,
_setSeaOverride }))` block. The 4 pre-existing SEA tests (lines 70-190: up-to-date, newer-
available-downloads-spawns, missing-config, invalid-config) are otherwise byte-for-byte
unchanged.

Judgment: this mock does NOT over-mock or hollow out the 4 SEA tests.

- Those tests exercise update.ts's OWN download/spawn logic (fetch -> asset selection ->
  writeStream -> chmod -> config read -> `spawn(installer, ['install','--force',...])` ->
  `process.exit(0)`). They do not assert anything about install.js internals.
- The only install.js symbol they touch transitively is `isSea()`, used solely by the new
  early-return gate. Before Phase 4 there was no gate in `runUpdate()`, so the tests reached
  the download path unconditionally. After Phase 4 added the gate, `isSea()` evaluated in the
  vitest process (a plain node run, not a SEA binary) would return false and short-circuit all
  4 tests into the npm/dev branch -- they would assert `Updating to v99.9.9`/`spawn` and FAIL.
  The mock's `isSea => true` is the minimal shim restoring the original intent: keep these
  tests on the binary-download path.
- The mock does not stub fetch, spawn, fs, or any assertion target. Every meaningful assertion
  (fetch call count, asset URL, spawn args, exit code, config-fallback warnings) still runs
  against real update.ts code. A genuine regression in the download/spawn logic would still
  break these tests.

This is the correct, idiomatic fix -- functionally equivalent to a partial mock that only
overrides `isSea`, since the SEA tests never invoke `isNpmGlobalInstall` (the gate returns
early on `isSea()===true`). Using `_setSeaOverride(true)` instead would have been an
alternative, but the full module mock is no weaker here. No finding.

---

## Focus 4 -- No regression elsewhere -- PASS

- Full suite green: 1338 passed, 14 skipped, 0 failed (>= 1338 requirement met).
- Phases 1-3 artifacts unaffected: install.ts isSea export is additive; version.ts,
  install-npm.test.ts, package.json untouched in Phase 4.
- ASCII in newly-written/edited code: tests/update-npm.test.ts ASCII-clean; the update.ts
  early-return block and install.ts isSea/isNpmGlobalInstall additions ASCII-clean
  (verified the Phase-4 diffs introduce no non-ASCII bytes).

### LOW (informational, non-gating, pre-existing -- NOT introduced by Phase 4)

`src/cli/update.ts:67,114` and the 4 `it(...)` titles in `tests/update.test.ts` contain
non-ASCII em-dashes (U+2014). These predate this sprint (the Phase-4 diffs do not touch those
lines) and the pre-commit hook tolerated them (build + commits succeeded). Per the project
ASCII-only convention they should eventually become `--`, but this is out of Phase 4 scope and
does not gate. Worth a cleanup pass when update.ts is next touched (e.g. a future phase or the
Phase 7 regression task).

---

## Summary

Phase 4 (Tasks 7-8) is correct and complete. The npm-redirect early-return fires before any
network call; npm mode emits both the `npm update -g @apra-labs/apra-fleet` command and the
S14.4 `apra-fleet install` skill-refresh reminder; dev mode prints the rebuild message; SEA
mode is byte-for-byte unchanged and still reaches the binary-download path. The `isSea` export
is a pure visibility change with no behavioral impact. The 3 new tests assert real behavior
(exact strings + fetch-not-called for npm/dev, fetch-called for SEA). The full-module mock
added to the existing update.test.ts is the minimal shim needed to keep the 4 SEA tests on the
download path -- it does not hollow out their assertions or mask a regression. Build clean,
full suite 1338 green, dev-mode update verified live with no network call. The doer's
1338-passing claim is confirmed.

The one non-gating note (pre-existing em-dashes in update.ts/update.test.ts) is not introduced
by this phase and is deferred.

**Verdict: APPROVED.**
