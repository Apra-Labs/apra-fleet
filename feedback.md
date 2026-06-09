# npm Packaging -- FINAL RE-REVIEW (Phases 1-7)

**Reviewer:** fleet-rev
**Date:** 2026-06-09 04:15:00+00:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior FINAL cumulative review (087ab3e) was CHANGES NEEDED: 1 HIGH (the d86bc67
> .git-detection branch shipped with no regression test) + 1 MEDIUM (package.json
> version.json skew 0.2.1 vs 0.2.2). The doer's fix is commit 61260e9 (annotated in
> 891b37d). This re-review confirms both are closed and re-validates the full branch.
> Phases 1-6 were APPROVED in prior reviews (db9936e, 25086a5, 22235b3, a2b4fde,
> eea3e2f, aa421b2); the HEADLINE d86bc67 heuristic was found correct and confirmed
> working end-to-end in 087ab3e -- only its test coverage was the blocker. That gap is
> now closed.

I re-ran build + full suite myself: clean `npm run build` (tsc, no errors); `npm test`
= **85 files, 1362 passed, 14 skipped, 0 failed**. Targeted file `npx vitest run
tests/install-npm.test.ts` = **13 passed** (was 11). All checks below independently
verified.

---

## HIGH-1 (was gating) -- .git detection branch now has real regression guards: CLOSED

The fix added 3 new tests to `tests/install-npm.test.ts` (plus repurposed the dead
symlink test into a 4th .git-present case). I did not merely confirm they are green --
I ran two source mutations of `isNpmGlobalInstall()` (install.ts:54) and confirmed each
new test FAILS when the .git logic is broken, proving the guards are not tautological:

- **Mutation 1 -- invert the check (`return !hasGit` -> `return hasGit`):** 7 tests
  failed, including all three new .git tests:
  - "node_modules + .git ABSENT -> true" FAILED (it correctly demands true; inverted
    code returns false). [confirms case (a)]
  - "node_modules + .git present (npm-linked git checkout) -> false" FAILED.
  - "node_modules + .git exists at project root -> false" (the labelled REGRESSION
    TEST) FAILED. [confirms case (b)]
  - 4 downstream MCP/binary-copy npm-mode tests also flipped, showing the branch feeds
    real install behaviour.
- **Mutation 2 -- remove the check (force `return true`, always-npm):** exactly the two
  .git-PRESENT dev tests FAILED (they require false). This is the decisive proof that
  case (b) is **pinned against a future revert**: any classifier that no longer
  consults `.git` and assumes npm whenever argv is under node_modules breaks these
  tests. PASS.

Per-requirement confirmation:

- **(a) node_modules + .git ABSENT -> true:** PASS. install-npm.test.ts:54-65. argv =
  `.../node_modules/@apra-labs/apra-fleet/dist/index.js`; default `makeFsMock` returns
  existsSync=true only for version.json/hooks-config.json, so `existsSync('.git')` is
  false -> `!false = true`. Genuinely reaches the .git branch (past the node_modules
  early-return). Fails under Mutation 1.
- **(b) node_modules + .git PRESENT -> false (THE regression d86bc67 fixed):** PASS.
  Two tests cover it -- install-npm.test.ts:127-145 (npm-linked `.../node_modules/.bin/`
  path) and :147-167 (the explicitly-labelled REGRESSION TEST,
  `.../node_modules/@apra-labs/apra-fleet/dist/index.js`). Both override existsSync so
  version.json AND .git are present; both require `false`. I confirmed both reach the
  .git check (argv contains node_modules so they pass the early guard; version.json
  present so findProjectRoot() succeeds rather than throwing) and both FAIL under
  Mutation 1 AND Mutation 2. This is the exact real-world scenario that broke and is now
  pinned.
- **(c) findProjectRoot() throws -> true (catch branch):** PASS.
  install-npm.test.ts:111-125. argv under node_modules (passes early guard) +
  existsSync forced to return false for everything -> findProjectRoot() exhausts 5 hops
  and throws -> catch returns true. Asserts the catch arm specifically.

The "dev mode" test (install-npm.test.ts:67-77) is now honestly named/commented as the
node_modules EARLY-GUARD case (argv has no node_modules), and MEDIUM-2's concern is
satisfied by the two separate node_modules+.git tests that independently exercise the
.git branch. The "all new behaviour is unit tested" hard constraint is now met.

---

## Dead realpathSync mock removed: CONFIRMED

PASS. `grep realpathSync tests/install-npm.test.ts` finds only an explanatory comment
(lines 32-33) -- no `vi.mocked(fs.realpathSync)` call anywhere. The obsolete symlink
test that mocked realpathSync (which the .git-based code never calls) was replaced with
the .git-present regression test. No test mocks a function `isNpmGlobalInstall()` no
longer calls.

---

## isNpmGlobalInstall() logic UNCHANGED vs 61260e9's parent: CONFIRMED

PASS. `git diff d86bc67..HEAD -- src/cli/install.ts` is EMPTY, and `git diff
61260e9~1..61260e9 -- src/cli/install.ts` is EMPTY. The fix commit touched only
feedback.md, package.json, and tests/install-npm.test.ts (`git show --stat 61260e9`).
The doer did not silently alter behaviour. Current body (install.ts:44-58) is exactly
the approved d86bc67 heuristic: `isSea()->false`; `!argv.includes('node_modules')->
false`; else `return !existsSync(join(findProjectRoot(), '.git'))`; catch->true. The
doc-comment (install.ts:35-43) accurately describes the .git-existence mechanism. I
restored install.ts byte-clean after the mutation tests (`git diff --stat` empty).

---

## MEDIUM-1 -- version skew: CLOSED, and nothing else in package.json changed

PASS. package.json `version` is now `0.2.2`, matching version.json (`{ "version":
"0.2.2" }`). `git show 61260e9 -- package.json` shows the diff is a single line:
`-"version": "0.2.1"` / `+"version": "0.2.2"`. No other field touched by the fix. (The
larger package.json delta vs `main` -- name scoping, bin, engines, files, publishConfig,
prepublishOnly -- is the Phase-1 packaging work approved in earlier reviews, not this
fix.)

---

## No regression / scope / hygiene: CONFIRMED

- **Full suite:** 1362 passed, 0 failed, 14 skipped (>= the 1362 target; up from the
  1360 in 087ab3e, consistent with +2 net new install-npm tests). PASS.
- **Phases 1-6 untouched by this fix:** the only non-test, non-feedback change is the
  one-line package.json version bump. install.ts, ci.yml, version resolution, update
  redirect, delivery-mode -- all untouched by 61260e9. PASS.
- **ASCII-only:** the files changed by this fix (tests/install-npm.test.ts,
  package.json, version.json) have ZERO non-ASCII bytes. install.ts contains
  pre-existing em-dash/glyph bytes, but `git diff main..HEAD -- src/cli/install.ts`
  adds zero non-ASCII lines -- they predate this sprint and are out of scope for this
  re-review. PASS for everything this branch introduced.
- **File hygiene:** the working tree's uncommitted CLAUDE.md/AGENTS.md and untracked
  scratch files (.sprint/, analyze_transcripts.js, permissions.json, results.json,
  docs/*-plan.md, tpl-plan.md) are NOT part of this sprint and were explicitly excluded
  from review scope; they are not staged. Only feedback.md is staged by this review.

---

## Summary

The single HIGH blocker from the prior FINAL review is genuinely closed. The doer added
real regression coverage for the .git-based npm-detection branch: I proved by source
mutation (invert and remove the .git check) that each new test fails when the logic is
broken -- in particular the "node_modules + .git PRESENT -> dev (false)" case is pinned
so a future revert to a non-.git classifier breaks the suite, which was the entire point
of the HIGH. The dead realpathSync mock is gone, `isNpmGlobalInstall()` logic is
byte-identical to the approved d86bc67 fix (only comments/tests/version changed), and
the MEDIUM version skew is resolved with a clean one-line package.json bump that touches
nothing else. Build is clean and the full suite is 1362 passing / 0 failing. SEA + npm
coexistence, the inert tag-gated CI publish job, no `npm publish` outside CI, no sprint
`v*` tag, and ASCII-only (for branch-introduced files) all continue to hold from the
prior cumulative review.

Two carry-forward, non-gating items for human sign-off at PR time (unchanged from
087ab3e, NOT blockers): the `status` acceptance line is delivered via `--version` Mode/
Binary output rather than a `status` command (LOW-2; needs explicit human acceptance),
and PR-vs-main CI-green is a human gate at merge time.

**Verdict: APPROVED (final).**
