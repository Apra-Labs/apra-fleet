# feat/npm-packaging -- Docs Accuracy Review (docs/npm-packaging.md)

**Reviewer:** Bot (docs-accuracy)
**Date:** 2026-06-09 14:30:00-04:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> This pass reviews ONLY the as-built doc docs/npm-packaging.md (commit 5f5bac4) for
> truthfulness against shipped code. Prior code reviews of the sprint are unchanged.

---

## Scope / File Hygiene

PASS. `git diff --stat origin/main...HEAD` spans the whole sprint, but the docs-harvest
work is isolated to two commits:
- `5f5bac4` -- adds ONLY `docs/npm-packaging.md` (+304).
- `2cae250` -- adds ONLY `progress.json` (+6, completion record).

No stray files in the harvest commits. (Untracked CLAUDE.md / AGENTS.md / .sprint/ /
scratch files in the working tree are pre-existing and out of scope -- not staged.)

`npm test` not re-run (docs-only change, per instructions).

---

## ASCII Check

PASS. Scanned all 304 lines -- 0 non-ASCII codepoints. Dashes are `--`, no smart quotes,
no arrows. Hook-clean.

---

## Section-by-Section Verification Against Source

**S1 Two Delivery Modes** -- PASS. sea/npm/dev table and execPath mapping match
`delivery-mode.ts` (binary = process.execPath for sea, process.argv[1] for npm+dev).
Coexistence rationale is accurate (distinct install locations, no overwrite).

**S2.1 isSea()** -- PASS. `require('node:sea').isSea()`, false on catch, `_setSeaOverride`
test seam, now exported -- all match `src/cli/install.ts:24-32`.

**S2.2 isNpmGlobalInstall()** -- PASS on the three-part predicate (isSea false, argv[1]
contains `node_modules`, projectRoot has no `.git`) and on the catch-returns-true branch
(`install.ts:44-59`).

  The "why .git, not path comparison" narrative (lines 56-69) is substantively ACCURATE.
  I confirmed against the pre-fix code in commit `d86bc67`: the old impl compared
  `realpathSync(argv[1])` to `realpathSync(findProjectRoot()/dist/index.js)`. For a real
  npm global install, findProjectRoot() anchors on the package's own version.json and
  argv[1] is that same package's dist/index.js, so the two sides resolve to the same path
  and the `!==` yields false -> npm misclassified as dev. The doc's diagnosis matches.

**S2.3 getDeliveryMode / getDeliveryInfo** -- PASS. Signatures, sea->npm->dev order, and
the binary/nodeVersion fields match `delivery-mode.ts:11-27`.

**S3.1 Version priority chain** -- PASS. BUILD_VERSION (return immediately, no I/O) ->
ESM (`typeof __dirname === 'undefined'`) -> CJS -> `v0.0.0-unknown` matches
`version.ts:69-102`.

**S3.2 resolveVersionFromRoot** -- PASS. Reads version.json from rootDir, appends
`_<6-hex>` git suffix when `.git/HEAD` exists, catch -> `v0.0.0-unknown`. Testability-seam
description matches the source comment.

**S3.3 createRequire(import.meta.url) rationale** -- PASS on the mechanism. update.test.ts
does `vi.mock('node:fs')` at module scope (verified line 17), and version.ts uses lazy
`createRequire` to dodge that interceptor. The specific "breaking three update tests" count
is not independently re-verified (docs-only pass, tests not run) but is non-load-bearing
and the causal mechanism is correct.

**S4 update per-mode** -- PASS. npm branch prints the `npm update -g @apra-labs/apra-fleet`
guidance + the `apra-fleet install` skill-refresh reminder and returns with no fetch; dev
branch prints the exact dev message; sea proceeds to fetch (`update.ts:11-23`). Minor: the
doc phrases it as "Prints `npm update -g ...`" -- the code prepends an "installed via npm.
To update, run:" line first; essence preserved, not misleading.

**S5 --version output** -- PASS. Three-line format and the `(node <ver>)` suffix gated on
`mode !== 'sea'` match `src/index.ts:10-16` exactly. "Diagnostic substitute for a status
command" framing is consistent with S6.

**S6 Descoped Work** -- PASS and CORRECT. Verified absent in the tree:
`src/services/service-manager/` (no dir), `status.ts` (none), no `start`/`stop`/`restart`/
`status` CLI subcommand in index.ts, no `/health`. (Note: a `fleet_status` MCP tool and
`check-status.ts` do exist, but the doc scopes its claim to a *CLI status command* and a
*/health endpoint*, which genuinely do not exist -- the wording does not overstate.)

**S7.1 files whitelist** -- PASS. Exact match to package.json `files` (dist/, hooks/,
scripts/fleet-statusline.sh, scripts/agy-settings-merge.js, scripts/agy-transcript-reader.js,
skills/, version.json). "NOT shipped" list (src/, build .mjs scripts, SEA artifacts) is
correct. The "individual scripts, not a glob" maintenance note is accurate and valuable.
Tarball size figures (~1.3 MB unpacked / ~311 KB / 482 files) not independently re-measured;
non-load-bearing and consistent with the CI 10MB guard.

**S7.2 package.json fields** -- PASS. name, version 0.2.2, bin map, engines.node `>=22.0.0`,
publishConfig.access public, prepublishOnly `npm run build`, type module -- all verified
against package.json.

**S8 CI npm-publish job** -- PASS. Verified every claim against `.github/workflows/ci.yml`:
job name `npm-publish` after `release`; `needs: build-and-test`; tag gate
`if: startsWith(github.ref, 'refs/tags/v')`; `runs-on: ubuntu-latest`; job-level
`id-token: write` + `contents: read`; `environment: npm`. All ten steps present and in the
described order (checkout + setup-node with registry-url, npm ci, inject-version, lockstep
guard, build, verify-shebang grep, dry-run pack grep set, clean-pack guard with *.exe/
sea-prep.blob/sea-bundle.cjs reject + 10MB limit, idempotency `npm view`, publish
`--provenance --access public` with `NODE_AUTH_TOKEN: secrets.NPM_TOKEN`, skipped when
already_published). The "release job needs does not include npm-publish; npm-publish does
not block release" claim is correct (release `needs: [package, build-binary, sign-windows]`).

**S8.4 Hard constraint** -- PRESENT and CORRECT. Doc states no actual publish occurs without
a human pushing a `v*` tag AND an `NPM_TOKEN` secret (plus the @apra-labs org). This matches
the tag gate + `secrets.NPM_TOKEN` usage. Required safety statement satisfied.

---

## Findings

No HIGH findings.
No MEDIUM findings.

### LOW

- **LOW-1 (S2.2 wording):** "could never return `true`" is a mild overstatement of the old
  realpath comparison -- in pathological symlink-resolution edge cases the strings could in
  principle differ. The described real-world failure mode (npm global misclassified as dev)
  is correct, so this does not mislead a maintainer. No change required.
- **LOW-2 (S4 wording):** npm-mode is summarized as "Prints `npm update -g ...`" whereas the
  code emits an intro line first. Cosmetic; essence accurate. No change required.
- **LOW-3 (S7.1 / S3.3):** Tarball size/file-count figures and the "three update tests" count
  were not independently re-measured in this docs-only pass. Non-load-bearing. No change
  required.

---

## Summary

The as-built reference is accurate. Every technical claim I could check against source --
delivery-mode detection (including the subtle .git-vs-path-comparison rationale, cross-checked
against the pre-fix commit), version resolution chain, update per-mode behavior, --version
output, the files whitelist and package.json fields, and the full CI npm-publish job -- maps
faithfully to the shipped code. The two required guard statements are present and correct: the
publish hard-constraint (human-pushed `v*` tag + `NPM_TOKEN`) and the descope statement
(service-manager / status CLI / /health do not exist). The doc is ASCII-clean and the harvest
commits touched only the doc + progress.json. Three LOW wording/measurement nits are noted but
none are misleading. APPROVED.
