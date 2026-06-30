# npm Packaging Plan for apra-fleet

**Date:** 2026-06-08
**Branch investigated:** main (read-only)
**Goal:** Publish apra-fleet to npmjs so users can `npx apra-fleet <cmd>` or `npm i -g apra-fleet` with zero feature loss.

---

## 1. Current State

### 1.1 Build and Distribution Today

apra-fleet is distributed as a **Single Executable Application (SEA)** -- a Node.js binary with an
embedded CJS bundle and embedded runtime assets. Three platform binaries are produced:

- `dist/apra-fleet-installer-win-x64.exe`
- `dist/apra-fleet-installer-darwin-arm64`
- `dist/apra-fleet-installer-linux-x64`

Build pipeline (`package.json:21`):
1. `npm run build:sea` -- esbuild bundles `src/index.ts` -> `dist/sea-bundle.cjs` (`scripts/build-sea.mjs:30-36`)
2. `npm run build:sea-config` -- generates `dist/sea-config.json` + `dist/sea-manifest.json` with embedded asset paths (`scripts/gen-sea-config.mjs:62-119`)
3. `npm run build:sea-package` -- injects blob via `postject`, signs on macOS, sets icon on Windows (`scripts/package-sea.mjs`)

TypeScript compilation (`npm run build`, `package.json:17`) runs `tsc` and outputs to `dist/`, producing
standard ESM `.js` files. This is the **dev mode** path, used for development and testing.

### 1.2 package.json -- Current State

| Field | Value | Notes |
|---|---|---|
| name | `apra-fleet` | `package.json:2` |
| version | `0.2.1` | `package.json:3` |
| type | `"module"` | ESM -- `package.json:14` |
| main | `dist/index.js` | `package.json:15` |
| **bin** | **MISSING** | No bin field exists |
| **files** | **MISSING** | npm includes everything including node_modules, dist artifacts, etc. |
| **engines** | **MISSING** | Node.js 22+ required (esbuild target `node22`, `build-sea.mjs:34`) |
| publishConfig | MISSING | No access=public |
| prepublishOnly | MISSING | No pre-publish build step |
| dependencies | 6 packages | `@inquirer/password`, `@modelcontextprotocol/sdk`, `smol-toml`, `ssh2`, `uuid`, `zod` |
| devDependencies | 6 packages | esbuild, postject, typescript, vitest, @types/* |
| license | Apache-2.0 | `package.json:45` |

### 1.3 CLI Entry Point

`src/index.ts` is the entry point. It handles:
- `--version` / `-v` (lines 10-13)
- `--help` / `-h` (lines 15-47)
- CLI dispatch via dynamic imports (lines 49-128): install, secret, uninstall, auth, update, start, stop, restart, status
- Default (no args, SEA binary only): runs the installer. In npm/dev mode, no-args defaults to starting the MCP server (install.cjs owns the npm install path).
- `run` / `start` / `--stdio`: starts MCP server in stdio mode (lines 94-96)

`src/index.ts` line 1: `#!/usr/bin/env node` (confirmed by reading the file). `tsc` preserves
shebang lines in compiled output, so `dist/index.js` will also start with
`#!/usr/bin/env node` after a standard `npm run build`. npm additionally sets the executable
bit on files referenced by the `bin` field when it installs the package.
**No shebang injection script is needed.**

### 1.4 Runtime Asset Loading

Assets (hooks, scripts, skills, agents) are loaded by `src/cli/install.ts` via two paths:

**SEA mode** (`isSea()` returns true, install.ts:26-34):
- `getSeaAsset('manifest.json')` reads embedded manifest (install.ts:121)
- Each asset extracted from SEA blob via `sea.getAsset(key)` (install.ts:36-46)

**Dev mode** (`isSea()` returns false, install.ts:124):
- `findProjectRoot()` walks up from `__dirname` looking for `version.json` (install.ts:63-70)
- Reads files directly from disk relative to project root (install.ts:132-133)
- `buildDevManifest(root)` scans `hooks/`, `scripts/`, `skills/pm/`, `skills/fleet/`, `agents/` (install.ts:89-112)

The dev-mode path is the one npm will use. `findProjectRoot()` ascends from
`<pkg-root>/dist/cli/` and finds `version.json` at `<pkg-root>/` (2 hops). This WORKS for npm
as long as `version.json`, `hooks/`, `scripts/`, `skills/`, and `agents/` are in the `files` whitelist.

### 1.5 Version Resolution

`src/version.ts` resolves version at startup:
1. Build-time injection via `BUILD_VERSION` esbuild `define` (version.ts:8) -- SEA only
2. Dev fallback: reads `version.json` from `join(__dirname, '..')` (version.ts:19-20)

For npm: `__dirname` = `node_modules/apra-fleet/dist/` -> `../version.json` =
`node_modules/apra-fleet/version.json` -- **WORKS** if `version.json` is in `files`.

### 1.6 Native Modules

No native `.node` addons are bundled. The one optional addon is:

- `cpu-features`: Optional native performance addon for ssh2. Excluded from SEA build
  (`build-sea.mjs:52`). ssh2 wraps its require in try/catch and degrades gracefully without it.

For npm, `cpu-features` may be auto-installed as an optional dependency of ssh2 and will be
available if the user has build tools. Even without it, ssh2 functions correctly.

### 1.7 OS Service Manager

`src/services/service-manager/` contains platform-specific service registration:
- Windows: Task Scheduler via `schtasks` (`windows.ts`)
- Linux: systemd user units via `systemctl --user` (`linux.ts`)
- macOS: launchd LaunchAgents via `launchctl` (`macos.ts`)

**Critical gap**: The service registration step is gated on `isSea()`:

```
const serviceStep = isSea() && transport === 'http';  // install.ts:507
```

This means OS service auto-registration is **silently skipped** in npm/dev mode.

Similarly, the binary copy step (Step 1 of install) is gated on `isSea()` (install.ts:544):

```
if (isSea()) { ... copy process.execPath to BIN_DIR ... }
```

Both guards need to change for npm delivery to work.

### 1.8 Self-Update

`src/cli/update.ts` downloads the SEA binary installer from GitHub releases (update.ts:18,55-70)
and spawns it detached with `--force` (update.ts:95-96). This mechanism is SEA-specific.
For npm users, `npm update -g apra-fleet` is the correct update path.

### 1.9 Process Detection for --force

`isApraFleetRunning()` (install.ts:331-351) detects a running server by:
- Windows: `tasklist /FI "IMAGENAME eq apra-fleet.exe"` (install.ts:334)
- Linux/macOS: `pgrep -x apra-fleet` (install.ts:344)

In npm mode the process is named `node`, so this detection returns false. The `--force`
stop-before-reinstall flow silently does nothing. The workaround is PID-file detection via
`~/.apra-fleet/data/server.json` (which already stores the running server's port and can be
extended with a PID).

---

## 2. Feature Inventory / Parity Checklist

| Feature | CLI Command(s) | npx/global-install parity | Changes needed |
|---|---|---|---|
| MCP server -- stdio | `run` / `start` / `--stdio` | YES | Shebang + bin field |
| MCP server -- HTTP/SSE | `--transport http` | YES | Shebang + bin field |
| Install (binary + hooks + MCP + skills + service) | `install` | PARTIAL -- see below | Fix isSea() gates |
| OS service register | `install` (step 9) | NO -- skipped when !isSea() | Remove isSea() gate; detect npm path |
| OS service start | `start` | YES (delegates to service-manager) | None after install fix |
| OS service stop | `stop` | YES | None |
| OS service restart | `restart` | YES | None |
| OS service status | `status` | YES | None |
| Uninstall | `uninstall` | YES | None |
| Credential store (set/list/delete/update) | MCP tools | YES | None |
| SSH execute_command | MCP tool | YES | None |
| SSH execute_prompt | MCP tool | YES | None |
| Send/receive files (SFTP) | MCP tools | YES | None |
| LLM auth provisioning | `auth`, MCP tool `provision_llm_auth` | YES | None |
| VCS auth (GitHub/Bitbucket/AzDevOps) | MCP tool | YES | None |
| OOB auth socket (Unix/named pipe) | Background (via auth.ts) | YES | None |
| Fleet member registry | MCP tools | YES | None |
| Cloud control (AWS EC2) | MCP tool | YES | None |
| PM skill and fleet skill installation | `install --skill` | YES (after asset fix) | files whitelist |
| Agent file installation | `install` | YES (after asset fix) | files whitelist |
| Hooks installation | `install` | YES (after asset fix) | files whitelist |
| Scripts installation (statusline etc.) | `install` | YES (after asset fix) | files whitelist |
| Self-update | `update` | REDIRECT needed | Detect npm; print npm update command |
| Multi-provider (claude/gemini/codex/copilot/agy) | `install --llm` | YES | None |
| version / --version | `version`, `-v` | YES | None |
| Binary copy to BIN_DIR | `install` step 1 | NO (npm handles binary) | Accept absence; record npm binary path |

**Feature parity summary:** YES with three targeted code changes. See Section 3.

---

## 3. package.json Changes

Below is the complete set of changes needed. No source code changes are listed here except
what must happen to `package.json` itself and to one post-build step (shebang injection).

```json
{
  "name": "@apra-labs/apra-fleet",
  "version": "0.2.1",
  "description": "MCP server for orchestrating multiple agentic AI instances (Claude, Gemini, Codex, Copilot, AGY) across machines via SSH",
  "author": "Apra Labs",
  "license": "Apache-2.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "apra-fleet": "dist/index.js"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "files": [
    "dist/",
    "hooks/",
    "scripts/",
    "skills/",
    "agents/",
    "version.json"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build",
    ...existing scripts...
  },
  // NOTE: No postbuild shebang injection needed -- src/index.ts line 1 already has
  // #!/usr/bin/env node, which tsc preserves in dist/index.js. npm sets the
  // executable bit on the bin target at install time.
  "repository": {
    "type": "git",
    "url": "https://github.com/Apra-Labs/apra-fleet.git"
  }
}
```

**Rationale for each field:**

- **name `@apra-labs/apra-fleet`**: Scoped package under the org. Avoids name squatting on the
  unscoped `apra-fleet` name (which may already be taken). Scoped packages require
  `publishConfig.access: "public"` to be public.
  Alternative: keep `apra-fleet` unscoped if the name is available -- check with `npm info apra-fleet`.

- **`bin.apra-fleet`**: Maps the `apra-fleet` command to `dist/index.js`. npm creates OS shims:
  - Linux/macOS: symlink in `<prefix>/bin/apra-fleet` -> `dist/index.js`
  - Windows: `<prefix>\apra-fleet.cmd` and `<prefix>\apra-fleet.ps1` wrappers

- **`engines.node: ">=22.0.0"`**: Matches the esbuild SEA target (`node22`, `build-sea.mjs:34`).
  Node.js 22 introduced the stable `node:sea` API; also required for native `fetch` used in
  `update.ts:17`.

- **`files` whitelist**: Must include:
  - `dist/` -- compiled JS (all CLI, tools, services)
  - `hooks/` -- `hooks-config.json` and shell hooks (read by `buildDevManifest`, install.ts:91)
  - `scripts/` -- runtime scripts like `fleet-statusline.sh` (install.ts:95)
  - `skills/` -- pm/ and fleet/ skill markdown and JSON files (install.ts:99-100)
  - `agents/` -- planner.md, doer.md, etc. (install.ts:102-108)
  - `version.json` -- read by `findProjectRoot` check (install.ts:66) and version.ts (version.ts:20)
  - NOT included: `src/`, `*.mjs` build scripts, `tsconfig.json`, `assets/icons/`,
    `node_modules/`, `.git/`, test files

- **`prepublishOnly: "npm run build"`**: Ensures dist/ is always compiled before publish.
  Guards against accidentally publishing stale compiled output.

- **`postbuild`**: Runs `scripts/add-shebang.mjs` (new script, see Section 4) to inject
  `#!/usr/bin/env node` at the top of `dist/index.js` after each `tsc` run.

---

## 4. Entry Point

### 4.1 Shebang

`src/index.ts` line 1 contains `#!/usr/bin/env node`. TypeScript's `tsc` preserves shebang
lines in compiled output. After `npm run build`, `dist/index.js` starts with
`#!/usr/bin/env node`. No post-build injection script is needed.

On Windows, npm's `.cmd` shim calls `node dist/index.js` explicitly and ignores the shebang.
On Unix, npm sets the executable bit (`0o755`) on files listed in the `bin` field when
installing the package, so `chmod +x dist/index.js` is not required as a build step either.

**No new file needed. No postbuild script needed.**

### 4.2 ESM vs CJS

`"type": "module"` means all `dist/*.js` files are treated as ESM. The compiled output from
`tsc` with `"module": "NodeNext"` (or `"ES2022"`) is already ESM. The `bin` entry points to
`dist/index.js` which is ESM. This is correct.

The SEA build uses CJS (`dist/sea-bundle.cjs`) as Node.js SEA requires CommonJS. That path is
irrelevant for the npm package -- the npm package ships ESM `dist/*.js` files.

### 4.3 Dynamic Imports

`src/index.ts` uses dynamic `await import('./cli/install.js')` etc. (lines 49-128). These are
standard ESM dynamic imports and work correctly when `node dist/index.js` is invoked via npm bin.

### 4.4 Windows bin resolution

npm creates two shims on Windows:
- `apra-fleet.cmd`: `@node "%~dp0\node_modules\.bin\..\..\dist\index.js" %*`
- `apra-fleet.ps1`: `node ... dist/index.js @args`

No special handling is needed. The shim calls `node` explicitly with the absolute path to
`dist/index.js`.

---

## 5. Dependencies and Native Modules

### 5.1 Current dependencies (all in `dependencies`)

All six packages (`@inquirer/password`, `@modelcontextprotocol/sdk`, `smol-toml`, `ssh2`,
`uuid`, `zod`) are already in `dependencies` and will be installed by npm. No changes needed.

### 5.2 ssh2 and cpu-features

`ssh2` has an optional native addon `cpu-features` for accelerated crypto. It is excluded from
the SEA build (`build-sea.mjs:52`) because SEA cannot bundle native `.node` addons.

For npm:
- `cpu-features` is an optional peer dependency of ssh2 (not in apra-fleet's package.json)
- npm will attempt to build it during `ssh2` installation if build tools are present
- ssh2 gracefully degrades if `cpu-features` is absent (try/catch around the require)
- **No action required.** Users without native build tools still get working SSH.

### 5.3 No other native addons

Confirmed: no `node-pty`, `better-sqlite3`, `keytar`, or other native addons are used anywhere
in `src/`. The credential store uses Node.js built-in `crypto` module (AES-256-GCM,
`credential-store.ts`), not keytar.

### 5.4 devDependencies remain dev-only

`esbuild`, `postject`, `typescript`, `vitest` stay in `devDependencies`. They are never needed
at runtime. The `prepublishOnly` script calls `tsc` which IS a devDependency -- that is correct
because `prepublishOnly` runs in the package author's environment before publishing, not in the
installer's environment.

---

## 6. Asset-Path Correctness

This is the highest-risk area for npm packaging. Analysis follows.

### 6.1 Path resolution mechanism

`install.ts:63-70` (`findProjectRoot`):
```ts
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'version.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find project root (version.json not found)');
}
```

Where `__dirname` = `fileURLToPath(import.meta.url)` dirname (install.ts:59-60).

**For npm global install:**
```
__dirname = /usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/cli/
hop 1:    /usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/
hop 2:    /usr/local/lib/node_modules/@apra-labs/apra-fleet/       <-- version.json IS here
```
Result: `findProjectRoot()` returns the npm package root. **WORKS.**

**For npx (temporary install):**
```
__dirname = ~/.npm/_npx/<hash>/node_modules/@apra-labs/apra-fleet/dist/cli/
```
Same 2-hop traversal finds `version.json`. **WORKS.**

### 6.2 Asset directories

`buildDevManifest(root)` (install.ts:89-112) reads these relative to `root`:
- `hooks/` (install.ts:91) -- must be in `files`
- `scripts/` (install.ts:95) -- must be in `files`
- `skills/pm/` (install.ts:99) -- must be in `files`
- `skills/fleet/` (install.ts:100) -- must be in `files`
- `agents/` (install.ts:102) -- must be in `files`

All are covered by the `files` whitelist in Section 3.

`version.ts:20` reads `version.json` from `join(__dirname, '..')` where `__dirname` is the
`dist/` directory. For npm: `dist/../version.json` = package root `version.json`. **WORKS.**
`version.json` must be in `files`.

### 6.3 Scripts that exclude .mjs

`buildDevManifest` skips `.mjs` files in `scripts/` (install.ts:96):
```ts
if (entry.endsWith('.mjs')) continue; // skip build scripts
```
Build scripts (`build-sea.mjs`, `gen-sea-config.mjs`, `package-sea.mjs`, `install-hooks.mjs`,
`add-shebang.mjs`) are excluded. Good -- they should not be in the npm package either.
However, to be safe, add `!scripts/*.mjs` exclusion to `files` or simply rely on the fact
that the `files` whitelist already excludes scripts not in `dist/`.

Wait -- the `files` whitelist of `"scripts/"` would include ALL files in `scripts/`, including
the `.mjs` build scripts. This wastes space but is harmless since `buildDevManifest` skips them.
Consider a more targeted whitelist:
```json
"files": [
  "dist/",
  "hooks/",
  "skills/",
  "agents/",
  "version.json",
  "scripts/fleet-statusline.sh",
  "scripts/agy-settings-merge.js",
  "scripts/agy-transcript-reader.js"
]
```
This avoids shipping 7 build-only `.mjs` files. Tradeoff: must update `files` when new runtime
scripts are added.

Alternatively, keep `"scripts/"` for simplicity and accept the minor bloat (~30KB).

### 6.4 Service manager binary path (BLOCKER)

`src/services/service-manager/windows.ts` creates a `.bat` wrapper pointing to the installed
binary. The binary path comes from `BIN_DIR` (config.ts:9 -> `~/.apra-fleet/bin/`).

In SEA install: the binary is copied to `~/.apra-fleet/bin/apra-fleet[.exe]` (install.ts:549).
The service manager points to this copy.

In npm install: no binary copy happens (gated on `isSea()`, install.ts:544). The binary is
`node dist/index.js` (via npm's shim). The service manager must be told to invoke the npm-
installed command: `apra-fleet start` (relying on PATH) or the full path from `process.argv[1]`
(the dist/index.js file) with `process.execPath` (the node binary).

This is discussed further in Section 8 (code changes needed).

---

## 7. Cross-Platform

### 7.1 bin/PATH on Unix

npm creates `<prefix>/bin/apra-fleet` as a symlink to `dist/index.js`. If `<prefix>/bin` is on
PATH (which it is after `npm i -g` or `nvm`), `apra-fleet install` works directly.

On macOS/Linux the shebang (`#!/usr/bin/env node`) ensures the script is invoked with node.

### 7.2 bin/PATH on Windows

npm creates `<prefix>\apra-fleet.cmd` which calls `node` explicitly. `<prefix>` is typically
`%APPDATA%\npm` which is on PATH by default after a standard Node.js Windows install.

### 7.3 OS service registration

Service registration is a runtime operation (`apra-fleet install`), not a packaging concern.
The packaging concern is ensuring the service manager is invoked correctly from npm mode.

- **Windows**: `schtasks` command exists on all Windows versions. Task Scheduler service is
  always running. No admin required for `/rl limited` tasks. **OK.**
- **Linux**: `systemctl --user` requires systemd (unavailable on some older distros). Same
  requirement exists today for the SEA binary. **OK.**
- **macOS**: `launchctl` always available. **OK.**

### 7.4 Shell scripts in hooks/ and scripts/

`hooks/post-register-member.sh` and `scripts/fleet-statusline.sh` are shell scripts. They run
correctly on Linux/macOS. On Windows, the install code already adds a `bash ` prefix:
```ts
const command = process.platform === 'win32' ? `bash "${scriptPath}"` : scriptPath;
// install.ts:257
```
This requires Git for Windows (bash) or WSL to be installed. Same requirement exists today.
**No change needed.**

### 7.5 Platform assumptions

`src/os/` directory contains OS-specific command builders for linux.ts, macos.ts, windows.ts.
These are invoked via `getOsCommands()` based on `process.platform`. No platform assumptions
that differ between SEA and npm mode.

---

## 8. Code Changes Required

Three source code changes are needed to achieve full feature parity. These are minimal and
surgical.

### 8.1 Change 1: Remove isSea() gate from service registration

**File:** `src/cli/install.ts:507`
**Current:**
```ts
const serviceStep = isSea() && transport === 'http';
```
**Change to:**
```ts
const serviceStep = transport === 'http';
```

This allows the OS service registration step to run in npm mode.

For the service manager to register the correct binary path, the install logic must also detect
whether it is running from an npm global install and supply the right command. The service
manager currently uses `binaryPath` (set from `process.execPath` copy in SEA mode, install.ts:549).

For npm mode, set `binaryPath` to the resolved `apra-fleet` command:
```ts
if (!isSea()) {
  // npm mode: use the node binary + dist/index.js as the service command
  binaryPath = process.argv[1]; // absolute path to dist/index.js
}
```
Then update the service manager to accept either a standalone binary path OR a
`node <scriptPath>` pair. Windows.ts and linux.ts already construct the exec path -- they need
to handle a node-invoked script if `binaryPath` ends in `.js`.

### 8.2 Change 2: Remove isSea() gate from binary copy step

**File:** `src/cli/install.ts:544`
**Current:**
```ts
if (isSea()) {
  console.log(`  [1/${totalSteps}] Installing binary...`);
  // ... copy binary
} else {
  console.log(`  [1/${totalSteps}] Dev mode -- skipping binary copy`);
}
```
**Change to:**
```ts
if (isSea()) {
  console.log(`  [1/${totalSteps}] Installing binary...`);
  // ... copy binary (existing code)
} else if (isNpmGlobalInstall()) {
  console.log(`  [1/${totalSteps}] npm global install detected -- skipping binary copy`);
  // binary is managed by npm; record node path for service manager
  binaryPath = process.argv[1]; // dist/index.js absolute path
} else {
  console.log(`  [1/${totalSteps}] Dev mode -- skipping binary copy`);
}
```

`isNpmGlobalInstall()` can be a simple heuristic: check whether `process.argv[1]` is under
a path containing `node_modules` and NOT under the repo's own `dist/`.

### 8.3 Change 3: Redirect self-update for npm mode

**File:** `src/cli/update.ts:10`
Before the current update logic, add an npm detection branch:
```ts
if (!isSea()) {
  const mgr = isNpmGlobalInstall() ? 'npm update -g @apra-labs/apra-fleet' : 'npm install';
  console.log(`apra-fleet is running under Node.js (npm install).`);
  console.log(`To update, run:  ${mgr}`);
  return;
}
```

This prevents the update command from attempting to download a SEA binary for a user who
installed via npm. The npm update path is handled by the package manager.

### 8.4 Change 4: Fix version.ts for ESM (npm mode)

**File:** `src/version.ts` -- the dev fallback at lines 16-42 uses `require('node:fs')`
and bare `__dirname` (CJS idioms). In the tsc ESM output these symbols do not exist, so
the require() call throws a ReferenceError that is caught, and the function returns
`'v0.0.0-unknown'`. Result: `apra-fleet --version` prints `apra-fleet v0.0.0-unknown`
for npm installs.

**Fix:** add an ESM-compatible path before the CJS fallback:
```typescript
// After the BUILD_VERSION check, before the require()-based fallback:
try {
  // ESM path (tsc output for npm)
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const vf = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8'));
  return `v${vf.version}`;
} catch { /* fall through to CJS path */ }
```

Since `resolveVersion()` is a synchronous function today, the cleanest approach is to
detect ESM via `typeof __dirname === 'undefined'` at module level and compute the path
with `import.meta.url` instead. The exact refactor is left to the implementor; the
important outcome is that npm-installed users see the correct semver from `version.json`
rather than `v0.0.0-unknown`.

This is a low-risk one-function change to `src/version.ts`.

---

## 9. SEA and npm Coexistence

Both distribution methods must continue to work simultaneously.

| Concern | SEA binary | npm package |
|---|---|---|
| Entry binary | `apra-fleet.exe` / `apra-fleet` (SEA) | `node dist/index.js` via npm shim |
| Version | `BUILD_VERSION` injected by esbuild | `version.json` read at startup |
| Asset loading | `sea.getAsset()` from embedded blob | `fs.readFile()` from npm package dir |
| Service binary path | `~/.apra-fleet/bin/apra-fleet[.exe]` | `process.argv[1]` (dist/index.js) |
| Self-update | Downloads new SEA installer from GitHub | `npm update -g @apra-labs/apra-fleet` |
| Offline install | YES (all assets embedded) | NO (npm requires network for install) |
| Install path | `~/.apra-fleet/bin/` | npm global prefix |
| Update cadence | Manual (`apra-fleet update`) | `npm update -g` or dependabot |

The two can coexist on the same machine. They write to the same `~/.apra-fleet/data/` directory
(registry, credentials, server.json), so only one instance should run at a time. If both are
installed, the OS PATH order determines which `apra-fleet` command is invoked.

Recommendation: document that users should choose one delivery mechanism per machine. The SEA
binary takes priority if it is on PATH before the npm bin directory.

---

## 10. Step-by-Step: First Publish

### Pre-requisites
- Node.js 22+ on the publishing machine
- `npm login` with an account that has write access to `@apra-labs` org on npmjs
- GitHub repo: Apra-Labs/apra-fleet

### Steps

**Step 1: Apply the four code changes**
- Edit `src/cli/install.ts` (Changes 1 and 2 in Section 8)
- Edit `src/cli/update.ts` (Change 3 in Section 8)
- Edit `src/version.ts` (Change 4 in Section 8)
- Edit `package.json` (all fields in Section 3)

**Step 2: Build**
```bash
npm install
npm run build   # runs tsc
```
Verify `dist/index.js` starts with `#!/usr/bin/env node` (preserved from src/index.ts:1).

**Step 3: Dry-run pack**
```bash
npm pack --dry-run
```
Confirm the output lists:
- `dist/` (all compiled JS)
- `hooks/hooks-config.json` and `hooks/post-register-member.sh`
- `scripts/fleet-statusline.sh` and other runtime scripts (NOT `.mjs`)
- `skills/pm/**` and `skills/fleet/**`
- `agents/*.md`
- `version.json`
- NOT: `src/`, `tsconfig.json`, `*.mjs`, `node_modules/`

Check tarball size: should be under ~5MB without the SEA binary in dist/.

**Step 4: Test npx locally before publish**
```bash
npm pack   # creates apra-labs-apra-fleet-0.2.1.tgz
npm install -g ./apra-labs-apra-fleet-0.2.1.tgz
apra-fleet --version
apra-fleet install --llm claude --transport http
apra-fleet status
apra-fleet --help
```

**Step 5: Test npx from tgz (simulates remote install)**
```bash
npx ./apra-labs-apra-fleet-0.2.1.tgz --version
```

**Step 6: Publish to npm**
```bash
npm publish --access public
```
For first publish of a scoped package, `--access public` is required. Subsequent publishes
pick up `publishConfig.access: "public"` from package.json.

**Step 7: Verify on a clean machine**

On each target platform (or in a clean VM/container):
```bash
# Verify npx (no prior install)
npx @apra-labs/apra-fleet --version

# Verify global install
npm install -g @apra-labs/apra-fleet
apra-fleet --version
apra-fleet install --llm claude --transport http
apra-fleet status
```

**Step 8: Set up npm provenance (optional but recommended)**

Add to publish workflow:
```bash
npm publish --access public --provenance
```
Requires running from a GitHub Actions workflow with `id-token: write` permission. Adds a
Sigstore attestation link on the npm package page.

---

## 11. Test Matrix

| Test | Win x64 | Linux x64 | macOS arm64 |
|---|---|---|---|
| `npx @apra-labs/apra-fleet --version` | [ ] | [ ] | [ ] |
| `npx @apra-labs/apra-fleet --help` | [ ] | [ ] | [ ] |
| `npm i -g @apra-labs/apra-fleet` | [ ] | [ ] | [ ] |
| `apra-fleet install --llm claude --transport http` | [ ] | [ ] | [ ] |
| `apra-fleet install --llm gemini --transport stdio` | [ ] | [ ] | [ ] |
| `apra-fleet status` (after install) | [ ] | [ ] | [ ] |
| `apra-fleet start` / `stop` / `restart` | [ ] | [ ] | [ ] |
| MCP server responds to list-tools (stdio) | [ ] | [ ] | [ ] |
| MCP server responds to list-tools (HTTP) | [ ] | [ ] | [ ] |
| `apra-fleet install --skill fleet` | [ ] | [ ] | [ ] |
| `apra-fleet install --skill pm` | [ ] | [ ] | [ ] |
| `apra-fleet auth` (OOB auth flow) | [ ] | [ ] | [ ] |
| `apra-fleet update` (shows npm redirect) | [ ] | [ ] | [ ] |
| `apra-fleet uninstall` | [ ] | [ ] | [ ] |
| Skills installed at provider config dir | [ ] | [ ] | [ ] |
| Hooks installed at provider config dir | [ ] | [ ] | [ ] |
| OS service auto-starts on login | [ ] | [ ] | [ ] |
| SSH execute_command via registered member | [ ] | [ ] | [ ] |
| Credential store set/list/delete | [ ] | [ ] | [ ] |
| SEA binary still works alongside npm install | [ ] | [ ] | [ ] |

---

## 12. Conclusion

**Feature parity: YES with caveats.**

All 25 MCP tools, all 8 CLI commands, both MCP transports (stdio and HTTP/SSE), all 5 LLM
providers, credential store, SSH execution, OOB auth, fleet skill/PM skill/agent installation,
hooks, scripts, and OS service lifecycle are deliverable via npm without architectural changes.

The four required code changes are surgical and low-risk:
1. Remove `isSea()` gate from service registration (`install.ts:507`)
2. Remove `isSea()` gate from binary copy step; record npm binary path (`install.ts:544`)
3. Redirect `apra-fleet update` to `npm update -g` for npm users (`update.ts:10`)
4. Fix `src/version.ts` ESM fallback so `--version` shows actual semver, not
   `v0.0.0-unknown` (version.ts:16-42, one-function refactor)

Note: no shebang injection script is needed -- `src/index.ts:1` already has
`#!/usr/bin/env node` and `tsc` preserves it in `dist/index.js`.

The asset-path resolution (`findProjectRoot()`, `install.ts:63-70`) already works correctly
for npm installs without modification, as long as `version.json`, `hooks/`, `scripts/`,
`skills/`, and `agents/` are in the `files` whitelist.

**Risks:**
- Medium: Service manager binary path detection in npm mode requires careful testing per OS.
  The service `.bat`/unit file must point to `node dist/index.js`, not a standalone binary.
- Low: `cpu-features` native addon build may fail on environments without build tools.
  ssh2 degrades gracefully, so this is a performance concern only.
- Low: `--force` process kill uses binary name detection (install.ts:334,344). In npm mode,
  the running server is a `node` process. Mitigation: extend `server.json` with a PID field
  and use that for targeted kill instead of process-name scan.
- Low: `npx` caches the package globally. Users running `npx @apra-labs/apra-fleet` repeatedly
  will always get the cached version until `npx --yes @apra-labs/apra-fleet@latest` is used.
  Document this in the README.
- Low: `npm update -g` does NOT refresh skills/hooks already copied into `~/.claude/skills/`,
  `~/.apra-fleet/hooks/`, etc. Those are written by `apra-fleet install`, not by the package
  manager. After any npm update, the user must re-run `apra-fleet install` to pick up new
  skill content. Recommend printing this reminder in the npm-mode update redirect message
  (see change 3 in Section 8) and in the `npm publish` post-install notes.

---

## 13. Release-pipeline npm publishing (lockstep with binaries)

### 13.1 Current release workflow

The release pipeline lives in `.github/workflows/ci.yml`. It has five jobs:

| Job | Runs on | Trigger | Purpose | Lines |
|-----|---------|---------|---------|-------|
| `build-and-test` | matrix (ubuntu, macos, windows) | push to main, tags `v*`, PRs | `npm ci && npm run build && npm test` | ci.yml:23-68 |
| `package` | ubuntu-latest | after build-and-test | Creates release tarball (dist/ + skills/ + hooks/ + install.sh + version.json) | ci.yml:70-124 |
| `build-binary` | matrix (ubuntu, macos, windows) | after build-and-test | Builds SEA binaries per platform via `build-sea.mjs`, `gen-sea-config.mjs`, `package-sea.mjs` | ci.yml:126-201 |
| `sign-windows` | windows-latest (environment: signing) | after build-binary, only on tags `v*` | Azure Trusted Signing of the Windows `.exe` | ci.yml:203-243 |
| `release` | ubuntu-latest | after package + build-binary + sign-windows, only on tags `v*` | Downloads all artifacts, creates GitHub Release with binaries + tarball via `softprops/action-gh-release` | ci.yml:245-306 |

**Trigger**: the release job runs only when `startsWith(github.ref, 'refs/tags/v')` (ci.yml:247).
The entire workflow triggers on tag pushes matching `v*` (ci.yml:7).

**Version injection**: the `build-binary` job writes the tag version into `version.json`
before building the SEA bundle (ci.yml:154-160):
```yaml
TAG="${GITHUB_REF#refs/tags/v}"
node -e "...v.version='${TAG}';fs.writeFileSync('version.json',JSON.stringify(v,null,2))"
```
This means `BUILD_VERSION` (injected by `build-sea.mjs:26`) picks up the tag version.

The `package` and `release` jobs read `version.json` for the tarball name (ci.yml:91-101,
ci.yml:269-275) but do NOT inject the tag -- they read whatever is committed. This is a
pre-existing divergence risk if someone forgets to bump `version.json` before tagging.

### 13.2 Proposed npm publish job

Add a new job `npm-publish` to `.github/workflows/ci.yml`, running after `build-and-test`
succeeds (same gate as the other release jobs). It runs in parallel with `build-binary` and
`package` since it is independent:

```yaml
npm-publish:
  needs: build-and-test
  if: startsWith(github.ref, 'refs/tags/v')
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write    # required for npm provenance attestation
  environment: npm      # optional: use a GitHub environment for deployment protection rules
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Setup Node.js 22.x
      uses: actions/setup-node@v4
      with:
        node-version: 22.x
        registry-url: https://registry.npmjs.org

    - name: Install dependencies
      run: npm ci

    - name: Inject version from tag
      run: |
        TAG="${GITHUB_REF#refs/tags/v}"
        node -e "
          const fs = require('fs');
          const pkg = JSON.parse(fs.readFileSync('package.json','utf-8'));
          const ver = JSON.parse(fs.readFileSync('version.json','utf-8'));
          pkg.version = '${TAG}';
          ver.version = '${TAG}';
          fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
          fs.writeFileSync('version.json', JSON.stringify(ver, null, 2) + '\n');
        "
        echo "Injected version: ${TAG}"

    - name: Version lockstep guard
      run: |
        TAG="${GITHUB_REF#refs/tags/v}"
        PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).version)")
        VER_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('version.json','utf-8')).version)")
        echo "Tag=$TAG  package.json=$PKG_VER  version.json=$VER_VER"
        if [ "$TAG" != "$PKG_VER" ] || [ "$TAG" != "$VER_VER" ]; then
          echo "::error::Version mismatch! tag=$TAG package.json=$PKG_VER version.json=$VER_VER"
          exit 1
        fi

    - name: Build
      run: npm run build

    - name: Verify shebang
      run: head -1 dist/index.js | grep -q '^#!/usr/bin/env node'

    - name: Dry-run pack verification
      run: |
        npm pack --dry-run 2>&1 | tee pack-output.txt
        # Verify critical files are included
        grep -q 'dist/index.js' pack-output.txt
        grep -q 'version.json' pack-output.txt
        grep -q 'hooks/hooks-config.json' pack-output.txt
        grep -q 'skills/pm/' pack-output.txt || grep -q 'skills/fleet/' pack-output.txt
        echo "Pack verification passed"

    - name: Check if version already published
      id: check-published
      run: |
        TAG="${GITHUB_REF#refs/tags/v}"
        if npm view @apra-labs/apra-fleet@${TAG} version 2>/dev/null; then
          echo "already_published=true" >> "$GITHUB_OUTPUT"
          echo "::warning::Version ${TAG} is already published to npm -- skipping publish"
        else
          echo "already_published=false" >> "$GITHUB_OUTPUT"
        fi

    - name: Publish to npm
      if: steps.check-published.outputs.already_published == 'false'
      run: npm publish --access public --provenance
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 13.3 npm authentication recommendation

**Recommend: `NPM_TOKEN` repo secret + `--provenance`** (OIDC attestation on the published
package, not OIDC for authentication).

Rationale:
- npm "trusted publishing" (OIDC-based auth, no token needed) is still in beta as of
  mid-2026 and requires a package-level configuration on npmjs.org that couples the GitHub
  repo to the npm package permanently. It does not yet support scoped packages from
  organizations reliably.
- `NPM_TOKEN` (automation-type token, stored as a GitHub repo secret) is the battle-tested
  approach. Combined with `--provenance` and `id-token: write`, the published package gets
  a Sigstore attestation linking it to the exact GitHub commit, without needing OIDC for
  the auth itself.
- Use a GitHub Environment (`environment: npm`) with required reviewers if the team wants
  deployment approval gates.

Token setup: `npm token create --cidr 0.0.0.0/0` -> store as `NPM_TOKEN` in
Settings > Secrets and variables > Actions > Repository secrets.

### 13.4 Version lockstep -- the single biggest risk

**How versions are set today:**

| Artifact | Version source | Cite |
|----------|---------------|------|
| SEA binary `BUILD_VERSION` | esbuild `define` reads `version.json` + git hash (build-sea.mjs:20-26) | build-sea.mjs:20-26 |
| `version.json` at tag time | Injected from tag in `build-binary` job (ci.yml:154-160) | ci.yml:157-159 |
| `package.json` version | Static in repo (package.json:3) -- NOT injected from tag today | package.json:3 |
| Release tarball name | Reads `version.json` + git hash (ci.yml:91-101) | ci.yml:97-98 |

**The gap**: `package.json:version` is set manually in the repo and never synced from the
tag. Today this does not matter because `package.json` is not published to npm. Once we
publish to npm, the tag, `version.json`, and `package.json` MUST all agree.

**Proposed guard** (shown in the workflow above, step "Version lockstep guard"):
1. The `npm-publish` job injects the tag version into BOTH `package.json` and `version.json`
   before building (so the npm package always matches the tag).
2. A subsequent step verifies all three agree. If they diverge, the job fails with a clear
   error message.

Additionally, add a pre-tag CI check (can run on all pushes to main):
```yaml
    - name: Warn on version mismatch
      if: github.ref == 'refs/heads/main'
      run: |
        PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).version)")
        VER_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('version.json','utf-8')).version)")
        if [ "$PKG_VER" != "$VER_VER" ]; then
          echo "::warning::package.json ($PKG_VER) and version.json ($VER_VER) disagree -- fix before tagging"
        fi
```

### 13.5 Idempotency and safety

**Already-published version**: the "Check if version already published" step (above) runs
`npm view @apra-labs/apra-fleet@${TAG} version`. If the version exists on npm, it sets
`already_published=true` and the publish step is skipped. npm itself also rejects duplicate
publishes with HTTP 403, so this is a belt-and-suspenders guard.

**Dry-run verification**: the "Dry-run pack verification" step runs `npm pack --dry-run`,
captures the file listing, and greps for critical files (`dist/index.js`, `version.json`,
`hooks/hooks-config.json`, `skills/`). This catches cases where the `files` whitelist is
misconfigured before the irreversible publish step.

**Partial release (binaries up, npm failed)**:
- The `npm-publish` job runs in parallel with `build-binary` and `release`. If npm publish
  fails but binaries succeed, the GitHub Release will exist with binary assets but no npm
  package. This is safe: SEA users are unaffected, and the npm package simply does not
  exist for that version.
- To retry: re-run the failed `npm-publish` job from the GitHub Actions UI. The
  already-published check ensures it is safe to re-run.
- If the npm publish succeeded but the release job failed (binaries not uploaded): the npm
  package exists but GitHub Release is incomplete. Fix by re-running the `release` job. The
  npm package version is already correct and does not need republishing.
- npm does NOT support overwriting a published version (even with `--force`). If a bad
  version is published, the only recourse is `npm unpublish @apra-labs/apra-fleet@<ver>`
  within 72 hours, then re-publish. Design the workflow to minimize this risk via the
  dry-run and lockstep checks.

### 13.6 Job dependency graph (final)

```
build-and-test (matrix: ubuntu/macos/windows)
  |
  +--> package (ubuntu)
  |      |
  +--> build-binary (matrix: ubuntu/macos/windows)
  |      |
  |      +--> sign-windows (windows, only on v* tags)
  |      |
  +--> npm-publish (ubuntu, only on v* tags)  <-- NEW
  |
  +--> release (ubuntu, only on v* tags, needs: package + build-binary + sign-windows)
```

`npm-publish` does NOT gate `release` and `release` does NOT gate `npm-publish`. They are
independent consumers of the same `build-and-test` gate. A failure in one does not block
the other.

---

## 14. SEA + npm coexistence -- validation and guards

### 14.1 Shared state analysis

Both delivery modes read and write the same directories under `~/.apra-fleet/`:

| Path | Written by | Read by | Collision risk |
|------|-----------|---------|----------------|
| `~/.apra-fleet/data/server.json` | HTTP server startup (index.ts:248-257) | singleton.ts:48-71, service-manager stop | **LOW** -- singleton lock prevents double-start |
| `~/.apra-fleet/data/server.lock` | claimStartupLock() (singleton.ts:73-108) | Same function | **NONE** -- atomic `wx` flag |
| `~/.apra-fleet/data/registry.json` | register_member tool | All member-facing tools | **NONE** -- single JSON file, always from the running server |
| `~/.apra-fleet/data/credentials/` | credential_store_set tool | credential read tools | **NONE** -- encrypted at rest, server-session-keyed |
| `~/.apra-fleet/data/install-config.json` | install.ts:175-183 | update.ts:76-90, uninstall.ts:250 | **LOW** -- see below |
| `~/.apra-fleet/data/fleet.log` | server + CLI commands | `status`, stall detector | **NONE** -- append-only |
| `~/.apra-fleet/bin/apra-fleet[.exe]` | SEA install (install.ts:548-550) | Service manager .bat/unit, start.ts | **MEDIUM** -- npm never writes here |
| `~/.apra-fleet/hooks/` | install.ts:560-568 | LLM CLI (via hooks-config.json) | **LOW** -- last writer wins |
| `~/.apra-fleet/scripts/` | install.ts:572-579 | statusline command | **LOW** -- last writer wins |
| `~/.claude/skills/pm/` | install.ts:666-676 | LLM CLI skill loader | **LOW** -- last writer wins |
| `~/.claude/skills/fleet/` | install.ts:647-659 | LLM CLI skill loader | **LOW** -- last writer wins |
| `~/.claude/settings.json` | install.ts MCP/hooks/permissions merge | Claude Code | **LOW** -- additive merge, idempotent |

**What breaks if BOTH are installed and the server runs from each alternately:**

1. **Registry and credentials**: completely shared. No collision. The registry is a JSON
   file keyed by member name. Credentials use server-session AES-256-GCM keys that are
   per-process (credential-store.ts:11), so session-scoped credentials from one process
   are unreadable by the other -- but persistent credentials (using the master key at
   `~/.apra-fleet/data/.credential-key`) are shared and readable by both. No conflict.

2. **Single-instance assumption**: the HTTP server checks `server.json` and the startup
   lock at `singleton.ts:47-108`. If SEA server is running and an npm-mode server tries to
   start, `checkRunningInstance()` sees the existing PID, confirms it is alive via the
   `/health` endpoint, and the new server exits cleanly (index.ts:233-235). The lock file
   (`server.lock`) uses exclusive `wx` file creation (singleton.ts:81) -- atomic on all
   OSes. **No port collision possible** as long as both use the same `DEFAULT_PORT` from
   `paths.ts:6` (7523), which they do.

3. **install-config.json**: `writeInstallConfig()` (config.ts:175-183) uses a
   `providers` map keyed by LLM provider name. Running `apra-fleet install --llm claude`
   from both SEA and npm writes the same key (`claude`) with the same skill mode. The
   `installedAt` timestamp reflects the last install. No conflict -- last writer wins,
   and the data is equivalent.

### 14.2 OS service registration collision

Each platform uses a **single, fixed service name** (types.ts:2-4):

| Platform | Service name | Registration file |
|----------|-------------|-------------------|
| Windows | `ApraFleet` (schtasks task name) | `~/.apra-fleet/bin/apra-fleet-service.bat` |
| Linux | `apra-fleet.service` (systemd user unit) | `~/.config/systemd/user/apra-fleet.service` |
| macOS | `com.apra-fleet.server` (launchd plist label) | `~/Library/LaunchAgents/com.apra-fleet.server.plist` |

**Collision behavior**: if a user runs `apra-fleet install` from the SEA binary (which
registers a service) and then runs `apra-fleet install` from the npm package (which today
skips the service step because of the `isSea()` gate at install.ts:507):

- **Today**: no collision. The npm install never touches the service. The SEA service
  continues to run, pointing to `~/.apra-fleet/bin/apra-fleet[.exe]`.
- **After proposed change (Section 8.1, removing the isSea() gate)**: the second install
  OVERWRITES the service registration with a new `ExecStart` / `.bat` / plist pointing to
  `node <npm-package-dist/index.js>`. This is the desired behavior -- last install wins --
  but it can surprise a user who did not intend to switch.

**Tracing the overwrite behavior per platform:**

- **Linux**: `LinuxServiceManager.register()` (linux.ts:22-48) writes the unit file with
  `fs.writeFileSync(UNIT_PATH, unit)`, then `daemon-reload` + `enable`. A second call
  with a different `binaryPath` simply replaces the unit file. **One service, last
  writer wins.**

- **macOS**: `MacOSServiceManager.register()` (macos.ts:57-62) calls
  `launchctl bootout` (to remove old registration if any), writes the plist, then
  `launchctl bootstrap`. **One service, last writer wins.**

- **Windows**: `WindowsServiceManager.register()` (windows.ts:12-21) writes
  `apra-fleet-service.bat` with the new binary path, then `schtasks /create ... /f` (the
  `/f` flag forces overwrite). **One service, last writer wins.**

**Proposed guard**: before registering, the install command should check if a service is
already registered and log which exec path it points to. If the current install would
change the exec path, warn the user:

```
Warning: An existing apra-fleet service is registered pointing to:
  /home/user/.apra-fleet/bin/apra-fleet --transport http
This install will overwrite it to:
  /usr/bin/node /usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/index.js --transport http
Proceed? The running server will be restarted.
```

Implementation: read the existing unit/bat/plist file, extract the current `ExecStart`
or command line, compare with the new `binaryPath`. If different, print the warning.
This is a low-risk change in install.ts within the service registration step.

### 14.3 Version and mode reporting

**Current `apra-fleet status` output** (status.ts:53-86):

```
apra-fleet status
  State:    running
  PID:      12345
  Port:     7523
  URL:      http://localhost:7523/mcp
  Version:  v0.2.2_abc123
  Uptime:   1h 23m 45s
  Sessions: 2
  Service:  installed (enabled)
```

**Missing**: no indication of delivery mode (SEA vs npm) or binary path. A user with both
installed cannot tell which one is running.

**Proposed enhancement**: add `Mode` and `Binary` lines to the status output:

```
apra-fleet status
  State:    running
  Mode:     npm (node v22.12.0)        # or: SEA binary
  Binary:   /usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/index.js
  PID:      12345
  ...
```

Implementation in `status.ts`:
- Detect mode: `require('node:sea').isSea()` in a try/catch. If true -> "SEA binary".
  If false -> "npm (node <process.version>)".
- Binary path: `process.execPath` for SEA (the binary itself), or
  `process.argv[1]` for npm (the dist/index.js script).
- Additionally, the `/health` endpoint response (queried at status.ts:75) could include
  `mode` and `execPath` fields, set at server startup time. This allows `apra-fleet status`
  to report these even when running from a different delivery mode than the server.

### 14.4 PATH precedence and uninstall interactions

**PATH precedence (both installed):**

| Platform | SEA path | npm path | Who wins? |
|----------|---------|----------|-----------|
| Linux/macOS | `~/.apra-fleet/bin/apra-fleet` (added to shell profile by install.sh) | `/usr/local/bin/apra-fleet` (npm global) or `~/.nvm/versions/node/v22/bin/apra-fleet` | Depends on PATH order; typically npm global dir comes first |
| Windows | `%USERPROFILE%\.apra-fleet\bin\apra-fleet.exe` (added to User PATH) | `%APPDATA%\npm\apra-fleet.cmd` (npm global) | User PATH is searched after System PATH; npm's dir is typically earlier |

**Risk**: the user types `apra-fleet --version` and sees the npm version, but the OS
service is still running the SEA binary. The status output (with the proposed Mode/Binary
enhancement from 14.3) makes this diagnosable.

**Uninstall interactions:**

**Scenario A: npm uninstall, SEA service still registered**

`npm uninstall -g @apra-labs/apra-fleet` removes the npm package and its bin shim. The
SEA binary at `~/.apra-fleet/bin/apra-fleet` is unaffected. The OS service (if registered
by SEA) still points to the SEA binary. `apra-fleet` CLI now resolves to the SEA binary
on PATH. **No breakage.**

**Scenario B: `apra-fleet uninstall` from SEA, npm package still installed**

`apra-fleet uninstall --force --yes` (uninstall.ts:159-338):
1. Stops the running server via service manager (uninstall.ts:234-237)
2. Unregisters the OS service (uninstall.ts:246-248): calls `svcMgr.unregister()`
3. Cleans up MCP registration, settings, hooks, permissions per provider (uninstall.ts:273-306)
4. Removes `~/.apra-fleet/bin/`, `~/.apra-fleet/hooks/`, `~/.apra-fleet/scripts/` (uninstall.ts:310-321)
5. Removes install-config.json (uninstall.ts:324-327)

The npm package at `node_modules/@apra-labs/apra-fleet/` is untouched. However, the MCP
server registration is removed from Claude settings. If the user wants to use the npm
version, they must re-run `apra-fleet install` from the npm binary.

**Risk**: `apra-fleet uninstall` does not distinguish which delivery mode's artifacts to
remove. It removes ALL fleet artifacts regardless of origin. This is correct behavior for
a "full uninstall" but could surprise a user who intended to uninstall only the SEA side.

**Proposed guard**: `apra-fleet uninstall` could accept a `--mode sea` or `--mode npm`
flag. However, this adds complexity for a rare scenario. The simpler approach: document
that `apra-fleet uninstall` removes all fleet artifacts, and users should re-run
`apra-fleet install` from their preferred delivery mode afterward.

**Self-update correctness:**

**SEA `apra-fleet update`**: downloads a new SEA binary installer from GitHub releases and
spawns it with `--force` (update.ts:94-96). This replaces `~/.apra-fleet/bin/apra-fleet`,
re-registers the service, and re-installs skills. It does NOT touch the npm package. If
both are installed, the SEA self-update changes the SEA binary and (if the service was
SEA-registered) re-registers the service to point to the new SEA binary. **npm install
is unaffected.**

**npm update (`npm update -g @apra-labs/apra-fleet`)**: replaces the npm package files.
Does NOT touch `~/.apra-fleet/bin/` (SEA binary) or the OS service registration. The
running server (if started from the service) continues running the old binary until
restarted. **SEA install is unaffected.**

**Critical note**: `npm update -g` does NOT run `apra-fleet install`. Skills, hooks,
scripts, and agent files copied to `~/.claude/skills/`, `~/.apra-fleet/hooks/`, etc.
are NOT refreshed. The user MUST run `apra-fleet install` after an npm update to get
new skill content. The npm-mode update redirect message (Section 8, change 3) should
print:

```
apra-fleet is installed via npm. To update:
  npm update -g @apra-labs/apra-fleet
  apra-fleet install           # re-install skills, hooks, and scripts
```

### 14.5 Coexistence test matrix

| Scenario | Action | Expected result | Win | Linux | macOS |
|----------|--------|----------------|-----|-------|-------|
| **SEA-only install** | `./installer install` | Binary in ~/.apra-fleet/bin, service registered, skills installed, --version shows SEA mode | [ ] | [ ] | [ ] |
| **npm-only install** | `npm i -g @apra-labs/apra-fleet && apra-fleet install` | No binary in ~/.apra-fleet/bin, service registered (after Section 8 change), skills installed, --version shows npm mode | [ ] | [ ] | [ ] |
| **Both installed (SEA first)** | SEA install, then npm global install + `apra-fleet install` | Service re-registered to npm exec path (with warning), skills refreshed, `apra-fleet` on PATH resolves to npm (usually) | [ ] | [ ] | [ ] |
| **Both installed (npm first)** | npm install + `apra-fleet install`, then SEA install | Service re-registered to SEA binary path (with warning), skills refreshed, SEA binary on PATH depends on order | [ ] | [ ] | [ ] |
| **SEA-only: start/stop/status** | `apra-fleet start/stop/status` | Server starts/stops correctly, status shows SEA mode | [ ] | [ ] | [ ] |
| **npm-only: start/stop/status** | `apra-fleet start/stop/status` | Server starts/stops correctly, status shows npm mode | [ ] | [ ] | [ ] |
| **Both: only one server runs** | Start from SEA, try start from npm | Second start detects running instance and exits cleanly (singleton.ts:47-71) | [ ] | [ ] | [ ] |
| **Both: port conflict** | N/A (DEFAULT_PORT is shared) | Second server exits, no port bind error | [ ] | [ ] | [ ] |
| **SEA update, npm installed** | `apra-fleet update` (from SEA) | Downloads new SEA binary, re-installs to ~/.apra-fleet/bin, npm package untouched | [ ] | [ ] | [ ] |
| **npm update, SEA installed** | `npm update -g @apra-labs/apra-fleet` | npm package updated, SEA binary untouched, service still points to SEA (if SEA-registered) | [ ] | [ ] | [ ] |
| **npm uninstall, SEA still installed** | `npm uninstall -g @apra-labs/apra-fleet` | npm removed, SEA binary still on PATH, service (if SEA-registered) still works | [ ] | [ ] | [ ] |
| **`apra-fleet uninstall`, npm still installed** | `apra-fleet uninstall --force --yes` | All fleet artifacts removed (bin, hooks, scripts, skills, service, MCP config). npm package still at node_modules but non-functional until `apra-fleet install` re-run | [ ] | [ ] | [ ] |
| **Both after update: version agreement** | Update both to same release tag | `apra-fleet --version` shows same semver regardless of which binary runs | [ ] | [ ] | [ ] |
| **npm update without re-install** | `npm update -g`, do NOT re-run `apra-fleet install` | Server works (dist/ is updated), but skills/hooks in ~/.claude may be stale | [ ] | [ ] | [ ] |
| **Registry/credential sharing** | Register member via SEA server, query via npm server (or vice versa) | Member visible from both, persistent credentials readable by both | [ ] | [ ] | [ ] |

### 14.6 Coexistence conclusion

**PASS -- with four proposed guards:**

1. **Service overwrite warning** (Section 14.2): detect when a new install would change the
   service exec path and warn the user before overwriting. Implementation: ~15 lines in
   install.ts, reading the existing unit/bat/plist file.

2. **Mode reporting in status** (Section 14.3): add `Mode` and `Binary` fields to
   `apra-fleet status` output. Implementation: ~10 lines in status.ts + 5 lines in
   the health endpoint response.

3. **Post-update skill refresh reminder** (Section 14.4): the npm-mode update redirect
   message in update.ts must remind users to re-run `apra-fleet install`. This is part
   of the Section 8 change 3 implementation.

4. **Self-update mode guard** (Section 8 change 3, validated here): `apra-fleet update`
   from npm mode prints `npm update -g` instead of downloading a SEA binary. From SEA
   mode it behaves as today. Neither mode corrupts the other's installation.

Without these guards, coexistence is technically possible (the singleton lock and shared
data dir prevent corruption) but confusing to diagnose. With the guards, both modes can
live side-by-side safely. The recommended posture is: **pick one delivery mode per
machine**, but if both are present, the system degrades gracefully with clear diagnostics.
