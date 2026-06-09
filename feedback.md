# apra-fleet npm Packaging -- Phase 1 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 01:34:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior feedback.md entry (f02d582) is the PLAN review for this same sprint (APPROVED);
> older entries belong to unrelated sprints. This is the first code review of Phase 1.

---

## Scope of this review

Phase 1 only: Task 1 (package.json for npm), Task 2 (npm pack + global-install smoke
test), Task 3 (Phase 1 VERIFY). The sole source change in the sprint commits is
`package.json` (commit `ee0af4f`); Tasks 2 and 3 are validation-only (commits `d077ba4`,
`387e493` touch only `progress.json`).

Note on the diff: `git diff main..feat/npm-packaging` also lists `src/services/auth-*.ts`,
`tests/auth-*.test.ts`, and `.github/hooks/pre-commit`. These come from auth PRs #291/#292/#288
that are ancestors on this branch but not yet merged to `main`'s HEAD (`06ed82e`). They are NOT
this sprint's work -- the npm sprint commits (`ee0af4f` onward) touch only `package.json` and
tracking files. Confirmed via `git log ee0af4f^..HEAD -- src/ tests/ .github/` (no sprint commit
touches them). Out of scope, not flagged.

Independently re-ran build, full test suite, and `npm pack --dry-run`. All doer claims hold.

---

## Focus 1: package.json correctness vs design S3 / Task 1 -- PASS

Verified every field against design S3 and PLAN Task 1, line by line in the committed file:

- `"name": "@apra-labs/apra-fleet"` -- PASS (scoped).
- `"bin": { "apra-fleet": "dist/index.js" }` -- PASS.
- `"engines": { "node": ">=22.0.0" }` -- PASS.
- `"publishConfig": { "access": "public" }` -- PASS (required for scoped public publish).
- `"prepublishOnly": "npm run build"` -- PASS (added alongside existing `prepare` script).
- `repository`, `description`, `author`, `homepage`, `bugs` -- PASS (repository/homepage/bugs
  pre-existed and were preserved; description was tightened to list providers).

**files whitelist -- PASS.** Uses the TARGETED form, NOT a bare `scripts/` glob:
```
"dist/", "hooks/", "scripts/fleet-statusline.sh",
"scripts/agy-settings-merge.js", "scripts/agy-transcript-reader.js",
"skills/", "agents/", "version.json"
```
I confirmed `npm pack --dry-run` includes the 3 runtime scripts and EXCLUDES all six build
`.mjs` files (`build-sea.mjs`, `gen-sea-config.mjs`, `package-sea.mjs`, `gen-ico.mjs`,
`gen-llms-full.mjs`, `install-hooks.mjs`) and `scripts/smoke-secure-input.ts`. No `src/`,
`tsconfig.json`, or `node_modules/` in the pack list. This is the better of the two options the
design doc left open (S6.3) and matches PLAN Task 1 exactly.

**Pre-existing fields preserved -- PASS (no dropped field).** Diffed `git show main:package.json`
against HEAD: `keywords` (13 entries), `license` (Apache-2.0), all 6 `dependencies`, all 7
`devDependencies`, `type`, `main`, and every existing `scripts` entry (`build`, `build:sea*`,
`build:binary`, `start`, `dev`, `test`, `test:watch`, `smoke`, `integration`, `prepare`) are
all intact. Only additions, no removals.

**NOTE (non-blocking): `agents/` in the whitelist points to a non-existent directory.** There
is no `agents/` directory at the repo root (confirmed). `buildDevManifest()`
(`src/cli/install.ts:86-99`) reads `hooks/`, `scripts/`, `skills/pm`, `skills/fleet`, and
`version.json` -- it never reads `agents/`. npm silently ignores non-existent `files` entries,
so this is harmless dead weight inherited verbatim from the design doc / PLAN. It does mean the
doer's progress note claiming `agents/` "ARE included" in the pack output is inaccurate (no agent
files were packed -- there are none). No action required for Phase 1; consider dropping the
`agents/` entry in a later cleanup so the whitelist reflects reality.

---

## Focus 2: Riskiest-assumption validation (Task 2 / VERIFY) -- PASS

Re-ran the validation chain myself rather than trusting the notes:

- **`npm run build`** -- PASS (`tsc` clean, no errors).
- **Shebang** -- PASS. `head -1 dist/index.js` is exactly `#!/usr/bin/env node`. Source
  `src/index.ts:1` carries it and `tsc` preserves it, as the design predicted. No injection
  script needed.
- **`npm pack --dry-run` file list** -- PASS. dist/index.js, version.json (23B),
  hooks/hooks-config.json, full skills/pm + skills/fleet trees, and the 3 runtime scripts are
  present; build scripts, src/, tsconfig, node_modules excluded.
- **Full test suite** -- PASS, INDEPENDENTLY CONFIRMED. `npm test` -> **80 files passed,
  1316 tests passed, 14 skipped** (58s). This matches the doer's reported 1316 exactly. Zero
  regressions vs the pre-sprint baseline (only `package.json` metadata changed; no source/test
  files were touched by the sprint).

The riskiest assumption from requirements -- that the dev-mode asset path + ESM dist entry work
for npm without architectural change -- is empirically validated for the packaging layer. (The
`--version` showing `v0.0.0-unknown` is expected and explicitly deferred to Phase 2 Task 3.)

**NOTE (non-blocking, test-fidelity): the 30.3 MB / 613-file tarball the doer validated is NOT
representative of a clean publish.** Because `files` uses `dist/` (whole directory), a dirty
local `dist/` from a prior `npm run build:binary` gets swept in. My pack dry-run shows the bulk
is `dist/apra-fleet-installer-win-x64.exe` (73.7 MB unpacked), `dist/sea-prep.blob` (2.6 MB),
and `dist/sea-bundle.cjs` (2.2 MB) -- all gitignored SEA build leftovers. On a clean CI checkout
(`npm ci` + `npm run build`, which runs `tsc` only) these do not exist, so the PUBLISHED package
would be ~1.5 MB and clean. Two implications to carry forward, neither blocking Phase 1:
  1. The doer's global-install smoke test installed ~73 MB of stale SEA artifacts; the smoke
     test still proved `--help`/`--version`/shebang work, so its conclusion stands.
  2. `npm publish` does not clean `dist/` first. The Phase 6 CI `npm-publish` job (already
     specified to run on a fresh `npm ci` checkout) mitigates this. Recommend the human never
     run a manual `npm publish` from a tree that has had `build:binary` run in it. Worth a one-
     line note when Phase 6 lands; not a Phase 1 defect.

---

## Focus 3: Hard constraints -- PASS

- **No live `npm publish`.** The doer's recorded commands (progress.json tasks 2-3) are only
  `npm pack`, `npm pack --dry-run`, `npm i -g ./*.tgz`, and `npm uninstall -g` -- all permitted.
  No `npm publish` anywhere. The `npm-publish` CI job does not yet exist (Phase 6, not started).
  Constraint satisfied.
- **ASCII-only in committed files.** `git show ee0af4f:package.json | grep -cP '[^\x00-\x7F]'`
  returns 0. PASS.
- **Feature branch.** Work is on `feat/npm-packaging`; nothing pushed to `main`. PASS.

---

## CI status

No CI run exists for the branch HEAD yet (the sprint commits are local; `gh run list` returns
empty). CI-green is a final PR-stage acceptance gate (Phase 7), not a Phase 1 gate, and the
package.json change carries no workflow risk. Build + full test suite pass locally. Not blocking
Phase 1; CI must be confirmed green before the eventual PR merge.

---

## Summary

Phase 1 is **APPROVED**. The package.json changes are correct and complete against design S3 and
PLAN Task 1: scoped name, bin, targeted (non-glob) files whitelist excluding build `.mjs`,
engines>=22, publishConfig public, prepublishOnly, repository/description/author -- with every
pre-existing field preserved (no dropped field). The riskiest assumption is empirically
validated: shebang survives `tsc`, pack file list is correct, and the full suite passes at
1316 tests with zero regressions (independently re-run). Hard constraints (no live publish,
ASCII-only, feature branch) all hold.

Two non-blocking NOTEs to carry forward, neither gating Phase 1:
1. The `agents/` whitelist entry references a directory that does not exist and is never read
   at runtime -- harmless, candidate for cleanup.
2. The locally-validated 30.3 MB tarball reflects a dirty `dist/` (stale SEA artifacts); a clean
   CI publish would be ~1.5 MB. The Phase 6 `npm-publish` job (fresh checkout) is the correct
   guard; flag the manual-publish-from-dirty-tree risk when Phase 6 lands.

Proceed to Phase 2 (version.ts ESM fallback).
