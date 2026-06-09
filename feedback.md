# npm Packaging Phase 6 (CI npm-publish job) -- Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 03:30:00+00:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Phases 1-5 were APPROVED in prior reviews (db9936e, 25086a5, 22235b3, a2b4fde, eea3e2f).
> This review covers Phase 6 (Tasks 16, 17, VERIFY 18) plus a regression sweep of Phases 1-5.

---

## Focus 1 -- npm-publish job correctness vs design S13.2

PASS. The job at `ci.yml:307-401` matches the S13.2 spec faithfully:

- `needs: build-and-test` (line 308) -- depends ONLY on build-and-test, NOT on
  package/build-binary/sign-windows. Correct.
- `if: startsWith(github.ref, 'refs/tags/v')` (line 309) -- tag-gated. PASS.
- Job-level `permissions: { contents: read, id-token: write }` (lines 311-313). The top-level
  workflow `permissions:` (line 19-20) remains `contents: read` only -- it was NOT broadened.
  `id-token: write` is scoped to this job exactly as the plan required (PLAN Task 11: "set it
  only at job level to avoid broadening other jobs"). PASS.
- `environment: npm` (line 314) -- deployment-protection hook present. PASS.
- `runs-on: ubuntu-latest` (line 310). PASS.
- Setup Node `22.x` with `registry-url: https://registry.npmjs.org` (lines 319-323). PASS --
  registry-url is required so `NODE_AUTH_TOKEN` is wired into `.npmrc` for publish auth.
- **Version-lockstep guard** (lines 342-351): I read the shell line by line. After injecting the
  tag into both files, it re-reads `package.json` and `version.json` and runs
  `if [ "$TAG" != "$PKG_VER" ] || [ "$TAG" != "$VER_VER" ]; then echo "::error::..."; exit 1; fi`.
  This genuinely FAILS (non-zero exit) when the tag, package.json, or version.json disagree. It
  does NOT silently pass -- the `||` correctly fails on either mismatch, and `exit 1` aborts the
  job before publish. PASS. (Note: because the prior "Inject version from tag" step writes the tag
  into both files, in normal operation the guard always passes; its real value is catching a
  future edit that breaks the injection step. It is a belt-and-suspenders guard, which is its
  intended role per S13.4.)
- **Shebang check** (line 357): `head -1 dist/index.js | grep -q '^#!/usr/bin/env node'` -- fails
  the job if the shebang is missing. PASS.
- **Dry-run pack verification** (lines 359-366): greps for `dist/index.js`, `version.json`,
  `hooks/hooks-config.json`, and `skills/pm/ OR skills/fleet/`. PASS.
- **Clean-pack guard** (lines 368-383): rejects `*.exe`, `sea-prep.blob`, `sea-bundle.cjs` via
  `grep -qE`, and enforces a 10MB unpacked-size bound by parsing `npm pack --dry-run` output.
  This is a sensible addition beyond the bare S13.2 spec (the doer caught that a stale SEA build
  in dist/ would bloat the tarball -- the Phase 1 tarball was 30.3MB / 80MB unpacked BECAUSE dist/
  contained SEA artifacts; this guard forces a clean dist/ before publish). PASS.
- **Idempotency check** (lines 385-394): `npm view @apra-labs/apra-fleet@${TAG} version` sets
  `already_published`, and the publish step is gated on `already_published == 'false'`. PASS.
- **Publish** (lines 396-400): `npm publish --provenance --access public` with
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. PASS -- `--provenance` pairs with the
  `id-token: write` permission for Sigstore attestation; `--access public` is required for a
  scoped package.

YAML is well-formed (`yaml.safe_load` succeeds). `npm run build` (tsc) is clean.

---

## Focus 2 -- CRITICAL hard-constraint audit (no actual publish)

PASS on every count.

- **Tag-gated and inert on normal pushes/PRs**: The workflow `on:` triggers are push to `main`,
  tags `v*`, PRs to `main`, and `workflow_dispatch` (ci.yml:3-13). The npm-publish job adds
  `if: startsWith(github.ref, 'refs/tags/v')` on top, so even when the workflow runs on a normal
  push/PR, the npm-publish job is skipped. It only executes on a `v*` tag push. INERT confirmed.
- **No v* tag pushed for this sprint**: `git tag --points-at <branch commits>` returns nothing.
  All existing `v*` tags (v0.0.1 .. v0.2.1) predate this branch and point at main-line commits
  (e.g. v0.2.1 -> ce8ee62, v0.2.0 -> b35f5e0). No tag was created on `feat/npm-packaging`. PASS.
- **`npm publish` appears ONLY in this job**: Repo-wide grep for `npm publish` finds the
  executable invocation only at `ci.yml:398`. All other hits are documentation/plan/requirements
  prose (`docs/npm-packaging-plan.md`, `PLAN.md`, `.sprint/requirements.md`, `ROADMAP.md`,
  `llms-full.txt`) or the test's own assertion comment. No test, script, or sprint commit runs
  `npm publish`. `src/` has zero matches. PASS.
- **Existing 5 jobs UNCHANGED**: `git diff 43bd4e4~1..HEAD -- ci.yml` shows the diff is purely
  additive -- the npm-publish job appended after `release`, with no edits above line 306.
  Confirmed `release.needs == [package, build-binary, sign-windows]` is byte-identical and at the
  same line (246) before and after. build-and-test, package, build-binary, sign-windows all
  unchanged. PASS.

---

## Focus 3 -- Structural test honesty (ci-npm-publish.test.ts)

PASS with one NOTE (non-gating). All 14 assertions parse real content from `ci.yml`; none are
tautological. I verified the section-isolation regex
`npm-publish:[\s\S]*?(?=\n  [a-z-]+:|$)` captures the entire job (3901 chars, terminating exactly
at the trailing `NODE_AUTH_TOKEN` line) -- this works because npm-publish is the last job, so the
lazy match runs to end-of-string. Both `Clean-pack guard` and `Publish to npm` are inside the
captured section.

Spot-checks (would the test fail if the property were removed?):

- `needs`, `if`, `runs-on`, `environment`, `permissions.id-token: write`: each regex matches the
  literal config value -- removing or changing the value fails the assertion. REAL.
- `release` job does NOT list npm-publish in needs (line 69-77): extracts the `needs:` value and
  asserts it does not contain `npm-publish`. REAL.
- "no npm publish outside npm-publish job" (line 99-107): strips the npm-publish section and
  asserts the remainder has no `npm publish --provenance`. REAL.
- **Clean-pack guard / exe-sea assertion** (line 61-67): I tested empirically -- the
  `/exe.*sea|sea.*exe/` regex matches the guard's actual `grep -qE` pattern line, and if the
  Clean-pack guard step is deleted the assertion FAILS. Tied to real content, not a coincidental
  match. REAL.
- **Lockstep-guard assertion** (line 37-41): matches the step name `Version lockstep guard`. This
  confirms the step's presence but does not exercise the shell's fail-on-mismatch logic.

NOTE (LOW, non-gating): The five step assertions (lockstep, shebang, dry-run pack, idempotency)
verify step *names* only, not the step bodies. A future edit that guts a step body while keeping
its name would not be caught by the test. This is an inherent limit of a regex-based structural
test and is acceptable for this sprint -- I independently verified each step body is correct in
Focus 1. The plan (Task 12) explicitly scoped this as "a structural test, not a CI integration
test," so this matches intent.

---

## Focus 4 -- ASCII + regression

- **ASCII**: `ci.yml` and `tests/ci-npm-publish.test.ts` are both ASCII-clean (rg non-ASCII scan:
  no matches). The hook-enforced ci.yml is compliant. PASS.
- **Full suite green**: `npm test` = 85 test files passed (1 skipped), **1359 passed**, 14
  skipped, 0 failed. Confirms the doer's 1359 claim exactly. PASS.
- **Phases 1-5 untouched in Phase 6**: the only files in the Phase 6 commits (43bd4e4, 1915214)
  are `ci.yml` and `tests/ci-npm-publish.test.ts`. No regression to package.json, version.ts,
  install.ts, update.ts, or delivery-mode.ts. The full suite green across all prior-phase test
  files (version.test.ts, install-npm.test.ts, update-npm.test.ts, delivery-mode.test.ts)
  confirms no regression. PASS.
- **File hygiene**: `git diff --name-only main..feat/npm-packaging` lists only source, tests, and
  active sprint tracking (PLAN.md, progress.json, .sprint/, docs/npm-packaging-plan.md,
  feedback.md) plus the auth/hook files inherited from the rebased base. The uncommitted
  CLAUDE.md/AGENTS.md and untracked scratch files (analyze_transcripts.js, results.json,
  permissions.json, tpl-plan.md) are NOT part of this sprint's commits and are correctly left
  unstaged -- not flagged per review instructions.

---

## Summary

Phase 6 is APPROVED. The `npm-publish` job is authored exactly to design S13.2: tag-gated,
job-scoped `id-token: write` (top-level permissions NOT broadened), Node 22.x with registry-url,
a real version-lockstep guard that fails on divergence, shebang + dry-run pack + clean-pack +
idempotency guards, and `npm publish --provenance --access public` with `NPM_TOKEN`. The hard
constraint holds absolutely: the job is inert on every trigger except a `v*` tag push, no `v*`
tag was created on this branch, and `npm publish` is invoked nowhere outside this single gated
step. The 5 pre-existing jobs are byte-for-byte unchanged, including `release.needs`. The 14
structural tests genuinely parse ci.yml content (the clean-pack and lockstep-name assertions are
real); full suite is 1359 green. ASCII clean.

One LOW non-gating NOTE: the step-name assertions do not exercise step bodies -- acceptable for a
structural test and offset by independent body verification in this review.

Informational (not a Phase 6 blocker): CI has not run on the `feat/npm-packaging` branch because
the workflow does not trigger on non-main branch pushes and no PR has been opened yet. The
requirements' "PR raised, CI green, NOT merged" gate (req line 80) is a Phase 7 / final-acceptance
step, not a Phase 6 deliverable. Tasks 19-20 (Phase 7) remain pending; the PR + CI-green check
applies there.
