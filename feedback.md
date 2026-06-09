# apra-fleet npm Packaging -- Phase 2 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 02:05:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior entry (db9936e) is the Phase 1 code review (APPROVED -- package.json + pack
> validation). This is the Phase 2 review covering Task 3 (version.ts ESM fix), Task 4
> (version.test.ts), and the Phase 2 VERIFY checkpoint.

---

## Scope and context recovery

Phase 2 commits: `7e7813a` (src/version.ts ESM fix), `a008578` (tests/version.test.ts),
plus progress.json bookkeeping (`5d14606`, `48521be`, `7284406`). The only sprint source
changes in src/tests this phase are `src/version.ts` and `tests/version.test.ts` --
confirmed via `git log ee0af4f^..HEAD -- src/version.ts tests/version.test.ts`. The
`auth-*.ts/.test.ts` files in `main..HEAD` are ancestor auth PRs (#291/#292/#288), already
ruled out of scope in the Phase 1 review; no Phase 2 commit touches them.

I independently re-ran everything below; all doer claims hold.

- `npm run build` -- clean (tsc, no errors).
- `npm test` -- **81 files passed (1 skipped), 1324 passed, 14 skipped, 0 failed.**
  Independently confirms the doer's 1324-passing claim (1316 Phase-1 baseline + 8 new).
- `node dist/index.js --version` -> **`apra-fleet v0.2.2_728440`** -- real semver + dev
  git-hash, NOT `v0.0.0-unknown`. Done-criterion met.
- `npm run build:sea` -> **succeeds** (`Building SEA bundle -- version: v0.2.2_728440`,
  bundle written to dist/sea-bundle.cjs). No SEA regression.
- `tests/update.test.ts` (4 tests) -- **green**, the regression the createRequire trick
  protects is intact.

No regression to Phase 1: package.json unchanged this phase (verified -- not in the diff).

---

## Focus 1: resolveVersion() correctness -- PASS

Read `src/version.ts` line by line against PLAN Task 3 and design S8.4.

- **BUILD_VERSION returns FIRST (SEA) -- PASS.** Lines 9-13: the `typeof BUILD_VERSION
  !== 'undefined'` check is the first thing in the function, before any path resolution or
  file I/O. SEA's esbuild `define` injection still wins. Verified empirically: the SEA
  bundle reports its BUILD_VERSION value.
- **ESM detection via `typeof __dirname === 'undefined'` -- PASS.** Line 25. This is the
  correct, robust discriminator: under tsc ESM output `__dirname` is genuinely undefined
  (referencing it bare would normally throw, but `typeof` is safe on an undeclared name),
  and under CJS/SEA bundle output `__dirname` is a real binding. The design doc explicitly
  endorsed exactly this detection mechanism.
- **Package-root resolution from import.meta.url -- PASS.** Lines 27-30: ESM branch builds
  `dir = dirname(fileURLToPath(import.meta.url))`, then `root = join(dir, '..')` (line 41).
  `import.meta.url` resolves to `dist/version.js`; one level up is the package root
  containing `version.json`. Correct for both the dev tree and an npm-installed package
  (where dist/ sits directly under the package dir). Empirically the npm-mode read returns
  the real semver.
- **CJS path intact -- PASS.** Lines 31-35: when `__dirname` is defined, `req = require`
  and `dir = __dirname` -- the exact pre-existing behavior. The old code's `join(__dirname,
  '..')` is preserved via the shared `root` computation. SEA/CJS path is byte-for-byte
  equivalent in behavior.
- **Function stays SYNCHRONOUS -- PASS.** No `await`/`async`. This matters: the design doc
  S8.4 sketch used top-level `await import(...)`, which would have forced an async function
  and broken the eager `export const serverVersion = resolveVersion()` at module scope (line
  68). The doer correctly rejected the doc's literal sketch in favor of synchronous
  `createRequire` + `req('node:fs')`. Good call; this is the right deviation from the doc.
- **Git-hash suffix is dev-only -- PASS.** Lines 46-60 only append a suffix when
  `.git/HEAD` exists. npm tarballs ship no `.git/`, so npm users get a bare semver; dev
  trees get the `_<6hex>` suffix. The HEAD/ref resolution handles both detached-HEAD and
  symbolic-ref cases, wrapped in its own try/catch so a malformed `.git` never poisons the
  version. Matches the done-criterion.

### The createRequire(import.meta.url) lazy-load -- SOUND, well-contained (PASS, with a NOTE)

The deliberate choice to load `fs`/`path`/`url` via `createRequire(import.meta.url)` rather
than top-level `import { readFileSync } from 'node:fs'` is, in my judgment, **sound and
appropriately contained**, not a maintainability risk. Reasoning:

- The motivation is real and verified. `tests/update.test.ts` does `vi.mock('node:fs')` at
  module scope *and* imports `serverVersion`. A static ESM `import` of `node:fs` in
  version.ts would be intercepted by that hoisted mock at the moment version.ts is loaded,
  so the eager `serverVersion = resolveVersion()` would read a mocked fs, fail, and resolve
  to `v0.0.0-unknown` -- breaking 3 update.test.ts assertions that derive from
  `serverVersion`. The lazy `createRequire` require resolves the *real* native module
  (`node:module` itself is not mocked), bypassing the fs mock. I confirmed update.test.ts is
  green and that it both mocks node:fs and consumes serverVersion.
- It is well-contained: the single `import { createRequire }` is the only top-level import;
  the require-shimming lives entirely inside `resolveVersion()`; the rationale is documented
  in an in-code comment (lines 16-21). A future maintainer is warned.
- **NOTE (LOW):** this couples a production module's import strategy to a test's mocking
  behavior, which is a faint code smell -- the "right" long-term fix is for update.test.ts
  to scope its `vi.mock('node:fs')` more narrowly rather than for version.ts to defend
  against it. But given (a) it is documented, (b) the alternative (refactoring an unrelated,
  already-passing test in a different phase) is out of Phase 2 scope, and (c) the production
  behavior is correct in all three real modes (SEA/npm/dev), this does not gate. Leave as
  is; do not expand the pattern to other modules without the same justification.

ASCII clean (the old non-ASCII em-dash in the comment on line ~12 was replaced with `--`).

---

## Focus 2: Test coverage and honesty -- PASS with one MEDIUM finding (non-gating)

PLAN Task 4 requires four covered behaviors. Status:

1. **ESM real-semver path -- PASS (real).** Suite 1 imports the real module; in vitest's
   ESM environment `__dirname` is undefined so the ESM branch genuinely fires, reads the
   real `version.json`, and the assertions (`/^v/`, `/^v\d+\.\d+\.\d+/`, not-fallback)
   exercise the actual code path. Legitimate.
2. **BUILD_VERSION / SEA path -- PASS (real).** Suite 3 uses `vi.stubGlobal('BUILD_VERSION',
   ...)` + `vi.resetModules()` + dynamic re-import and asserts the stubbed value is returned
   verbatim with no semver parsing -- proving the early return is taken before file I/O.
   This is a genuine exercise of the SEA path. Good.
3. **Git-hash suffix -- PASS (real).** Suite 2 asserts `/^v\d+\.\d+\.\d+_[0-9a-f]{6}$/`
   against the real import (project root has `.git/`). Genuinely exercises the suffix branch.
4. **Fallback v0.0.0-unknown -- COVERED ONLY STRUCTURALLY -- MEDIUM finding (non-gating).**
   Suite 4 does NOT execute the fallback. It greps `src/version.ts` for the literal
   `'v0.0.0-unknown'` and asserts it sits after a `} catch {`, plus a negative assertion
   that the real serverVersion is not the fallback. A source-greps-itself test runs zero
   production code and would keep passing even if the catch logic were broken (e.g. if the
   catch re-threw, or returned the wrong constant via a variable) -- it only proves a string
   is textually present. That is a real coverage gap and a smell.

   **Is the doer's "genuinely untestable" claim correct? Partly -- but it is testable with a
   small refactor the doer did not pursue.** The doer's stated blocker (vi.mock cannot
   intercept the native built-in resolved by createRequire before interceptors run) is
   accurate *for the current module shape*. But the fallback is reachable for real without
   fighting the module loader, via either:
   - **(preferred) Export `resolveVersion` and give it a seam.** e.g.
     `export function resolveVersion(rootDir = defaultRoot, req = createRequire(import.meta.url))`,
     or accept an injected reader. A test then calls `resolveVersion('/nonexistent')` (or
     passes a require whose `readFileSync` throws) and asserts the real return value
     `'v0.0.0-unknown'`. This executes the catch. Today `resolveVersion` is private and the
     path is fixed, which is *why* it is awkward to test -- a self-imposed constraint, not a
     platform limit.
   - **(alternative) Fixture dir / dynamic import of a copied module** pointed at a temp dir
     with no `version.json`, exercising the JSON.parse-throws -> catch -> constant path.

   **Verdict on this finding: MEDIUM, non-gating for Phase 2, but should be addressed.** I
   am not gating because: the fallback is a pure defensive catch-all returning a literal
   constant (no branching, no computation), the three substantive paths (SEA / npm-read /
   git-hash) are all genuinely exercised, the production `--version` output is empirically
   correct, and exporting `resolveVersion` is a refactor that touches the production surface
   and is cleaner to fold into a later phase than to block a one-function fix on. **Action
   for the doer:** before the Phase 7 cumulative review, replace the source-grep test with a
   real execution of the fallback via an exported `resolveVersion` seam (preferred approach
   above). If you disagree that it is feasible, respond with the specific blocker; "the
   built-in can't be mocked" is not sufficient because the seam avoids mocking entirely.

   The doer was **honest** about this -- the test file's header comment and progress.json
   both explicitly flag the fallback as "STRUCTURAL TEST ONLY" and explain why. Honesty is
   not in question; the engineering choice is what I am pushing on.

---

## Focus 3: No regression -- PASS

- `tests/update.test.ts` -- green (4/4). The createRequire trick does its job; serverVersion
  resolves to the real value even under update.test.ts's `vi.mock('node:fs')`.
- `npm run build:sea` -- succeeds; SEA bundle version injected via BUILD_VERSION unchanged.
- Full suite 1324 passed / 0 failed -- no pre-existing test weakened; the 8 new tests are
  purely additive (new file).
- Phase 1 (package.json) untouched this phase -- no regression.

### Test-fragility NOTE (LOW, non-gating)

Suite 2's git-hash assertion `/^v\d+\.\d+\.\d+_[0-9a-f]{6}$/` *requires* a hash suffix to
be present. It passes here and in the doer's VERIFY because `.git` is a real directory. But
in a git **worktree** (where `.git` is a file pointing elsewhere) or a checkout whose
current ref is packed (`.git/refs/...` absent, only `packed-refs`), the code's simple ref
resolver yields no suffix and this exact-match test would FAIL even though production
behavior (bare semver) is correct and acceptable. Consider loosening to
`/^v\d+\.\d+\.\d+(_[0-9a-f]{6})?$/` and asserting the suffix only when `.git/HEAD` resolves,
or gating the strict assertion on detected git layout. Not gating Phase 2 -- flagging so CI
on alternative checkout topologies does not surprise a later phase.

### File hygiene

`git diff --name-only main..HEAD` for this phase's commits touches only `src/version.ts`,
`tests/version.test.ts`, `progress.json`, and `feedback.md` -- all justified. The untracked
working-tree files (`.sprint/`, `analyze_transcripts.js`, `permissions.json`, `results.json`,
`tpl-plan.md`, docs plans) and the uncommitted CLAUDE.md/AGENTS.md are NOT part of any Phase
2 commit and per instructions are out of scope -- not flagged, and explicitly NOT staged.

---

## Summary

**APPROVED.** Phase 2 meets its done-criteria: `node dist/index.js --version` prints real
semver (`v0.2.2_728440`), the full suite is green at 1324 passed / 0 failed (independently
reproduced), the SEA build is unregressed, and update.test.ts -- the test the createRequire
design protects -- is green. The version.ts refactor is correct across all three delivery
modes; the synchronous createRequire approach is a sound, well-documented, well-contained
deviation from the design doc's async sketch.

Two non-gating items to carry forward, both already disclosed honestly by the doer:

- **MEDIUM (address before Phase 7 cumulative review):** the fallback `v0.0.0-unknown` path
  is tested by source-grepping, not execution. It IS reachable for real by exporting
  `resolveVersion` with a root-dir/require seam and asserting the catch return. Replace the
  structural test, or respond with a concrete blocker.
- **LOW:** Suite 2's git-hash test exact-matches a mandatory suffix; loosen it to tolerate
  bare-semver checkouts (worktrees / packed refs) so it does not become a flaky gate later.

- **LOW (note, no action required):** the lazy-require coupling to update.test.ts's fs mock
  is a faint smell but acceptable as documented; do not propagate the pattern.

Nothing here blocks Phase 2. Proceed to Phase 3 (install.ts npm detection).
