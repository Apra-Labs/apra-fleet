# Workflow Subsystem Plan: `apra-fleet workflow <name>` from the SEA binary

Status: PROPOSED (architecture plan for the next sprint; input to the planner agent)
Date: 2026-07-13
Branch context: feat/fleet-reorg

## 0. Existing beads overlap (sanity pass, `bd list` run 2026-07-13)

- **`apra-fleet-3ns.6` (P3, open)** -- "SEA binary: embed new auto-sprint
  (dist/auto-sprint.mjs + runner asset + schemas) as SEA assets". This plan
  **supersedes and absorbs** that bead: it answers exactly the investigation
  3ns.6 asked for (extraction destination = `~/.apra-fleet/workflows/` +
  `~/.apra-fleet/node_modules/`; server resolution = `APRA_FLEET_SERVER_BIN`
  pointing at the installed binary, as 3ns.6 itself predicted). The planner
  should close/replace 3ns.6 with this plan's Phase 1-2 tasks, or make it the
  parent of them -- do not create a duplicate parallel epic.
- **`apra-fleet-dv5.*` (P1/P2, open)** -- tier-based model selection touches
  `packages/apra-fleet-se/auto-sprint/runner.js` and `pricing.mjs`. No scope
  overlap, but a **file-level collision risk**: this plan installs verbatim
  copies of those same files. Sequencing note for the planner: land dv5's
  runner.js edits either before or after this epic's install-payload tasks;
  the install mechanism copies whatever is in the repo, so no rework either
  way -- just avoid two concurrent sprints editing runner.js.
- No other open bead mentions the `workflow` subcommand, `~/.apra-fleet/workflows`,
  or hello-world. `apra-fleet-3ns.2` (bundle SE into npm package) is CLOSED and
  is prior art this plan builds on.

## 0.1 Latent bug discovered while researching (file as its own bead)

The **published npm package's `auto-sprint` bin is broken at sprint-runtime**
in a clean global install: `dist/auto-sprint-runner.mjs` (a verbatim copy of
`packages/apra-fleet-se/auto-sprint/runner.js`, loaded via
`engine.executeFile()` -> dynamic `import()`) statically imports
`@apralabs/apra-fleet-workflow` (private, never published -- unresolvable from
the global npm tree) and `./contracts.mjs` / `./errors.mjs` (not copied into
`dist/` by `scripts/bundle-se.mjs`). The CI smoke test only runs
`auto-sprint --help`, which exercises the esbuild-bundled `dist/auto-sprint.mjs`
(where esbuild inlined those imports for the CLI's own use) and exits before
`executeFile()` ever runs, so this was never caught. The mechanism this plan
builds (a real on-disk import graph under `~/.apra-fleet/`) is the same fix
shape the npm mode needs; the planner should file a separate bug bead for the
npm-mode gap (fix: `bundle-se.mjs` also copies `contracts.mjs`, `errors.mjs`,
`viewer-extensions.mjs` into `dist/` and pre-bundles or vendors the workflow/
client packages next to the runner -- or simply reuses this plan's
runtime-tree layout). It is NOT a blocker for this plan.

---

## 1. Architecture decision: how the SEA binary runs a workflow with no system Node

### Ground truth (verified in code)

- `WorkflowEngine.executeFile(scriptPath, args)` (packages/apra-fleet-workflow/
  src/workflow/engine.mjs:78-100) reads the file for advisory vetting, then
  loads it as a **real ES module via dynamic `import(pathToFileURL(path))`**
  and calls its exported `main`/`run`/`default`. No `vm.Script`, no subprocess.
  Workflow scripts are trusted code with full Node privileges.
- Therefore a workflow's `runner.js` import graph (bare specifier
  `@apralabs/apra-fleet-workflow`, relative `./contracts.mjs`, `./errors.mjs`,
  third-party `ajv`) is resolved by **Node's normal ESM resolver from the
  runner's on-disk location** -- whatever we do must make that resolution work.
- The SEA binary embeds a full Node 22 runtime. Its injected main
  (`dist/sea-bundle.cjs`) always runs first; `process.execPath` is the binary
  itself, so `spawn(process.execPath, [script])` does NOT run `script` -- it
  re-runs the embedded main with `script` as argv. Any "run a file" path must
  go through code we control inside the bundle.
- Error classes cross the engine/workflow boundary by `instanceof`
  (`runner.js` imports `AgentOutputError`, `CommandError` from
  `@apralabs/apra-fleet-workflow`; `FleetWorkflow` throws them). **Any design
  that loads two copies of the workflow package (one bundled into
  sea-bundle.cjs, one on disk for the runner) silently breaks every
  `instanceof` check.** This is the decisive constraint.

### Options evaluated

**(a) Bundle engine + client + contracts into `dist/sea-bundle.cjs`; only the
workflow file itself loads from disk.**
Rejected. The on-disk `runner.js` still `import`s
`@apralabs/apra-fleet-workflow` at module level; to satisfy that we would
need an on-disk copy anyway -> two copies of `errors.mjs` -> `instanceof`
breakage between engine-thrown and runner-caught errors (the exact class of
bug apra-fleet-unw.16 fixed for role casing). Avoiding it would require
rewriting runner.js to receive error classes via context -- a behavioral
change to a heavily-tested file, violating the "no instability" constraint.
Also bloats and entangles the core server bundle.

**(b) SEA binary spawns itself as the fleet server; engine runs in the parent
from the bundle.** Same dual-copy problem as (a) for the engine half; the
self-spawn part is still valuable and is kept (see below).

**(c) RECOMMENDED: "import trampoline + on-disk runtime tree".**
The SEA bundle gains a tiny, isolated launcher (`src/cli/workflow.ts`) that:

1. Resolves `<name>` under `~/.apra-fleet/workflows/<name>/` (manifest
   `workflow.json` -> `entry`), self-extracting built-ins from SEA assets if
   absent.
2. Sets environment defaults (only when not already set by the user):
   - `APRA_FLEET_SERVER_BIN` = the installed binary path
     (`BIN_DIR/apra-fleet[.exe]`), falling back to `process.execPath` under
     SEA -- so `resolveFleetServerCommand()` (packages/apra-fleet-se/bin/
     cli.mjs:51-84) spawns the SEA binary itself with
     `run --transport stdio`, which the embedded main already supports
     (src/index.ts `run` case). This is exactly the mechanism
     apra-fleet-3ns.6 anticipated.
   - `APRA_FLEET_SE_SCHEMAS_DIR` = `~/.apra-fleet/schemas` (tier 1 of
     `resolveSchemasDir()`, contracts.mjs:151-175 -- zero code change needed
     in contracts.mjs).
3. Rewrites `process.argv` to `[execPath, <entryAbsPath>, ...passthroughArgs]`
   and then does `await import(pathToFileURL(entryAbsPath))`.
   - `cli.mjs`'s `isMainModule()` guard (`import.meta.url ===
     pathToFileURL(process.argv[1]).href`, cli.mjs:622-628) then evaluates
     TRUE and its own `main()` self-executes with `parseArgs` seeing exactly
     the user's pass-through args. **Zero changes to cli.mjs, runner.js,
     contracts.mjs, or the engine.**
   - Contract for workflows that do not self-execute: if the imported module
     did not run (exports `main`/`run`/`default` and no side effects), the
     launcher calls that export with the raw args array. (hello-world
     demonstrates the self-executing form, which is the documented primary
     convention.)
4. **Every** module in the workflow's graph -- engine, client, contracts,
   runner, ajv -- loads through the one on-disk ESM loader: single copy of
   every class, no `instanceof` hazard, byte-identical files to what CI tests
   in the monorepo.

Bare-specifier resolution is made to work **idiomatically**, not with a
loader hook: the installer populates `~/.apra-fleet/node_modules/` with
verbatim copies of `@apralabs/apra-fleet-workflow`, `@apralabs/apra-fleet-client`
(both pure-.mjs, no build step, no dependencies beyond ajv) and a vendored
`ajv` subtree (+ its 4 deps: `fast-deep-equal`, `fast-uri`,
`json-schema-traverse`, `require-from-string`). Node's upward `node_modules`
walk from `~/.apra-fleet/workflows/<name>/...` finds `~/.apra-fleet/node_modules/`
naturally. This is also what makes **user-authored** workflows work: any
script dropped in `~/.apra-fleet/workflows/<their-name>/` can
`import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine'` with
no npm and no Node install.

Why in-process `import()` in the parent rather than spawning a child: the
`workflow` subcommand is a terminal command (nothing runs after it); cli.mjs
already owns `process.exit`, signal handling, and the viewer server; a child
adds IPC/exit-code plumbing for no isolation benefit. The workflow's fleet
server IS still a child process (via `APRA_FLEET_SERVER_BIN` self-spawn), so
the MCP boundary is unchanged from today's npm mode.

**Hard invariant (called out explicitly, not left implicit in the reasoning
above): `apra-fleet workflow <name>` is ALWAYS a separate client process
from the `apra-fleet` MCP server it talks to.** The "in-process `import()`"
decision above only collapses the workflow-launcher/runner/engine code into
one process; it never collapses the launcher and the MCP *server* together.
**How that server is reached is transport-dependent, and the two modes
behave differently -- this was mischaracterized in an earlier draft of this
section as uniform self-spawn behavior, which is wrong:**

- **stdio transport (legacy/subprocess mode):** the launcher self-spawns its
  OWN fresh server child process via the `APRA_FLEET_SERVER_BIN` self-spawn
  (`run --transport stdio`) -- it never attaches to, shares, or reuses an
  already-running `apra-fleet` MCP session. This exactly mirrors how the
  existing npm-based `auto-sprint` bin (`packages/apra-fleet-se/bin/cli.mjs`,
  `resolveFleetServerCommand()`, lines ~51-84) already behaves today: it is a
  distinct client process connected only via its own private stdio pipe to a
  server instance it spawned itself.
- **streamableHTTP transport (the actual product default -- `install.ts:484-
  485` documents HTTP as default, stdio as legacy):** there is a persistent
  local singleton `apra-fleet` server already running as an installed OS
  service (`install.ts:914`, `svcMgr.register(..., ['--transport', 'http'],
  ...)`), listening at a fixed, well-known URL --
  `http://localhost:${DEFAULT_PORT}/mcp`, where `DEFAULT_PORT` is `7523` by
  default (overridable via `APRA_FLEET_PORT`; `src/paths.ts:6`). In this mode
  `apra-fleet workflow <name>` does **not** spawn a server at all -- it is a
  plain HTTP client (`packages/apra-fleet-client`'s already-implemented
  `StreamableHttpTransport`, `factory.mjs`/`transport.mjs`) that connects to
  that already-running singleton, the same one every other registered
  provider (Claude Code, Gemini, Codex, Copilot, etc.) is already talking to.
  Discovery/liveness works exactly the way `src/services/singleton.ts`
  already does it for the server's own startup-dedup: `~/.apra-fleet/data/
  server.json` holds `{pid, url}` written by the running instance;
  `checkRunningInstance()` validates the pid is alive and GETs
  `<url-with-/mcp-replaced-by-/health>` before trusting it, self-healing
  (deletes the stale file) if either check fails. The workflow launcher
  should reuse this exact check, not re-implement liveness detection.

**Known gap this creates (flag for the task breakdown, not yet resolved by
this doc):** `resolveFleetServerCommand()` in `packages/apra-fleet-se/bin/
cli.mjs` -- the function this plan's launcher design (Section 1, step 2)
said it would reuse/mirror -- currently implements ONLY the stdio-self-spawn
branch (4 resolution tiers, all producing `run --transport stdio` args).
It has no HTTP-mode branch. The launcher cannot simply "mirror" this
function as originally described; it needs its own resolution order that
(a) checks `checkRunningInstance()` first when HTTP is the configured/
default transport and connects directly if healthy, (b) falls back to the
existing stdio self-spawn path only when no healthy HTTP singleton is found
(e.g. running before `apra-fleet install`/`start` has ever launched the
service, or with `APRA_FLEET_TRANSPORT=stdio` forced). See R13 in the risk
register. This resolution-order decision, and whether it lives in a shared
helper `apra-fleet workflow` and `auto-sprint`'s `cli.mjs` both call, or is
duplicated, is an open design question for Phase 1/2 task authoring, not
decided here.

**RESOLVED (apra-fleet-7pm.6):** see `docs/adr-workflow-server-resolution.md`.
That ADR is binding on the `src/cli/workflow.ts` implementation task. In short:
(1) resolution order is forced-transport override -> `checkRunningInstance()`
HTTP-singleton probe (attach via `StreamableHttpTransport`, spawn nothing) ->
stdio self-spawn fallback (the existing 4 tiers); (2) the logic is ONE shared
helper, not duplicated -- it lives in
`packages/apra-fleet-client/src/client/server-resolution.mjs` (subpath export
`@apralabs/apra-fleet-client/server-resolution`), the only package both
consumers already depend on, and `checkRunningInstance()` /
`resolveFleetServerCommand()` delegate to it so the liveness check has exactly
one implementation.

Task authors/reviewers: do not propose merging the launcher and the MCP
*server* into one process -- that would be a structural change to the
separate-client-process invariant, not an implementation detail. The
open question is only *how* the client reaches the server (self-spawned
stdio vs. HTTP to an existing singleton), not *whether* they are separate
processes -- they always are.

**Mandatory Phase 1 spike (risk gate):** confirm on all 3 OS that dynamic
`import()` of on-disk ESM works from inside a SEA main script (Node docs
guarantee `createRequire` for CJS; dynamic `import()` from SEA is believed to
work on Node 22 but must be proven, including with `useCodeCache: true` as
currently set in gen-sea-config.mjs:130). Fallback if it fails: flip
`useCodeCache` off (measure startup delta), or as a last resort use
`module.createRequire` + a tiny on-disk ESM bootstrap started via
`node:worker_threads`. The spike lands before any dependent task starts.

Dev/npm mode parity: `apra-fleet workflow` must behave identically when run
via `node dist/index.js` (dev) or the npm global install -- the launcher's
resolution logic is delivery-mode-independent (it only reads
`~/.apra-fleet/...`); only the built-in extraction source differs (SEA asset
vs repo files), reusing the existing `extractAsset()` dev fallback
(install.ts:173-187).

### 1.1 Reconsideration: `apra-fleet workflow <name>` vs. telling users to run `node` directly

Raised by the project owner before sprint planning: is the launcher/subcommand
worth building, or should the plan just document
`node ~/.apra-fleet/workflows/<name>/<entry> [args]` and skip Section 3
entirely? Both options assume the SAME install-time payload (Section 2's
runtime tree + schemas dir) -- that part of the architecture is not in
question, only whether a dedicated subcommand sits on top of it.

**Pros / cons**

| Dimension | `apra-fleet workflow <name>` (launcher) | Raw `node <path>` |
|---|---|---|
| "No Node install required" claim | Holds for its intended audience (non-dev machines, ops boxes, CI runners with no Node) -- the embedded runtime runs the workflow with zero system Node. | Does not merely "weaken" the claim for users who already have Node -- it **eliminates the claim** as a product capability. Raw-node is a fine escape hatch for people who already have Node, but as the *only* mechanism it fails exactly the audience this feature exists for. It is not "only undermined for users who already have Node"; it is *unusable* for users who don't, which is the whole point of an SEA binary. |
| Discoverability/UX | `--list`, `--help`, uniform "workflow not found" error, tab-completion-friendly verb shape. | User must already know the exact installed path and entry filename; a typo'd path gives Node's raw `MODULE_NOT_FOUND` instead of an actionable message; no listing mechanism without inventing one anyway (which is most of the launcher's value). |
| Maintenance burden | New file (`src/cli/workflow.ts`), argv-rewrite/self-heal logic, CI smoke tests -- real but small (Section 10, Phase 2, ~3 tasks). | Near zero new code -- but only because it silently pushes the "how do I find/run this" problem onto documentation and the user, not because the problem goes away. |
| Interaction with the schema/dependency install already solved | Launcher sets `APRA_FLEET_SERVER_BIN` / `APRA_FLEET_SE_SCHEMAS_DIR` automatically (Section 5) -- a workflow author never has to know these env vars exist for the built-ins to work. | Still works IF the user (or workflow doc) sets the same two env vars, or the workflow ships its own `vendor/schemas` fallback (tier 3) -- auto-sprint happens to have this, but a bare user workflow that needs role schemas would silently get no schemas at all unless told to. The install-time payload doesn't change; only who is responsible for wiring it at run time does. |
| Versioning story | `.installed.json` records the installed runtime/workflow version; the launcher can detect and warn on a binary/runtime mismatch (R10). | No version check exists or is proposed -- a user who runs a stale `node <path>` after `apra-fleet update` refreshed the built-ins gets whatever is on disk with no diagnostic if it's inconsistent. |
| Command-family coherence | Fits a single `apra-fleet <verb>` mental model already used by `install`/`uninstall`/`update`/`run`. | Introduces a second, ungoverned invocation style (`node <long path>`) alongside the `apra-fleet` command family -- inconsistent with everything else in the CLI. |

Net technical read: raw-node is not actually a lighter-weight *substitute* for
the launcher's real job (making a workflow runnable with zero Node and zero
manual env wiring) -- it is only lighter-weight as a *replacement claim*
("run some node file") that quietly drops the requirement's hardest part.
Where raw-node genuinely wins is that it costs nothing to also support,
because the install payload (Section 2) already puts real, self-sufficient
files on disk -- nothing about the launcher design prevents `node
~/.apra-fleet/workflows/auto-sprint/bin/cli.mjs --help` from working today,
and it should keep working.

**Product-surface argument (project owner's point)**

The owner's argument -- that `apra-fleet workflow <verb>` (list/run/check/...)
establishes a coherent, extensible command family the way `git <verb>` /
`docker <verb>` do -- is a real product-value point, not just aesthetics. It
matters for reasons beyond taste:
- **Forward extensibility with no new top-level surface.** `workflow list`,
  `workflow check`, `workflow init` (scaffold a new user workflow from the
  hello-world template) all fit under one verb without inventing
  `apra-fleet list-workflows`, `apra-fleet check-workflow`, etc. -- the launcher
  built in this plan is already the right seam for that growth.
  Raw-node has no equivalent growth path; each new capability would need its
  own bespoke script and its own doc section.
  Note: this plan implements `--list`/`--help` as flags in v1 (Section 3),
  not `workflow list` as a subcommand-of-a-subcommand -- both make the same
  command-family argument. If the owner wants the `git`-style noun/verb form
  now rather than flags, that is a small syntax change to Section 3, not a
  structural one.
- **One pattern to document/support, not N.** Every future workflow --
  built-in or third-party -- is discovered, run, and errors the same way.
  Support/docs cost stays flat as the number of workflows grows; raw-node
  scales support cost linearly with the number of workflows (each needs its
  own "here's the exact command" doc snippet).
- **It does not conflict with the technical case -- it reinforces it.** The
  launcher was already required to satisfy "no Node install"; the product
  argument is a second, independent reason to build the same thing, not a
  tradeoff against it.

**Final recommendation: hybrid, launcher-primary, raw-node as a documented
escape hatch.**

Keep `apra-fleet workflow <name> [args]` exactly as designed in Sections 1-8
as the primary, documented, tested path -- it is the only mechanism that
satisfies the actual requirement (no system Node) and it is the correct
product surface per the argument above. Additionally, explicitly document
(not merely tolerate) that every installed workflow is a real file tree under
`~/.apra-fleet/workflows/<name>/` and can be run directly with a system
Node (`node ~/.apra-fleet/workflows/<name>/<entry> [args]`) for users who
already have Node and want to skip the wrapper for debugging/scripting --
this costs no extra code because Section 2's install payload is already
self-sufficient on disk (runtime tree + schemas + workflow-local
`vendor/schemas` fallback). `docs/authoring-workflows.md` (Section 4, Phase 3
task 10) gains one short subsection stating this explicitly, including the
caveat that raw-node invocation does not get the launcher's env-var
auto-wiring, `--list`, version check, or friendly errors -- so it is
positioned as an escape hatch, not an equally-supported alternative.

**Structural impact on the rest of the plan: none.** The architecture
decision (Section 1), file/asset inventory (Section 2), install/uninstall/
update integration (Section 6), build pipeline changes (Section 7), CI
verification (Section 8), risk register (Section 9), and the Phase 1-4 task
breakdown (Section 10) are unchanged -- they already assumed a self-sufficient
on-disk payload, which is what makes the escape hatch free. Only Section 3
(CLI surface) and Section 4 (hello-world/authoring doc) gain the explicit
"raw node also works, here's the caveat" documentation note; task 10 in
Section 10 (docs) now explicitly includes this subsection in its acceptance
criterion.

### Addendum (2026-07-13): R1 spike result -- dynamic `import()` from a SEA main WORKS

Recorded per Section 10 Phase 1 task 1 (`apra-fleet-7pm.1`), the hard risk gate
for R1. This addendum is the binding decision for the rest of the epic.

**Outcome: PASS on all 3 OS with `useCodeCache: true` retained. No fallback is
adopted.** The import-trampoline architecture in Section 1 stands as designed.

What was proven. `scripts/spike-sea-import.mjs` builds a throwaway SEA binary
through the same pipeline shape as the real one (`gen-sea-config.mjs` semantics
with `useCodeCache: true`, `postject` injection, the macOS codesign
remove/re-sign dance). The injected main does
`await import(pathToFileURL(<on-disk .mjs>))`, and that on-disk fixture in turn
*statically* imports both a bare specifier and a subpath export from a sibling
`node_modules/` -- mirroring the `~/.apra-fleet/node_modules/` runtime-tree
layout that Section 2 installs. The dynamic import resolved, the bare specifier
and the subpath export both resolved, and the fixture executed.

Where it ran. CI workflow `.github/workflows/spike-sea-import.yml`, matrix of
{ubuntu-latest, windows-latest, macos-latest} x {useCodeCache true, false} = 6
legs, all green (run 29291557051). The `useCodeCache: false` legs were kept as a
control to confirm the code cache is not load-bearing either way; since the
`true` legs pass, **no startup re-measurement is required and `useCodeCache`
stays `true`** (`scripts/gen-sea-config.mjs:130` is unchanged).

Consequences for downstream tasks:

- Fallback (a) -- flip `useCodeCache` off -- is **not** adopted; do not change
  that flag.
- Fallback (b) -- `module.createRequire()` + a `node:worker_threads` ESM
  bootstrap -- is **not** adopted; the extra indirection is unnecessary.
- Phase 1 task 4 (`gen-sea-config.mjs` asset embedding) and Phase 1 task 5
  (`install.ts` install step) proceed against the plain import-trampoline design:
  assets are extracted to a real on-disk tree and the launcher `import()`s the
  workflow entry directly. Bare specifiers resolve from the installed sibling
  `node_modules/`; no bundling of the runtime into the binary is needed.

## 2. File/asset inventory

Everything below is verified from actual imports (runner.js:1-8, cli.mjs:1-15,
contracts.mjs:38-43, workflow package.json exports, client package.json
exports, ajv package.json dependencies).

### 2.1 Installed layout (all new, purely additive)

```
~/.apra-fleet/
  node_modules/                              <- NEW shared workflow runtime
    @apralabs/
      apra-fleet-workflow/
        package.json                         (exports: ., ./engine, ./viewer, ./viewer/html-utils)
        src/workflow/{index,engine,errors,journal,pricing,vetting}.mjs
        src/viewer/{index,html-utils}.mjs
      apra-fleet-client/
        package.json                         (exports: ., ./client, ./factory, ./transport)
        src/client/*.mjs
    ajv/                                     (verbatim vendored subtree, dist/ + lib/ + package.json)
    fast-deep-equal/  fast-uri/  json-schema-traverse/  require-from-string/
  schemas/                                   <- NEW canonical installed schema dir
    <role>-input.json, <role>-output.json    (17 files, ~48 KB; source: vendor/apra-pm/agents/schemas)
  workflows/                                 <- NEW default workflow host dir
    .installed.json                          <- installer-owned manifest: {"version": "...", "builtin": ["auto-sprint","hello-world"]}
    auto-sprint/                             <- verbatim copy of packages/apra-fleet-se (minus test/, docs/, scripts/)
      workflow.json                          {"name":"auto-sprint","entry":"bin/cli.mjs","description":"Multi-cycle sprint: plan -> develop -> test -> harvest"}
      package.json                           (kept: type:module makes .js files ESM -- REQUIRED for runner.js)
      bin/cli.mjs
      auto-sprint/{runner.js,contracts.mjs,errors.mjs,viewer-extensions.mjs}
      vendor/schemas/*.json                  (belt-and-braces tier-3 hit for direct `node bin/cli.mjs` runs)
    hello-world/
      workflow.json                          {"name":"hello-world","entry":"main.mjs","description":"Minimal example workflow"}
      main.mjs
```

Notes:
- The auto-sprint dir preserves the package's own directory shape so
  `cli.mjs`'s relative `../auto-sprint/runner.js` and `resolveRunnerScriptPath()`
  dev branch work unmodified. `package.json` with `"type": "module"` MUST be
  included -- `runner.js` has a `.js` extension and is ESM.
- `resolveRunnerScriptPath()` finds `../auto-sprint/runner.js` relative to
  `bin/` (its existing dev-monorepo branch), and `engine.executeFile()` then
  imports it; its `./contracts.mjs` sibling exists; its bare
  `@apralabs/apra-fleet-workflow` resolves via the upward walk to
  `~/.apra-fleet/node_modules/`. Zero source changes.
- Schemas resolve via `APRA_FLEET_SE_SCHEMAS_DIR` (tier 1, set by launcher)
  -> `~/.apra-fleet/schemas`; without the launcher (direct node invocation),
  tier 3 (`<package>/vendor/schemas`) hits because `PACKAGE_ROOT` =
  `workflows/auto-sprint/`.

### 2.2 SEA-embedded assets (gen-sea-config.mjs additions)

New manifest sections (AssetManifest gains OPTIONAL keys so old manifests and
tests keep working): `workflowRuntime` (the two @apralabs packages + ajv
subtree, ~2.4 MB / ~200 files), `agentSchemas` (17 JSON files),
`builtinWorkflows` (auto-sprint package tree + hello-world, ~250 KB).
Sources at build time: `packages/apra-fleet-workflow/`, `packages/apra-fleet-client/`,
`node_modules/ajv` (+4 deps), `vendor/apra-pm/agents/schemas/`,
`packages/apra-fleet-se/`, plus a new `examples/workflows/hello-world/` in-repo
source dir. Dev-mode `buildDevManifest()` (install.ts:118-158) gains matching
collection so `node dist/index.js install` behaves identically from a checkout.

## 3. CLI surface

```
apra-fleet workflow <name> [args...]     Run ~/.apra-fleet/workflows/<name>
apra-fleet workflow --list               List installed workflows (name, description, builtin/user)
apra-fleet workflow --help               Launcher help (does NOT swallow <name> --help)
```

- **Pass-through args**: everything after `<name>` is handed to the workflow
  verbatim via the argv rewrite -- the launcher never re-parses them.
  `apra-fleet workflow auto-sprint --issue BD-1 --members m1 --branch f --base main`
  reaches cli.mjs's `parseCliArgs()` untouched; `apra-fleet workflow auto-sprint --help`
  prints auto-sprint's own usage.
- **Launcher-owned flags** appear only BEFORE `<name>` or when no name is
  given: `--list`, `--help`. No other launcher flags in v1 (keep the surface
  minimal = stable).
- **Resolution**: `~/.apra-fleet/workflows/<name>/workflow.json` ->
  `entry` (relative path, must resolve inside the workflow dir -- reject
  `..` escapes). If no `workflow.json`, fall back to first existing of
  `main.mjs`, `index.mjs`, `runner.js` (documented convention).
- **Errors**: unknown `<name>` -> exit 1 with
  `Error: workflow "<name>" not found in ~/.apra-fleet/workflows/.` plus the
  `--list` output; missing/invalid `workflow.json` entry -> exit 1 naming the
  file; workflow throws -> non-zero exit, stack to stderr.
- **Self-heal**: if `~/.apra-fleet/workflows/` or `~/.apra-fleet/node_modules/`
  is missing and the requested name is a built-in, extract built-ins +
  runtime + schemas from SEA assets on demand (same code path the installer
  uses), print one line saying so. This is what makes the CI smoke test
  possible without a full `install` run (which needs `claude` CLI etc.).
- **Escape hatch (documented, not a launcher feature)**: every resolved
  workflow is a real file tree at `~/.apra-fleet/workflows/<name>/`; a user
  with a system Node can always run it directly, e.g.
  `node ~/.apra-fleet/workflows/auto-sprint/bin/cli.mjs --help`. This is not
  additional code -- Section 2's install payload is already self-sufficient
  on disk -- but it does NOT get the launcher's env-var auto-wiring
  (`APRA_FLEET_SERVER_BIN`, `APRA_FLEET_SE_SCHEMAS_DIR`), `--list`, or the
  version-mismatch check (R10); document it plainly as a debug/power-user
  path, not a first-class alternative to `apra-fleet workflow <name>`. See
  Section 1.1 for the full pros/cons this decision is based on.

## 4. hello-world example (the authoring contract)

`examples/workflows/hello-world/` in-repo; installed to
`~/.apra-fleet/workflows/hello-world/`:

- `workflow.json`: `{ "name": "hello-world", "entry": "main.mjs",
  "description": "Minimal example workflow" }`
- `main.mjs` (self-executing ESM, ~30 lines) demonstrating the full contract:
  1. reads its args from `process.argv.slice(2)`;
  2. proves the shared runtime resolves with
     `import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';`
  3. prints `[OK] hello-world: args=<...> engine=<resolved|missing>` and
     exits 0. (No fleet server needed -- keeps the smoke test hermetic.)
- New doc `docs/authoring-workflows.md`: directory convention, workflow.json
  schema, entry contract (self-executing OR exported `main(args)`), the env
  vars the launcher sets (`APRA_FLEET_SERVER_BIN`,
  `APRA_FLEET_SE_SCHEMAS_DIR`), how to import the engine/client, how to
  connect to the fleet server (copy the StdioTransport/initialize sequence
  from cli.mjs:471-486), and the schema pattern for workflows that need
  role schemas (read `APRA_FLEET_SE_SCHEMAS_DIR`).

## 5. Schema installation fix

- Installer writes `vendor/apra-pm/agents/schemas/*.json` (SEA asset section
  `agentSchemas`; dev mode: submodule copy) to **`~/.apra-fleet/schemas/`**.
- The launcher sets `APRA_FLEET_SE_SCHEMAS_DIR=~/.apra-fleet/schemas` when
  unset -- this is contracts.mjs's existing tier-1 override
  (contracts.mjs:151-156), so **contracts.mjs is not modified at all** (the
  lowest-instability option among those in the requirement).
- Belt-and-braces: the auto-sprint workflow dir also carries
  `vendor/schemas/` (tier 3) so a direct `node bin/cli.mjs` invocation
  without the launcher still resolves; the hardcoded literals (tier 5,
  contracts.mjs section 3) remain the documented last-resort.
- Documented in authoring-workflows.md as THE pattern for third-party
  workflows needing schemas: read `APRA_FLEET_SE_SCHEMAS_DIR`, fall back to
  a workflow-local `vendor/schemas/`.

## 6. Install / uninstall / update integration

### install.ts (pure additions; existing steps 1-8 + agents/beads/service untouched)

One new step appended after the agents step, gated by a new
`--workflows <all|none>` flag defaulting to `all` (mirrors `--skill`; `--help`
text extended):

- `[N] Installing workflow runtime + built-in workflows...`
  1. Write `~/.apra-fleet/node_modules/` from manifest `workflowRuntime`
     (extract-to-temp-then-rename per package dir, with the EBUSY retry
     pattern from f66e621 on Windows).
  2. Write `~/.apra-fleet/schemas/` from manifest `agentSchemas`.
  3. For each built-in (`auto-sprint`, `hello-world`): `clearDirSync` ONLY
     that named subdir, then extract. NEVER `clearDirSync` the `workflows/`
     root. Update `workflows/.installed.json` with the built-in list +
     installed version.
- AssetManifest interface (install.ts:76-84) gains optional
  `workflowRuntime`, `agentSchemas`, `builtinWorkflows` keys; absence (older
  SEA build) skips the step with a warning -- forward/backward compatible.

### uninstall.ts

- `--skill` enum gains `workflows` (additive; `all` includes it):
  removes `~/.apra-fleet/node_modules/`, `~/.apra-fleet/schemas/`, and ONLY
  the workflow subdirs listed in `workflows/.installed.json` `builtin`;
  removes `workflows/` root only if empty afterwards, otherwise prints
  `kept user workflows: <names>`. `--dry-run` prints the same plan.

### update.ts

- No code change required for refresh: `runUpdate()` spawns the downloaded
  installer with `install --force --llm ... --skill ...` (update.ts:106-110),
  which re-runs the new step and refreshes built-ins in place while leaving
  user dirs untouched by construction. One addition: thread the installed
  `--workflows` mode through `install-config.json` (config.ts
  `writeInstallConfig`) the same way `skillMode` is persisted, so update
  preserves a `--workflows none` choice.

## 7. Build pipeline changes

- **`scripts/gen-sea-config.mjs`**: collect the three new sections with the
  existing `collectFiles()` helper; exclude `test/`, `docs/`, `scripts/`,
  `examples/` from package trees and `ajv`'s docs; hard-fail if
  `node_modules/ajv` or `vendor/apra-pm/agents/schemas` is missing (same
  pattern as the existing submodule guard at line 51-55). Emit new counts in
  the log and a **blob-size delta line** (assets total bytes) for CI eyeballing.
- **`scripts/build-sea.mjs`**: NO changes. The workflow runtime is
  deliberately NOT bundled into `sea-bundle.cjs` (that is the whole point of
  option (c)), so the `ssh2`/`cpu-features` externalization (build-sea.mjs:52)
  is untouched and no new esbuild conflicts can arise. Verified:
  apra-fleet-workflow deps = client + ajv; client deps = none; neither has
  native modules -- but they are shipped as files, not bundled, anyway.
- **`scripts/package-sea.mjs`**: NO changes (asset list comes from
  sea-config.json).
- **Size impact**: +~2.5 MB of assets (~200 files; ajv subtree dominates at
  ~2 MB) on a ~100 MB Node-based binary => <3% growth. No mitigation needed;
  the npm tarball is unaffected (nothing added to package.json `files`), so
  the npm-publish Clean-pack 10 MB guard is untouched.
- New `src/cli/workflow.ts` IS part of `sea-bundle.cjs` (imported lazily from
  `src/index.ts`'s dispatch like every other subcommand) -- a few KB.

## 8. CI verification (.github/workflows/ci.yml, build-binary job)

Add after "Smoke test - help" (ci.yml:239-241), all three matrix legs:

- **"Smoke test - workflow hello-world (no system Node)"** (bash shell):
  1. Create a temp `FAKEHOME`; run with `HOME=$FAKEHOME`,
     `USERPROFILE=$FAKEHOME` (Windows), `APRA_FLEET_DATA_DIR=$FAKEHOME/data`,
     and a **PATH stripped to OS essentials with the Node toolchain dirs
     removed** (`PATH=/usr/bin:/bin` on POSIX legs after asserting
     `! command -v node`; on Windows, a filtered `$env:PATH` minus the
     hosted-toolcache node dir). This is what makes the "no Node install
     required" claim meaningful on runners that always have Node: the binary
     may only use its embedded runtime, and any accidental `spawn('node')`
     fails loudly.
  2. `./dist/${{ matrix.binary }} workflow hello-world one two`
     (exercises the self-heal extraction path -- no `install` run needed,
     so no `claude` CLI / service-manager side effects on the runner).
  3. Assert stdout contains `[OK] hello-world: args=one,two engine=resolved`
     and exit code 0.
  4. Assert `$FAKEHOME/.apra-fleet/workflows/auto-sprint/auto-sprint/runner.js`
     and `$FAKEHOME/.apra-fleet/schemas/reviewer-output.json` exist
     (built-ins + schemas actually extracted).
- **"Smoke test - workflow arg/error surface"**: `workflow does-not-exist`
  exits 1 and names the workflows dir; `workflow --list` lists both built-ins.
- Optional (cheap, high value): `workflow auto-sprint --help` asserting
  cli.mjs's usage text prints and stderr has NO schema dev-fallback warning
  -- proving the full auto-sprint import graph (engine, client, ajv,
  contracts + installed schemas) loads inside the SEA runtime.

## 9. Risk register (maps to the "no instability" constraint)

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Dynamic `import()` unsupported/broken inside SEA main (possibly interacting with `useCodeCache: true`) | Phase 1 spike is a hard gate before all dependent tasks; fallbacks: disable useCodeCache (measure startup), or worker_threads bootstrap. Decision recorded in this doc. |
| R2 | Dual-copy `instanceof` breakage between engine and runner error classes | Eliminated by design: sea-bundle.cjs contains ZERO workflow-engine code; the entire graph loads once from disk. Guarded by the auto-sprint --help smoke test. |
| R3 | Regressing existing install steps | New install work is one appended step + optional manifest keys; existing steps 1-8 not reordered or edited. Unit tests via `_setManifestOverride` cover both old-manifest (keys absent) and new-manifest shapes. |
| R4 | `clearDirSync` wiping user-authored workflows on install/update | Only named built-in subdirs are cleared, driven by the static built-in list; `.installed.json` records ownership; uninstall deletes only listed built-ins; explicit unit test: a `workflows/my-custom/` dir survives install+uninstall. |
| R5 | Windows EBUSY/file-lock during refresh while a workflow is running | Extract-to-temp + rename per directory, retry loop (reuse f66e621 pattern); on persistent lock, warn and skip that built-in rather than failing the whole install. |
| R6 | Binary size bloat | +~2.5 MB (<3%); gen-sea-config logs the asset byte total; CI can eyeball; no bundling of workflow code into sea-bundle.cjs at all. |
| R7 | esbuild conflicts with ssh2/cpu-features | None possible: build-sea.mjs inputs are unchanged; runtime packages ship as verbatim files, not bundled. |
| R8 | Env vars leaking into/overriding user intent | Launcher sets `APRA_FLEET_SERVER_BIN` / `APRA_FLEET_SE_SCHEMAS_DIR` only when unset; user overrides always win (matches documented resolution orders). |
| R9 | Old SEA binary + new expectations (or vice versa) | Manifest keys optional both directions; `workflow` subcommand on a binary whose assets lack the sections prints an actionable "rebuild/reinstall" error. |
| R10 | Divergence between installed runtime copy and repo (stale `~/.apra-fleet/node_modules`) | `.installed.json` carries the version; launcher warns when the binary version != installed runtime version and suggests `apra-fleet install`. |
| R11 | Path length / spaces on Windows (`Program Files`-style homes, deep ajv paths) | All launcher paths built with `path.join` + `pathToFileURL`; ajv subtree depth is modest (<160 chars under `%USERPROFILE%`); CI Windows leg exercises the real extraction. |
| R12 | Concurrent `apra-fleet workflow` + `install --force` | Running-process guard already exists for the server (install.ts:596-615); document that install refresh skips locked built-ins (R5) rather than corrupting them. |
| R13 | `resolveFleetServerCommand()` (cli.mjs) is stdio-only; HTTP is the actual product default, so a naive "mirror cli.mjs" launcher would always self-spawn a private stdio server even when a healthy HTTP singleton is already running, defeating the "attach to what's already there" behavior users expect and doubling running server processes | Launcher resolution order: probe `checkRunningInstance()` (reuses `src/services/singleton.ts`'s pid+`/health` check against `~/.apra-fleet/data/server.json`) first when transport is HTTP/default; connect via `StreamableHttpTransport` on success; fall back to the existing stdio self-spawn path only if no healthy singleton is found. RESOLVED by `docs/adr-workflow-server-resolution.md` (apra-fleet-7pm.6): that resolution order is adopted, and the logic is ONE shared helper (`packages/apra-fleet-client/src/client/server-resolution.mjs`, subpath export `@apralabs/apra-fleet-client/server-resolution`) called by both `apra-fleet workflow` and `cli.mjs` -- not duplicated. |

## 10. Phased task breakdown (for the planner agent)

### Phase 1 -- Foundations: SEA import spike + asset/schema installation (must land first)

1. **[spike] Prove dynamic `import()` of on-disk ESM from a SEA binary.**
   Files: throwaway `scripts/spike-sea-import.mjs` + a temporary CI step (or
   local runs on win/linux/mac); result recorded as an addendum to this doc.
   AC: a packaged SEA binary (built with current `useCodeCache: true`)
   successfully `import()`s an on-disk .mjs that itself imports a bare
   specifier from a sibling `node_modules`, on all 3 OS -- or the fallback
   decision (useCodeCache off / worker bootstrap) is written down and adopted
   by tasks 4-5.
2. **[impl] gen-sea-config.mjs: embed workflow runtime, schemas, built-in
   workflows as SEA assets.** Files: `scripts/gen-sea-config.mjs`.
   AC: `dist/sea-manifest.json` gains `workflowRuntime`, `agentSchemas`,
   `builtinWorkflows` sections covering packages/apra-fleet-workflow,
   packages/apra-fleet-client, node_modules/ajv(+4 deps),
   vendor/apra-pm/agents/schemas, packages/apra-fleet-se (minus test/docs/
   scripts), examples/workflows/hello-world; build fails loudly if any source
   is missing; logged asset byte total appears.
3. **[impl] install.ts: additive workflow-install step (+ dev-manifest
   parity, + `--workflows` flag, + install-config persistence).** Files:
   `src/cli/install.ts`, `src/cli/config.ts`.
   AC: fresh SEA install produces the exact Section 2.1 layout; existing
   steps' console output and behavior byte-identical when `--workflows none`;
   a pre-existing `~/.apra-fleet/workflows/user-x/` dir is untouched; old
   manifests (keys absent) skip with a warning; unit tests via
   `_setManifestOverride` for both shapes.
4. **[impl] auto-sprint workflow packaging shape.** Files:
   `packages/apra-fleet-se/` (add `workflow.json`), installer copy rules in
   task 3. AC: installed `workflows/auto-sprint/` contains `package.json`
   (`type: module`), `bin/cli.mjs`, `auto-sprint/*.{js,mjs}`,
   `vendor/schemas/`, `workflow.json`; `node bin/cli.mjs --help` from that
   dir (with system node, as a dev check) prints usage with no schema
   fallback warning.

### Phase 2 -- CLI subcommand wiring

5. **[impl] `src/cli/workflow.ts` (new) + `src/index.ts` dispatch case.**
   AC: `apra-fleet workflow <name> [args...]` resolves workflow.json/entry,
   sets `APRA_FLEET_SERVER_BIN` + `APRA_FLEET_SE_SCHEMAS_DIR` (only when
   unset), rewrites argv, `import()`s the entry (calling exported
   main/run/default if the module did not self-execute); `--list` and
   unknown-name error behave per Section 3; entry path escaping the
   workflow dir is rejected; unit tests cover resolution, env-respect, and
   error paths with an injected fs/env seam.
6. **[impl] Self-heal extraction in workflow.ts.** Files:
   `src/cli/workflow.ts` (reusing extraction helpers factored out of
   install.ts without changing install.ts behavior).
   AC: with `~/.apra-fleet` empty, `apra-fleet workflow hello-world` (SEA)
   extracts runtime+schemas+built-ins, prints a one-line notice, and runs;
   a user workflow name that is not a built-in does NOT trigger extraction
   of itself (only of the shared runtime).
7. **[impl] hello-world example workflow.** Files: new
   `examples/workflows/hello-world/{workflow.json,main.mjs}`.
   AC: `apra-fleet workflow hello-world a b` prints
   `[OK] hello-world: args=a,b engine=resolved` and exits 0 with no system
   Node on PATH (verified manually pre-CI; CI task in Phase 4).

### Phase 3 -- Lifecycle + docs

8. **[impl] uninstall.ts: `--skill workflows` target (in `all`).** Files:
   `src/cli/uninstall.ts`. AC: removes `~/.apra-fleet/node_modules`,
   `~/.apra-fleet/schemas`, and only `.installed.json`-listed built-ins;
   user workflow dirs survive and are named in output; `--dry-run` accurate.
9. **[impl] update flow: refresh built-ins, preserve user workflows,
   persist `--workflows` mode.** Files: `src/cli/update.ts`,
   `src/cli/config.ts`, EBUSY retry in the install step (task 3 follow-up).
   AC: simulated update (install --force over an existing layout with one
   built-in modified and one user workflow present) restores the built-in
   and leaves the user dir untouched; Windows EBUSY on a locked built-in
   warns and skips rather than failing install.
10. **[docs] authoring-workflows.md (new) + deltas to docs/install.md,
    docs/npm-packaging.md, packages/apra-fleet-se/docs/cli-reference.md
    (schema/server resolution orders now include the installed-binary case).**
    AC: docs describe the Section 3/4/5 contracts exactly; install.md's
    directory table lists the three new dirs; authoring-workflows.md includes
    the Section 1.1/3 "raw node escape hatch" subsection with its caveats
    (no env auto-wiring, no `--list`, no version check); ASCII-only.
11. **[bug] (separate, non-blocking) npm-mode auto-sprint runtime imports
    broken in clean global install** (Section 0.1). Files:
    `scripts/bundle-se.mjs`, npm-publish smoke step.
    AC: a clean-prefix npm install can reach `engine.executeFile` without
    module-resolution errors (or the bead documents the chosen fix shape).

### Phase 4 -- CI proof

12. **[ci] build-binary smoke tests per Section 8.** Files:
    `.github/workflows/ci.yml`. AC: all three OS legs run
    `workflow hello-world` from the packaged artifact with Node stripped
    from PATH and an isolated HOME, asserting output, exit code, and
    extracted-file existence; `workflow does-not-exist` and
    `workflow --list` assertions; (optional step) `workflow auto-sprint
    --help` asserts usage text and no schema-fallback warning on stderr.
13. **[test] Regression guard: existing command surface unchanged.** Files:
    existing vitest suites + one new test file.
    AC: `install --help`, `uninstall --dry-run`, `run --transport stdio`
    handshake, and `--version` outputs are asserted unchanged vs current
    fixtures; full `npm test` green (1772+ baseline).
