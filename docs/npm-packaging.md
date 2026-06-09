# npm Packaging -- As-Built Reference

**Sprint:** feat/npm-packaging (bead apra-fleet-tmt.20)
**Design doc (pre-build investigation):** docs/npm-packaging-plan.md
**This doc:** what actually shipped -- authoritative for all future work

---

## 1. Two Delivery Modes

apra-fleet ships in two mutually exclusive runtime forms that can coexist on
the same machine:

| Mode | How installed | Entry point | process.execPath |
|------|---------------|-------------|-----------------|
| `sea` | GitHub release binary | platform ELF/PE/Mach-O | the binary itself |
| `npm` | `npm i -g @apra-labs/apra-fleet` | `dist/index.js` run by node | the node executable |
| `dev` | `node dist/index.js` from source tree | `dist/index.js` | the node executable |

Coexistence is safe because:
- The SEA binary installs to `~/.local/share/apra-fleet/apra-fleet` (or equivalent).
- The npm global install goes to the npm prefix (`node_modules/@apra-labs/apra-fleet/`).
- Neither overwrites the other; the two `binaryPath` values are distinct.

No code path copies a binary or registers an MCP entry point without first
detecting the mode (see Section 2).

---

## 2. Delivery-Mode Detection

### 2.1 isSea() -- src/cli/install.ts

```
export function isSea(): boolean
```

Calls `require('node:sea').isSea()` at runtime. Returns `false` in any error
catch (dev or npm mode, where `node:sea` is not available). A test-only override
`_setSeaOverride(v: boolean | null)` exists; set to `null` to restore default.
`isSea` is now `export`-ed so `update.ts` and `delivery-mode.ts` can import it
directly.

### 2.2 isNpmGlobalInstall() -- src/cli/install.ts

```
export function isNpmGlobalInstall(): boolean
```

Returns `true` when ALL of the following hold:
1. `isSea()` is `false`.
2. `process.argv[1]` contains the string `node_modules`.
3. The project root resolved by `findProjectRoot()` does NOT contain a `.git`
   directory (i.e., `fs.existsSync(path.join(projectRoot, '.git'))` is `false`).

**Why the .git check, not a path comparison?**

An earlier approach compared `process.argv[1]` against
`findProjectRoot() + '/dist/index.js'`. This failed silently because
`findProjectRoot()` anchors on the module's own `__dirname`, which for a real
npm global install resolves to the npm package's `dist/` directory.
`process.argv[1]` is also `<npm-package-root>/dist/index.js`. The comparison
was therefore a path against itself and could never return `true`, so npm mode
was never detected and the dev-mode message was printed instead.

The `.git` directory check is the correct signal: a real npm global install of
a published tarball has no `.git/` at its package root; a dev checkout always
does. This is reliable across platforms and does not depend on path string
matching.

If `findProjectRoot()` throws, `isNpmGlobalInstall()` returns `true` (the catch
branch): if we cannot locate a project root at all, we are not in a dev checkout.

### 2.3 getDeliveryMode() / getDeliveryInfo() -- src/delivery-mode.ts

```
export type DeliveryMode = 'sea' | 'npm' | 'dev';

export function getDeliveryMode(): DeliveryMode
  // isSea() -> 'sea'; isNpmGlobalInstall() -> 'npm'; else -> 'dev'

export function getDeliveryInfo(): { mode: DeliveryMode; binary: string; nodeVersion: string }
  // binary: process.execPath for sea; process.argv[1] for npm + dev
  // nodeVersion: process.version
```

`getDeliveryInfo()` is the canonical diagnostic call. It is consumed by the
`--version` handler (Section 5) and is available as a foundation for any future
`status` command or `/health` endpoint (see Section 6).

---

## 3. Version Resolution -- src/version.ts

### 3.1 Priority chain

`resolveVersion()` (called once at module scope, result exported as `serverVersion`) follows:

1. **BUILD_VERSION** -- esbuild `define` constant injected at SEA bundle time.
   If defined and non-undefined, return immediately (no file I/O). This is the
   SEA path.

2. **ESM path** -- `typeof __dirname === 'undefined'` is true for tsc ESM output
   (npm mode). Computes `dir` via `dirname(fileURLToPath(import.meta.url))`,
   then `root = join(dir, '..')`. Delegates to `resolveVersionFromRoot(root)`.

3. **CJS path** -- `__dirname` is defined (SEA bundle is CJS; this branch also
   handles dev mode with CJS tooling). `root = join(__dirname, '..')`. Delegates
   to `resolveVersionFromRoot(root)`.

4. **v0.0.0-unknown** -- catch block inside `resolveVersionFromRoot` if
   `version.json` is missing or unreadable.

### 3.2 resolveVersionFromRoot(rootDir)

Exported as a testability seam. Reads `version.json` from `rootDir`, returns
`v<semver>`. Appends a `_<6-hex>` git-hash suffix if `.git/HEAD` exists (dev
mode only; npm tarballs contain no `.git/`). Callers can pass a nonexistent
`rootDir` to exercise the fallback path without mocking native built-ins.

### 3.3 Why createRequire(import.meta.url)?

All `fs`/`path`/`url` imports inside `version.ts` are loaded lazily via
`createRequire(import.meta.url)` rather than top-level ESM `import` statements.
This is intentional: `serverVersion` is assigned at module scope (eagerly, when
the module loads). `tests/update.test.ts` mocks `node:fs` at module scope via
`vi.mock('node:fs')`. A static top-level `import { readFileSync } from 'node:fs'`
would be intercepted by that mock, resolving `serverVersion` to `v0.0.0-unknown`
at load time and breaking three update tests. Lazy `createRequire` bypasses
the vitest `vi.mock` interceptor for `node:module` (which is not mocked), so
`serverVersion` resolves correctly in both the runtime and test contexts.

---

## 4. apra-fleet update -- per-mode behavior

Implemented in `src/cli/update.ts`. The mode check runs before any network
call.

| Mode | Behavior |
|------|----------|
| `npm` | Prints `npm update -g @apra-labs/apra-fleet`, then blank line, then `apra-fleet install` skill-refresh reminder. Returns. No fetch. |
| `dev` | Prints `apra-fleet is running in dev mode. Pull the latest source and rebuild.` Returns. No fetch. |
| `sea` | Proceeds to GitHub Releases API fetch + binary download (existing logic, unchanged). |

The skill-refresh reminder (`apra-fleet install`) is required because
`npm update -g` replaces the `dist/` files but does NOT re-copy skills or hooks
that were previously installed to `~/.claude/skills/` or hook directories.
Running `apra-fleet install` after updating is the correct refresh procedure.

---

## 5. apra-fleet --version output

Implemented in `src/index.ts`. Output is three lines:

```
apra-fleet v0.2.2_d86bc6
  Mode:   npm (node v22.x.x)
  Binary: /usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/index.js
```

SEA mode omits the `(node ...)` suffix:

```
apra-fleet v0.2.2
  Mode:   sea
  Binary: /home/user/.local/share/apra-fleet/apra-fleet
```

Dev mode (no `.git` hash suffix in npm tarball; hash present in dev checkout):

```
apra-fleet v0.2.2_a2b4fd
  Mode:   dev (node v20.19.0)
  Binary: C:\akhil\git\apra-fleet\dist\index.js
```

**This output is the diagnostic substitute for a `status` command, which does
not exist in the codebase.** When diagnosing coexistence issues (wrong binary
in PATH, unexpected mode), `apra-fleet --version` is the correct first step.

---

## 6. Descoped Work

The pre-build design doc (docs/npm-packaging-plan.md, Sections 1.7, 14.2, 14.3)
references:

- `src/services/service-manager/` with `windows.ts`, `linux.ts`, `macos.ts`
- A `status` CLI command (`status.ts:53-86`)
- A `/health` endpoint

**None of these exist in the codebase.** They were not implemented before this
sprint and were not created during it. The plan scoped coexistence diagnostics
to what was buildable: `getDeliveryMode()` / `getDeliveryInfo()` in
`src/delivery-mode.ts`, surfaced via `--version`. A future `status` command
would import `getDeliveryInfo()` from `./delivery-mode.js` as its foundation.
Service overwrite warnings (S14.2) and cross-mode `/health` (S14.3) are
deferred until the service-manager infrastructure exists.

There is also no `start`, `stop`, `restart` CLI subcommand in the current
codebase. The `--help` text does not list them.

---

## 7. npm Package Contents

### 7.1 files whitelist (package.json)

```json
"files": [
  "dist/",
  "hooks/",
  "scripts/fleet-statusline.sh",
  "scripts/agy-settings-merge.js",
  "scripts/agy-transcript-reader.js",
  "skills/",
  "version.json"
]
```

**What is shipped:** compiled JS (`dist/`), hooks config, three runtime scripts,
skills (fleet + pm), and `version.json`.

**What is NOT shipped:** `src/` (TypeScript source), `tsconfig.json`, build
scripts (`scripts/build-sea.mjs`, `scripts/gen-sea-config.mjs`,
`scripts/package-sea.mjs`, `scripts/install-hooks.mjs`), `node_modules/`,
SEA artifacts (`dist/sea-bundle.cjs`, `dist/sea-prep.blob`,
`dist/*.exe`, platform binaries).

The `scripts/` entries are explicit individual files, not a `scripts/` glob.
This is intentional: a bare `scripts/` glob would ship the `.mjs` build scripts.
**Maintenance note:** if a new runtime script is added under `scripts/`, it must
also be added to `files` manually or it will be silently excluded from the tarball.

Validated tarball size: ~1.3 MB unpacked, ~311 KB compressed (482 files).

### 7.2 Other package.json fields

| Field | Value | Notes |
|-------|-------|-------|
| `name` | `@apra-labs/apra-fleet` | Scoped; requires `@apra-labs` npm org |
| `version` | `0.2.2` | Must match `version.json` at publish time |
| `bin` | `{ "apra-fleet": "dist/index.js" }` | npm sets executable bit; shebang preserved by tsc |
| `engines.node` | `>=22.0.0` | Node 22 required for `node:sea` API + native `fetch` |
| `publishConfig.access` | `public` | Required for scoped packages on public npm |
| `prepublishOnly` | `npm run build` | Ensures `dist/` is rebuilt before packing |
| `type` | `module` | ESM output; tsc emits `.js` (not `.mjs`) |

---

## 8. Release / CI -- npm-publish job

### 8.1 Job location

`.github/workflows/ci.yml`, job name `npm-publish`, after the `release` job.

### 8.2 Trigger guard

```yaml
if: startsWith(github.ref, 'refs/tags/v')
```

The job runs ONLY when a `v*` tag is pushed. No `v*` tag was pushed during this
sprint. The job is authored and committed but has never been triggered.

### 8.3 Job structure

- `needs: build-and-test` (NOT `package`, `build-binary`, or `sign-windows`)
- `runs-on: ubuntu-latest`
- `permissions: contents: read, id-token: write` (job-level only)
- `environment: npm`

Steps in order:
1. Checkout + Setup Node 22.x with `registry-url: https://registry.npmjs.org`
2. `npm ci`
3. **Inject version from tag** -- rewrites `package.json` and `version.json`
   with the semver extracted from `GITHUB_REF` (strips `refs/tags/v` prefix)
4. **Version lockstep guard** -- asserts tag == `package.json.version` ==
   `version.json.version`; fails the job if they diverge
5. `npm run build`
6. **Verify shebang** -- `head -1 dist/index.js | grep -q '^#!/usr/bin/env node'`
7. **Dry-run pack verification** -- `npm pack --dry-run`; greps for required
   files (`dist/index.js`, `version.json`, `hooks/hooks-config.json`, `skills/`)
8. **Clean-pack guard** -- rejects `*.exe`, `sea-prep.blob`, `sea-bundle.cjs`
   in the pack output; fails if unpacked size exceeds 10 MB
9. **Idempotency check** -- `npm view @apra-labs/apra-fleet@<tag> version`;
   skips publish if already published (reruns the job safely)
10. **Publish** -- `npm publish --provenance --access public`; skipped if step 9
    set `already_published=true`; uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`

### 8.4 Hard constraint

**An actual publish requires a human to:**
1. Create and push a `v*` tag (e.g., `git tag v0.2.2 && git push origin v0.2.2`)
2. Ensure the `NPM_TOKEN` secret is present in the repository
3. Ensure the `@apra-labs` npm org exists and the token has publish rights

The CI job enforces version lockstep and pack hygiene automatically, but it
cannot run without a tag + secret. This is intentional.

The `release` job (SEA binaries) is unchanged; its `needs` list does not include
`npm-publish` and `npm-publish` does not block it.
