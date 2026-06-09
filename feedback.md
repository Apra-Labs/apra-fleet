# apra-fleet npm Packaging -- Phase 5 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 03:10:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Phases 1-4 were APPROVED in prior reviews (db9936e, 25086a5, 22235b3, a2b4fde).
> This review covers Phase 5 (Task 9 / Task 10 / VERIFY -- progress.json ids 13,14,15)
> plus a regression check across Phases 1-4.

---

## Context recovery

Reviewed prior feedback.md history. Phase 3 was the only CHANGES NEEDED
(bfc2e47: claude MCP dropped the script path in npm mode; fixed in 88f3a66 and
re-approved in 22235b3 after confirming the pre-fix tests fail). Phases 1, 2, 4
approved clean with non-gating notes only. No carried-over blocking findings apply
to Phase 5.

Phase 5 committed diff inspected: `git diff bfdeef2~1..HEAD -- src/delivery-mode.ts
src/index.ts tests/delivery-mode.test.ts`. The diff is exactly those three files
(one new module, one --version handler change, one new test file) -- nothing else.

---

## Focus 1 -- delivery-mode.ts correctness  PASS

`src/delivery-mode.ts` is correct against PLAN Task 9:

- `getDeliveryMode()` precedence is `sea -> npm -> dev` with `isSea()` checked first,
  then `isNpmGlobalInstall()`, then the `dev` default. This matches the documented
  precedence and is consistent with the rest of the sprint (install.ts gates check
  `isSea()` first and `isNpmGlobalInstall()` returns false under SEA, so the ordering
  is also defensively correct).
- `getDeliveryInfo()` returns `binary = process.execPath` for `sea` and
  `process.argv[1]` for both `npm` and `dev`; `nodeVersion = process.version`; and
  `mode` is sourced from `getDeliveryMode()` (single source of truth, no drift).
- Imports `isSea` / `isNpmGlobalInstall` from `./cli/install.js`. Both are confirmed
  exported (install.ts:24, install.ts:40). The functions are referenced lazily inside
  the `getDeliveryMode()` body, not evaluated at module load, so there is no
  eager-eval-at-import hazard. No circular import: delivery-mode imports from
  cli/install, and cli/install does not import delivery-mode (delivery-mode is only
  consumed by index.ts). Build is clean (`tsc` no errors).

---

## Focus 2 -- index.ts --version output  PASS

The `--version` / `-v` handler (index.ts:10-16) prints `apra-fleet ${serverVersion}`,
then a `  Mode:` line, then a `  Binary:` line. The `(node ${nodeVersion})` suffix is
gated on `info.mode !== 'sea'`, so it appears for npm/dev and is omitted for sea --
exactly per PLAN.

Verified live (dev mode):

```
apra-fleet v0.2.2_7f0ced
  Mode:   dev (node v20.19.0)
  Binary: C:\akhil\git\apra-fleet\dist\index.js
```

Three lines, suffix present for dev, binary = process.argv[1]. This satisfies the
descope substitution recorded in requirements.md (getDeliveryMode + --version is the
stand-in for the nonexistent `status` command / `/health` endpoint; the diagnostic
need from design-doc S14.3 is met for the modes the codebase actually supports).

No other index.ts behaviour changed: the diff touches only the --version block (added
the `getDeliveryInfo` import and two console.log lines). The `--help` and all
downstream CLI dispatch paths are untouched. (Note: the em-dash on help line 28,
"PM depends on fleet -", predates this branch -- introduced in PR #212, commit c572e53
-- and is not in the Phase 5 diff. Out of scope, not flagged.)

---

## Focus 3 -- test honesty (delivery-mode.test.ts)  PASS with one MEDIUM note

The 7 tests assert REAL return values, not tautologies:

- getDeliveryMode() sea/npm/dev: each asserts the actual returned string
  (`toBe('sea')` / `'npm'` / `'dev'`) after setting the underlying mocks. Genuine.
- getDeliveryInfo() binary-path-per-mode: the npm and dev tests mutate
  `process.argv[1]` to a distinct sentinel path and assert `info.binary` equals that
  exact path (and restore argv[1] after). The sea test asserts `info.binary ===
  process.execPath`. This is real binary-path-per-mode coverage -- the strongest part
  of the suite, and it would catch a regression that swapped execPath/argv[1].
- nodeVersion asserted `=== process.version` in each info test.

All three modes AND the binary-path-per-mode behaviour are genuinely covered.

**MEDIUM (non-gating) -- dead/misleading `vi.mock` inside a test body.** The 7th test
("returns mode that matches getDeliveryMode() result", lines 117-130) calls
`vi.mock('../src/cli/install.js', ...)` inside the test body after a
`vi.resetModules()`. `vi.mock` is hoisted by vitest to the top of the module at
transform time; calling it mid-test does not register a factory at that line. What
actually drives the NPM assertion is the subsequent `vi.mocked(isSea2).mockReturnValue
(false)` / `vi.mocked(isNpmGlobalInstall2).mockReturnValue(true)` (lines 125-126). So
the test still asserts real values and passes for the right reason, but the inline
`vi.mock` is dead code that implies a mechanism not in effect. It is also largely
redundant with the dedicated sea/npm getDeliveryMode tests. Recommend deleting the
inline `vi.mock` (and ideally the whole consistency test, since mode==getMode() is
structurally guaranteed by getDeliveryInfo calling getDeliveryMode). Not gating: no
false confidence about the SUT, and coverage of the real surfaces is intact.

**LOW** -- `afterEach` is imported (line 1) but never used. Cosmetic.

---

## Focus 4 -- regression / hygiene  PASS

- Full suite green: `npm test` -> 84 files passed (1 skipped), **1345 passed, 14
  skipped, 0 failed**. Confirms the doer's 1345 claim exactly (1338 Phase-4 baseline
  + 7 new). Build clean.
- ASCII-only: byte scan of `src/delivery-mode.ts` and `tests/delivery-mode.test.ts`
  found zero non-ASCII characters.
- Phases 1-4 untouched: the Phase 5 commits modify only delivery-mode.ts, index.ts
  (--version block), and the new test file. install.ts / update.ts / version.ts /
  package.json carry no Phase 5 changes; their tests (install-npm, update-npm,
  update, version) remain green within the suite total.
- File hygiene: `git diff --name-only main..HEAD` lists only source, tests, sprint
  tracking, and files inherited from merged PRs #288/#291/#292 (auth-web, auth-socket,
  pre-commit hook, their tests) plus `.sprint/bead-ids.txt` from sprint setup. All
  justified. No stray temp/config/scratch artifacts in the tracked diff. (The
  uncommitted working-tree CLAUDE.md/AGENTS.md and untracked `.sprint/`,
  `analyze_transcripts.js`, `permissions.json`, etc. are NOT part of this branch's
  commits and are out of scope.)

---

## Summary

Phase 5 is correct and complete. `getDeliveryMode()`/`getDeliveryInfo()` implement the
documented precedence and binary-path semantics with no circular-import or eager-eval
issue; `--version` emits the version + Mode + Binary lines with the sea-suffix
exception exactly per PLAN. This is the agreed substitute for the descoped
status/health surface and meets requirements Scope item 6 within the codebase's actual
capabilities. The test file asserts genuine return values across all three modes and
the per-mode binary path. Full suite is 1345 green, ASCII clean, Phases 1-4 not
regressed.

Two non-gating findings to clean up opportunistically (no re-review required):
- MEDIUM: dead inline `vi.mock` in the 7th test (lines 117-130) -- misleading and
  redundant; delete it.
- LOW: unused `afterEach` import.

**APPROVED.** Phase 6 (CI npm-publish job) and Phase 7 (final regression) remain
pending per progress.json.
