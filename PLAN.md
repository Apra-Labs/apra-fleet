# apra-fleet npm Packaging -- Implementation Plan

> Publish apra-fleet to npmjs via `npm i -g @apra-labs/apra-fleet` with zero feature loss
> vs the existing SEA binary. Both delivery modes coexist. No actual npm publish -- CI job
> authored but not triggered.

**Design source:** `docs/npm-packaging-plan.md` (authoritative investigation, ~1200 lines)
**Requirements:** `.sprint/requirements.md`
**Base branch:** main
**Implementation branch:** feat/npm-packaging

---

## Codebase Reality Check (verified before planning)

The design doc (S1.7, S14.2, S14.3) references `src/services/service-manager/` with
`windows.ts`, `linux.ts`, `macos.ts` and a `status` CLI command (`status.ts`). These
**do not exist** in the current codebase. There is no OS service registration step in
`install.ts`, no `serviceStep` variable, no `start`/`stop`/`restart`/`status` CLI
commands, and no `/health` endpoint. The design doc line numbers for `install.ts` are
offset from reality (e.g., binary copy is at line 494, not 544).

What DOES exist and is relevant:
- `install.ts:494` -- `isSea()` gate on binary copy step
- `install.ts:548` -- `isSea()` conditional for MCP server config (command vs node)
- `install.ts:578,595` -- `isSea()` gates on skill extraction (SEA blob vs filesystem copy)
- `install.ts:469` -- `isSea()` gate on running-process guard
- `version.ts:5-44` -- `resolveVersion()` with CJS-only dev fallback (broken under ESM/npm)
- `update.ts:10-102` -- SEA-only self-update (downloads binary from GitHub releases)
- `.github/workflows/ci.yml` -- 5 jobs, no npm-publish job

Plan below is scoped to what the current codebase supports. Service-manager and status
CLI work is noted in the Risk Register as out-of-scope (the underlying infrastructure
does not exist yet).

---

## Tasks

### Phase 1: package.json + npm-pack validation (risk-first)

> Validates the riskiest assumption: that the dev-mode asset path and ESM dist entry
> already work for npm, BEFORE building anything else on top.

#### Task 1: Update package.json for npm publishing
- **Change:** Add `bin`, `files`, `engines`, `publishConfig`, `prepublishOnly`, update
  `name` to `@apra-labs/apra-fleet`, add `description`/`author`/`repository` fields per
  design doc S3. Specifically:
  - `"name": "@apra-labs/apra-fleet"`
  - `"bin": { "apra-fleet": "dist/index.js" }`
  - `"files": ["dist/", "hooks/", "scripts/fleet-statusline.sh", "scripts/agy-settings-merge.js", "scripts/agy-transcript-reader.js", "skills/", "agents/", "version.json"]`
    (targeted `scripts/` entries to exclude `.mjs` build scripts per S6.3)
  - `"engines": { "node": ">=22.0.0" }`
  - `"publishConfig": { "access": "public" }`
  - Add `"prepublishOnly": "npm run build"` to `scripts`
  - Keep all existing fields (keywords, license, dependencies, devDependencies, existing scripts)
- **Files:** `package.json`
- **Tier:** cheap
- **Done when:** `npm run build` succeeds; `npm pack --dry-run` lists `dist/index.js`,
  `version.json`, `hooks/hooks-config.json`, `skills/pm/`, `skills/fleet/`, `agents/`,
  and does NOT list `src/`, `tsconfig.json`, `*.mjs`, `node_modules/`. Existing `npm test`
  still passes (no regression).
- **Blockers:** None

#### Task 2: npm pack + local global install smoke test
- **Change:** Run `npm pack`, install the tarball globally (`npm i -g ./apra-labs-apra-fleet-*.tgz`),
  and verify: `apra-fleet --version` outputs a version string (will show `v0.0.0-unknown`
  until version.ts is fixed -- that is expected at this stage), `apra-fleet --help` prints
  usage. Verify `dist/index.js` in the tarball starts with `#!/usr/bin/env node`. This is a
  manual validation task -- the doer runs these commands and reports results. If the shebang
  is missing or the global install fails, the binary copy / ESM entry approach is invalidated
  and the plan must be revised. Clean up: `npm uninstall -g @apra-labs/apra-fleet`.
- **Files:** None (validation only, no code changes)
- **Tier:** standard
- **Done when:** Doer reports: (a) `npm pack --dry-run` file list matches expectations,
  (b) global install succeeds, (c) `apra-fleet --help` prints usage text, (d) shebang
  present in `dist/index.js`. Results documented in commit message or task notes.
- **Blockers:** Task 1 must be committed first

#### VERIFY: Phase 1 -- npm pack validation
- Confirm `npm pack --dry-run` output is correct
- Confirm global install + `--help` works
- Confirm shebang present in dist/index.js
- Confirm existing test suite still passes (`npm test`)
- Report: pass/fail, any unexpected files included/excluded, tarball size

---

### Phase 2: version.ts ESM fallback

> Fixes `apra-fleet --version` for npm installs. Currently returns `v0.0.0-unknown`
> because the dev fallback uses CJS idioms (`require`, bare `__dirname`) that fail
> under ESM. This is a one-function refactor with no external dependencies.

#### Task 3: Fix resolveVersion() for ESM (npm mode)
- **Change:** Refactor `resolveVersion()` in `src/version.ts` to handle ESM execution.
  The function currently uses `require('node:fs')` and bare `__dirname` (CJS idioms) in
  the dev fallback path (lines 14-41). Under ESM (`tsc` output for npm), `require` throws
  `ReferenceError` and the function falls through to `v0.0.0-unknown`.
  Fix: Add an ESM-compatible path that uses `import.meta.url` to resolve the package root
  and reads `version.json` from there. The detection mechanism: check
  `typeof __dirname === 'undefined'` (ESM) vs defined (CJS/SEA). If ESM, compute root via
  `dirname(fileURLToPath(import.meta.url))` + `..` and read `version.json` synchronously
  with `readFileSync` (imported at top of file). Keep the existing CJS path for SEA
  compatibility. Keep the `BUILD_VERSION` check first (SEA). Keep the git-hash suffix logic
  for dev mode only (npm installs have no `.git/` directory).
  The function must remain synchronous (it is called at module scope and assigned to
  `export const serverVersion`).
- **Files:** `src/version.ts`
- **Tier:** standard

- **Done when:** After `npm run build`, running `node dist/index.js --version` from the
  project root prints the real semver from `version.json` (e.g., `apra-fleet v0.2.2_abc123`),
  not `v0.0.0-unknown`. Existing SEA build path is unaffected (BUILD_VERSION still works).

- **Blockers:** None

#### Task 4: Unit tests for version.ts ESM fallback
- **Change:** Create `tests/version.test.ts` with vitest tests covering:
  1. ESM path: mock `import.meta.url` context, verify `resolveVersion()` reads
     `version.json` and returns `v<version>` (no git hash when `.git/` absent)
  2. CJS/SEA path: verify `BUILD_VERSION` is returned when defined
  3. Fallback: verify `v0.0.0-unknown` when both paths fail (no `version.json`, no
     `BUILD_VERSION`)
  4. Git hash suffix: verify hash is appended when `.git/HEAD` exists
  Use vitest mocking for `fs.readFileSync`, `fs.existsSync`. Follow the existing test
  pattern from `tests/install.test.ts` (vi.mock, vi.mocked, beforeEach/afterEach cleanup).
  The version module exports `serverVersion` as a const -- tests may need to re-import or
  use `vi.resetModules()` to re-evaluate.
- **Files:** `tests/version.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes including the new test file. Tests cover ESM path, CJS
  path, fallback path, and git-hash path.
- **Blockers:** Task 3 (needs the refactored version.ts to test)

#### VERIFY: Phase 2 -- version ESM fallback
- `npm test` green (all existing + new version tests)
- `node dist/index.js --version` prints real semver (not v0.0.0-unknown)
- SEA build still works: `npm run build:sea` succeeds (does not need to run full package)

---

### Phase 3: install.ts -- npm detection + binary-copy gate

> Modifies install.ts so npm global installs are recognized and handled correctly.
> The binary-copy step (line 494) currently only runs for SEA; npm mode falls through
> to "Dev mode -- skipping binary copy". The MCP config (line 548) already handles
> dev mode correctly. This phase adds `isNpmGlobalInstall()` detection and adjusts
> the binary-copy gate to set `binaryPath` appropriately for npm installs.

#### Task 5: Add isNpmGlobalInstall() + modify binary-copy and MCP config gates
- **Change:** In `src/cli/install.ts`:
  1. Add exported function `isNpmGlobalInstall(): boolean` that returns true when
     `process.argv[1]` contains `node_modules` (indicating npm-managed execution) AND
     the script is not under the project's own dev `dist/` (to distinguish from `npm test`
     or dev-mode runs). Heuristic: `process.argv[1]` includes `node_modules` and does NOT
     equal `findProjectRoot() + '/dist/index.js'` (dev mode). Export for testability.
  2. Modify the binary-copy block (line 494) from the current two-branch
     `if (isSea()) { ... } else { ... }` to a three-branch:
     - `if (isSea())` -- existing binary copy logic (unchanged)
     - `else if (isNpmGlobalInstall())` -- print "npm global install detected -- skipping
       binary copy"; set `binaryPath = process.argv[1]` (absolute path to dist/index.js)
     - `else` -- existing "Dev mode -- skipping binary copy" (unchanged)
  3. Modify the MCP config block (line 548) to handle npm mode: when
     `isNpmGlobalInstall()` is true, use `{ command: process.execPath, args: [process.argv[1]] }`
     (i.e., `node <absolute-path-to-dist/index.js>`) instead of the dev-mode
     `{ command: 'node', args: [findProjectRoot() + '/dist/index.js'] }`. This ensures
     the MCP registration uses an absolute node path that survives PATH changes.
  4. Modify the running-process guard (line 469) to also run for npm mode (not just SEA).
     Change `if (isSea() && isApraFleetRunning())` to
     `if ((isSea() || isNpmGlobalInstall()) && isApraFleetRunning())`.
- **Files:** `src/cli/install.ts`
- **Tier:** standard
- **Done when:** `npm run build` succeeds. Existing install tests pass unchanged
  (they use `_setSeaOverride(false)` which is dev mode, unaffected by this change).
  The new `isNpmGlobalInstall` function is exported and callable.
- **Blockers:** None

#### Task 6: Unit tests for isNpmGlobalInstall + install npm-mode paths
- **Change:** Add tests to `tests/install.test.ts` (or a new `tests/install-npm.test.ts`
  if the existing file is too large) covering:
  1. `isNpmGlobalInstall()` returns true when `process.argv[1]` contains `node_modules`
     and is not the dev dist path
  2. `isNpmGlobalInstall()` returns false for dev mode (process.argv[1] is the project's
     own dist/index.js)
  3. `isNpmGlobalInstall()` returns false when `isSea()` is true (SEA binary)
  4. Binary-copy step in npm mode: verify no `fs.copyFileSync` call, verify `binaryPath`
     is set to `process.argv[1]`
  5. MCP config in npm mode: verify the MCP registration uses `process.execPath` + absolute
     script path
  Use `_setSeaOverride(false)` and mock `process.argv[1]` to simulate npm context.
  Follow existing test patterns (vi.mock fs, os, child_process).
- **Files:** `tests/install-npm.test.ts` (new file)
- **Tier:** standard
- **Done when:** `npm test` passes with all new tests green. Coverage: npm detection
  logic, binary-copy skip, MCP config for npm mode.
- **Blockers:** Task 5

#### VERIFY: Phase 3 -- install npm detection
- `npm test` green
- Manual check: code review confirms isSea() gates are updated, isNpmGlobalInstall() exported
- No regression on existing install tests

---

### Phase 4: update.ts -- npm redirect

> Redirects `apra-fleet update` to print `npm update -g @apra-labs/apra-fleet` for npm
> users instead of downloading a SEA binary. Includes the skill-refresh reminder per S14.4.

#### Task 7: Add npm-mode redirect to runUpdate()
- **Change:** In `src/cli/update.ts`, add an early-return branch at the top of
  `runUpdate()` (after the imports, before the fetch call). Import `isSea` from
  `install.js` (it is already exported as `_setSeaOverride` exists; the `isSea` function
  itself needs to be exported -- add `export` to it). Also import `isNpmGlobalInstall`
  from `install.js`.
  Logic:
  ```
  if (!isSea()) {
    if (isNpmGlobalInstall()) {
      console.log('apra-fleet is installed via npm. To update, run:');
      console.log('  npm update -g @apra-labs/apra-fleet');
      console.log('');
      console.log('After updating, re-install skills and hooks:');
      console.log('  apra-fleet install');
    } else {
      console.log('apra-fleet is running in dev mode. Pull the latest source and rebuild.');
    }
    return;
  }
  ```
  This prevents npm users from accidentally downloading a SEA binary. The skill-refresh
  reminder addresses the gap noted in S14.4: `npm update -g` does NOT refresh skills/hooks
  already copied to `~/.claude/skills/`.
  Also export `isSea` from install.ts (add `export` keyword to the function declaration).
- **Files:** `src/cli/update.ts`, `src/cli/install.ts` (export isSea)
- **Tier:** standard
- **Done when:** `npm run build` succeeds. After build, running
  `node dist/index.js update` (dev mode) prints "running in dev mode" message.
  Existing update tests still pass.
- **Blockers:** Task 5 (needs isNpmGlobalInstall)

#### Task 8: Unit tests for update npm redirect
- **Change:** Add tests to `tests/update.test.ts` (extend existing file) or a new
  `tests/update-npm.test.ts` covering:
  1. When `isSea()` returns false and `isNpmGlobalInstall()` returns true, `runUpdate()`
     prints the npm update command and the skill-refresh reminder, then returns without
     making any fetch calls
  2. When `isSea()` returns false and `isNpmGlobalInstall()` returns false, prints dev-mode
     message
  3. When `isSea()` returns true, existing update behavior is unchanged (fetch is called)
  Mock `isSea` and `isNpmGlobalInstall` via vi.mock of `../src/cli/install.js`.
  Verify `fetch` is NOT called in npm/dev paths. Verify console.log output contains
  `npm update -g` and `apra-fleet install` (skill-refresh reminder).
- **Files:** `tests/update-npm.test.ts` (new file)
- **Tier:** standard
- **Done when:** `npm test` passes with all new tests green. Covers npm redirect,
  dev-mode message, and SEA passthrough.
- **Blockers:** Task 7

#### VERIFY: Phase 4 -- update redirect
- `npm test` green
- Manual: `node dist/index.js update` prints dev-mode message (not a fetch error)
- Existing update.test.ts tests still pass

---

### Phase 5: Coexistence guards -- mode detection utility + status output

> Adds a `getDeliveryMode()` utility that reports SEA vs npm vs dev mode, and surfaces
> this in `--version` output. A full `status` CLI command and `/health` endpoint do not
> exist in the codebase and are out of scope for this sprint (see Risk Register). Instead,
> mode information is embedded in the version string and available via the utility function
> for future status/health work.

#### Task 9: Add getDeliveryMode() utility + enhance --version output
- **Change:**
  1. Create `src/delivery-mode.ts` exporting:
     - `type DeliveryMode = 'sea' | 'npm' | 'dev'`
     - `function getDeliveryMode(): DeliveryMode` -- returns `'sea'` if `isSea()`, `'npm'`
       if `isNpmGlobalInstall()`, `'dev'` otherwise
     - `function getDeliveryInfo(): { mode: DeliveryMode; binary: string; nodeVersion: string }`
       -- returns mode, the binary/script path (`process.execPath` for SEA,
       `process.argv[1]` for npm, `process.argv[1]` for dev), and `process.version`
     Import `isSea` and `isNpmGlobalInstall` from `./cli/install.js`.
  2. Modify `src/index.ts` lines 9-11 (--version handler): change from
     `console.log(\`apra-fleet ${serverVersion}\`)` to also print mode info:
     ```
     console.log(`apra-fleet ${serverVersion}`);
     console.log(`  Mode:   ${info.mode}${info.mode !== 'sea' ? ' (node ' + info.nodeVersion + ')' : ''}`);
     console.log(`  Binary: ${info.binary}`);
     ```
     Import `getDeliveryInfo` from `./delivery-mode.js`.
  This gives users a way to diagnose which delivery mode is active, addressing the
  coexistence diagnostic need from S14.3 without requiring the nonexistent `status`
  command or `/health` endpoint.
- **Files:** `src/delivery-mode.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** `npm run build` succeeds. `node dist/index.js --version` prints version
  plus mode and binary path. Existing tests pass.
- **Blockers:** Task 5 (needs exported isSea + isNpmGlobalInstall)

#### Task 10: Unit tests for delivery-mode + version output
- **Change:** Create `tests/delivery-mode.test.ts` testing:
  1. `getDeliveryMode()` returns `'sea'` when isSea() is true
  2. `getDeliveryMode()` returns `'npm'` when isNpmGlobalInstall() is true
  3. `getDeliveryMode()` returns `'dev'` otherwise
  4. `getDeliveryInfo()` returns correct binary path for each mode
  Mock `isSea` and `isNpmGlobalInstall` via vi.mock.
- **Files:** `tests/delivery-mode.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` green with new tests. All three modes covered.
- **Blockers:** Task 9

#### VERIFY: Phase 5 -- coexistence guards
- `npm test` green
- `node dist/index.js --version` shows mode + binary info
- Confirm `getDeliveryMode` is importable from other modules (for future status/health use)

---

### Phase 6: CI npm-publish job

> Adds the `npm-publish` job to `.github/workflows/ci.yml`. The job is tag-gated
> (`startsWith(github.ref, 'refs/tags/v')`), includes version-lockstep guard, dry-run
> whitelist verification, shebang check, already-published idempotency check, and
> `--provenance`. It runs parallel to `build-binary`/`release` and gates neither.
> Per hard constraint: the job is authored and committed but MUST NOT be triggered.

#### Task 11: Author npm-publish job in ci.yml
- **Change:** Add the `npm-publish` job to `.github/workflows/ci.yml` after the existing
  `release` job. The job definition follows the design doc S13.2 exactly:
  - `needs: build-and-test`
  - `if: startsWith(github.ref, 'refs/tags/v')`
  - `runs-on: ubuntu-latest`
  - `permissions: contents: read, id-token: write`
  - `environment: npm` (optional deployment protection)
  - Steps: Checkout, Setup Node 22.x with registry-url, npm ci, Inject version from tag
    (into both package.json and version.json), Version lockstep guard (tag == package.json
    == version.json), Build (`npm run build`), Verify shebang (`head -1 dist/index.js |
    grep -q '^#!/usr/bin/env node'`), Dry-run pack verification (npm pack --dry-run, grep
    for dist/index.js, version.json, hooks/hooks-config.json, skills/), Check if version
    already published (npm view idempotency), Publish with `--provenance`
    (`NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`).
  - The job does NOT gate the `release` job and is not gated by it.
  Also add top-level `permissions.id-token: write` if not already present (needed for
  provenance). Actually, set it only at job level to avoid broadening other jobs.
- **Files:** `.github/workflows/ci.yml`
- **Tier:** standard
- **Done when:** YAML is syntactically valid (`node -e "require('js-yaml').load(...)"`
  or similar check). The job appears in the workflow but is not triggered (no `v*` tag
  push). Existing jobs are unchanged. The `npm-publish` job `needs: build-and-test` only
  (does not need `package`, `build-binary`, or `sign-windows`). The `release` job `needs`
  list is unchanged.
- **Blockers:** None (can run in parallel with other phases, but ordered here for
  monotonic tier within the phase)

#### Task 12: Unit test -- CI workflow validation
- **Change:** Create `tests/ci-npm-publish.test.ts` that:
  1. Reads `.github/workflows/ci.yml` as a string
  2. Parses it as YAML (using `js-yaml` or just JSON-compatible subset)
  3. Asserts the `npm-publish` job exists
  4. Asserts it has `needs: [build-and-test]` (or `needs: build-and-test`)
  5. Asserts it has `if:` containing `startsWith(github.ref, 'refs/tags/v')`
  6. Asserts it has `permissions.id-token: write`
  7. Asserts the `release` job does NOT list `npm-publish` in its `needs`
  8. Asserts steps include version lockstep guard, shebang check, dry-run pack, and
     already-published check (grep step names)
  Note: this is a structural test, not a CI integration test. It ensures the workflow
  file stays correct across future edits.
  For YAML parsing: use `fs.readFileSync` + a simple regex or line-based check (avoids
  adding js-yaml as a devDependency). Alternatively, if js-yaml is already available
  transitively, use it.
- **Files:** `tests/ci-npm-publish.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` passes with the new test. The test validates the structural
  properties of the npm-publish job.
- **Blockers:** Task 11

#### VERIFY: Phase 6 -- CI npm-publish job
- `npm test` green (including CI workflow structure test)
- Manual: review ci.yml diff -- npm-publish job present, tag-gated, provenance enabled
- Confirm existing CI jobs (build-and-test, package, build-binary, sign-windows, release)
  are unchanged
- Confirm NO `npm publish` command is run anywhere outside the CI job

---

### Phase 7: End-to-end validation + regression check

> Final validation: full test suite, npm pack + global install with version.ts fix,
> SEA build check. This is the cumulative smoke test before PR.

#### Task 13: Full regression + npm smoke test
- **Change:** Run the complete validation sequence:
  1. `npm run build` -- clean build
  2. `npm test` -- all unit tests pass (existing + new)
  3. `npm pack --dry-run` -- verify file list
  4. `npm pack` -- create tarball
  5. `npm i -g ./apra-labs-apra-fleet-*.tgz` -- global install
  6. `apra-fleet --version` -- prints real semver + mode info (npm mode)
  7. `apra-fleet --help` -- prints usage
  8. `apra-fleet update` -- prints npm redirect message (not a fetch error)
  9. `npm uninstall -g @apra-labs/apra-fleet` -- cleanup
  10. `npm run build:sea` -- SEA build still succeeds (no regression)
  No code changes -- this is a validation task only. If any step fails, file a fix
  in the relevant phase's code.
- **Files:** None (validation only)
- **Tier:** standard
- **Done when:** All 10 steps pass. Doer reports results for each step.
- **Blockers:** All previous tasks

#### VERIFY: Phase 7 -- final validation
- All tests green
- npm pack + global install works end-to-end
- SEA build not regressed
- Ready for PR

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Design doc references non-existent code** -- S1.7 claims `src/services/service-manager/` exists with `windows.ts`, `linux.ts`, `macos.ts`; S14.3 references `status.ts:53-86` and a `/health` endpoint. None of these exist. Design doc line numbers for `install.ts` are also offset. | High -- service overwrite warning (S14.2) and status mode reporting (S14.3) cannot be implemented as described | Confirmed | Plan scopes coexistence to what IS possible: `getDeliveryMode()` utility + `--version` mode output. Service overwrite warning deferred until service-manager infrastructure exists. Risk noted in PLAN.md header. |
| **version.ts CJS idioms in ESM context** -- `require()` and bare `__dirname` throw under ESM. The design doc correctly identifies this. | High -- `--version` shows `v0.0.0-unknown` for npm users | Confirmed | Task 3 refactors `resolveVersion()` to handle ESM via `import.meta.url`. Validated by Task 4 unit tests and Phase 7 smoke test. |
| **Scoped package name availability** -- `@apra-labs/apra-fleet` requires the `@apra-labs` npm org to exist and the publisher to have write access. | Medium -- publish fails if org not configured | Low (out of sprint scope) | The CI job is authored but not triggered. Org setup is a human prerequisite documented in the design doc S10. |
| **SEA build regression** -- package.json changes (name, bin, files) could theoretically affect `build-sea.mjs` if it reads these fields. | Medium -- SEA binaries break | Low | `build-sea.mjs` reads `version.json` for version (not package.json name). `files` field is npm-only. Phase 7 validates SEA build. |
| **`scripts/` files whitelist maintenance** -- Using targeted file entries (`scripts/fleet-statusline.sh`, etc.) instead of `scripts/` glob means new runtime scripts must be added to `files` manually. | Low -- new scripts excluded from npm package silently | Medium | Documented in Task 1. Alternative: use `"scripts/"` and accept shipping `.mjs` build scripts (~30KB bloat). Team can decide. |
| **Node.js >= 22 engine requirement** -- `engines.node: ">=22.0.0"` may reject users on Node 20 LTS. | Low -- npm warns but does not block by default | Low | Node 22 is required for `node:sea` API and native `fetch`. This matches existing SEA target. npm's `engine-strict` is off by default. |
| **npm mode process detection** -- `isApraFleetRunning()` (install.ts:331-351) uses process-name detection (`tasklist`, `pgrep`). In npm mode the process is `node`, so detection returns false. The `--force` flow silently skips the kill. | Medium -- running server not stopped before reinstall in npm mode | Medium | Task 5 extends the running-process guard to also check for npm mode. Long-term fix: PID-file detection via `server.json` (out of sprint scope). |
| **No actual `npm publish`** -- Hard constraint: CI job authored but never triggered. NPM_TOKEN secret is a human action. | N/A (intentional constraint) | N/A | CI job has `if: startsWith(github.ref, 'refs/tags/v')` gate. No `v*` tag pushed during sprint. Plan and progress.json document the constraint. |
| **ASCII-only constraint** -- Pre-commit hook rejects non-ASCII characters. | Low -- build/commit fails | Low | All plan output uses ASCII-only. Doer instructions: use `--` for dashes, `->` for arrows, `[OK]` for checkmarks. Existing install.ts has one non-ASCII dash on line 504 (`--`); this should be checked/fixed. |
| **Partial coexistence** -- Service overwrite warning (S14.2) and full status reporting (S14.3) cannot be delivered because the service-manager and status CLI do not exist. | Medium -- coexistence diagnostics are limited to `--version` output | Confirmed | `getDeliveryMode()` utility created in Phase 5 provides the foundation. When service-manager/status are built in a future sprint, they can import this utility. The missing infrastructure is documented as out-of-scope, not as a plan failure. |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints -- stop and report after each one
- Base branch: main
- Implementation branch: feat/npm-packaging
- Hard constraint reminder: NO `npm publish` to npmjs.org. The npm-publish CI job is
  committed but never triggered. No member runs `npm publish`.
