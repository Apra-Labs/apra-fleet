# apra-fleet npm Packaging -- Requirements

**Date opened:** 2026-06-09
**Repo:** Apra-Labs/apra-fleet
**Base branch:** main
**Implementation branch:** feat/npm-packaging
**Doer:** fleet-dev (claude, local Windows)
**Reviewer:** fleet-rev (claude, macOS 192.168.1.13)

## Vision

Publish apra-fleet to npmjs so users can `npx @apra-labs/apra-fleet <cmd>` or
`npm i -g @apra-labs/apra-fleet` with **zero feature loss** vs the existing SEA binary,
and **both delivery modes coexist** on the same machine without corruption.

## Design Source (authoritative)

The full investigation, design, and code-change inventory is in
**`docs/npm-packaging-plan.md`** (committed to the branch). The planner and doer MUST read
that document in full. It contains exact file/line citations for every change. This
requirements file does not restate it -- it records intent, constraints, and acceptance.

## Scope -- code changes required (from plan Sections 3 & 8)

1. **package.json** (plan S3): add `bin`, `files` whitelist, `engines.node>=22`,
   `publishConfig.access=public`, `prepublishOnly`, `repository`, scoped name
   `@apra-labs/apra-fleet`, description/author. NO shebang script needed (tsc preserves
   `src/index.ts:1` shebang).
2. **src/cli/install.ts** (plan S8.1, S8.2): remove `isSea()` gate from service registration
   (`install.ts:507`) and binary-copy step (`install.ts:544`); add `isNpmGlobalInstall()`
   detection; set `binaryPath` to the node-invoked script path in npm mode; teach the service
   manager (windows.ts/linux.ts/macos.ts) to register a `node <script.js>` command when
   `binaryPath` ends in `.js`.
3. **src/cli/update.ts** (plan S8.3): redirect self-update to `npm update -g` for npm mode,
   including the "re-run `apra-fleet install`" skill-refresh reminder.
4. **src/version.ts** (plan S8.4): ESM-safe `version.json` fallback so npm installs report the
   real semver, not `v0.0.0-unknown`.

## Coexistence guards (from plan S14)

5. **Service overwrite warning** (S14.2): warn when an install would change the registered
   service exec path.
6. **Mode/Binary reporting in `apra-fleet status`** (S14.3): show SEA vs npm mode + binary path;
   surface via the /health endpoint so cross-mode status works.

## CI / release (from plan S13)

7. **`npm-publish` job** in `.github/workflows/ci.yml`: tag-gated, version-lockstep guard
   (tag == package.json == version.json), `npm pack --dry-run` file-whitelist verification,
   shebang check, already-published idempotency check, `--provenance` + `id-token: write`,
   `NPM_TOKEN` secret. Runs parallel to `build-binary`/`release`, gates neither.

## Hard Constraints (user)

- **NO publish to npmjs.org without explicit human approval.** The CI `npm-publish` job is
  authored and committed but MUST NOT be exercised, and PM/members MUST NOT run `npm publish`
  (or `npm publish --dry-run` against the live registry counts as fine; an actual publish does
  NOT). The `NPM_TOKEN` secret is a human action, not a sprint action.
- **No regressions.** The existing SEA build path (`build:sea`, CI `build-binary`) and all
  current tests must continue to pass unchanged. SEA and npm must coexist (plan S9, S14).
- **All new behaviour is unit tested.** Every code change (install gates, npm detection,
  version ESM fallback, update redirect, status mode reporting, service overwrite warning)
  ships with vitest unit tests. No change merges without tests.
- **Feature branch off `main`.** Branch `feat/npm-packaging` from `origin/main`. Never commit
  to main directly.
- Cross-platform: Windows/Linux/macOS, claude+gemini -- no platform/provider assumptions
  (existing repo invariant; enforced by pre-commit hooks). ASCII-only in committed files.

## Acceptance Criteria

- `npm pack --dry-run` lists exactly the intended files (dist/, hooks/, scripts runtime files,
  skills/, agents/, version.json) and excludes src/, *.mjs build scripts, tsconfig, node_modules.
- A locally packed tarball (`npm pack` -> `npm i -g ./*.tgz`) yields a working
  `apra-fleet --version` (real semver), `apra-fleet --help`, `apra-fleet install`,
  `apra-fleet status` (shows npm mode), `apra-fleet update` (prints npm redirect) -- verified
  on at least the local platform; cross-platform via CI matrix.
- Full existing test suite green; new unit tests green; SEA build still produces binaries.
- `apra-fleet status` reports delivery mode + binary path in both SEA and npm modes.
- CI `npm-publish` job present, syntactically valid, tag-gated, and NOT triggered.
- Reviewer (fleet-rev) APPROVED on a cumulative review; PR raised against main, CI green, NOT merged.

## Riskiest Assumption (validate first)

The plan asserts the **dev-mode asset path (`findProjectRoot` -> `version.json` 2-hop) and the
ESM `dist/*.js` entry already work for npm** without architectural change. Phase 1 must prove
this empirically with a real `npm pack` + local global install before any of the
service-manager / coexistence work is built on top of it.
