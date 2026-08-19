# fleet-supervisor self-containment audit (apra-fleet-qqof.1)

## Goal

Confirm the always-on fleet-sprint supervisor is fully self-contained in an
installed apra-fleet (npm install or SEA binary) with NO git-clone of the
source repo required. The entry point is `bin/serve.mjs`; the supervisor code
lives under `src/supervisor/*`.

A finding is any import or fs-read on a supervisor-reachable code path that
resolves to a repo-root-relative or source-only location the deploy/install
packaging does NOT ship.

## Method

1. Walk the STATIC import graph (plus string-literal dynamic imports) starting
   from `bin/serve.mjs`, resolving every relative/absolute specifier and
   flagging any that climbs out of the packaged `apra-fleet-se` tree.
2. Scan every reachable module for runtime fs-reads / spawn / `createRequire` /
   template dynamic imports keyed off a repo-root assumption.
3. Cross-check the reachable set against what packaging actually ships:
   `scripts/gen-sea-config.mjs` `collectPackageTree(packages/apra-fleet-se,
   'fleet-sprint')` (SEA) and the same manifest driving `apra-fleet install`
   (`src/cli/install.ts` buildDevManifest -> `src/cli/workflow-assets.ts`
   extractWorkflowSubsystemAssets). The packaging exclude set is
   `PACKAGE_TREE_EXCLUDE_DIRS = {test, docs, scripts, examples}`, applied
   recursively at every directory depth.

## Result: fully self-contained

The static import graph from `bin/serve.mjs` reaches 41 modules. ALL 41 resolve
inside `packages/apra-fleet-se/`, and NONE live under an excluded directory
(`test`/`docs`/`scripts`/`examples`) -- so every reachable module ships in both
the SEA package tree and the `apra-fleet install` tree. There are no remaining
out-of-tree imports and no unresolved specifiers.

The only runtime fs-read of a source-tree file on a reachable path is
`fleet-sprint/contracts.mjs`'s vendored-schema loader (`resolveSchemasDir()`).
Its first candidate (`dist/agents/schemas`, a build artifact) is source/build
only, but it is a GUARDED candidate: the loader falls back to the package-local
`apra-pm/agents/schemas` (which ships inside the packaged tree, `schemas` is not
an excluded dir) and, failing that, to hand-written literal schemas. So it never
hard-depends on a source-only path.

apra-fleet-n4lu.1 (vendoring `scripts/lib/exec-bd.mjs` into
`src/supervisor/lib/exec-bd.mjs`) is a strict subset of this audit: that file is
reachable (via `backlog.mjs` and `scope-overlap.mjs`), ships in-tree, and is not
re-broken. No additional code relocation is required by this task -- the audit's
job was to prove the WHOLE reachable graph (not just the two n4lu files) is
install-safe, and to add a durable guard so a future regression in ANY
supervisor module is caught.

## Enumeration: every supervisor-reachable module and its packaged-tree status

All paths are relative to `packages/apra-fleet-se/`. Status legend: `SHIPS` =
present in the installed/packaged tree (not under an excluded dir).

### Entry + spawn vehicle

| Module | Status |
| --- | --- |
| `bin/serve.mjs` | SHIPS |
| `bin/cli.mjs` (per-sprint detached child, resolved via `../../bin/cli.mjs`) | SHIPS |

### Supervisor core (`src/supervisor/*`)

| Module | Status |
| --- | --- |
| `src/supervisor/api.mjs` | SHIPS |
| `src/supervisor/backlog.mjs` | SHIPS |
| `src/supervisor/dashboard.mjs` | SHIPS |
| `src/supervisor/dolt-mutex.mjs` | SHIPS |
| `src/supervisor/dolt-orphan-sweep.mjs` | SHIPS |
| `src/supervisor/fleet-members.mjs` | SHIPS |
| `src/supervisor/history-view.mjs` | SHIPS |
| `src/supervisor/history.mjs` | SHIPS |
| `src/supervisor/id-allocator.mjs` | SHIPS |
| `src/supervisor/launch-form.mjs` | SHIPS |
| `src/supervisor/ledger.mjs` | SHIPS |
| `src/supervisor/lib/exec-bd.mjs` (n4lu.1 vendored copy) | SHIPS |
| `src/supervisor/log-timestamp.mjs` | SHIPS |
| `src/supervisor/log-view.mjs` | SHIPS |
| `src/supervisor/proxy.mjs` | SHIPS |
| `src/supervisor/readopt.mjs` | SHIPS |
| `src/supervisor/reconcile.mjs` | SHIPS |
| `src/supervisor/rename-with-retry.mjs` | SHIPS |
| `src/supervisor/scope-overlap.mjs` | SHIPS |
| `src/supervisor/self-log.mjs` | SHIPS |
| `src/supervisor/server.mjs` | SHIPS |
| `src/supervisor/spawner.mjs` | SHIPS |
| `src/supervisor/watchdog.mjs` | SHIPS |

### fleet-sprint modules imported by the supervisor

| Module | Status |
| --- | --- |
| `fleet-sprint/conflict-ladder.mjs` | SHIPS |
| `fleet-sprint/contracts.mjs` | SHIPS (schema loader is graceful-degradation; see above) |
| `fleet-sprint/dolt-settle.mjs` | SHIPS |
| `fleet-sprint/dolt-sync.mjs` | SHIPS |
| `fleet-sprint/errors.mjs` | SHIPS |
| `fleet-sprint/runner.js` | SHIPS |
| `fleet-sprint/sprint-lock.mjs` | SHIPS |
| `fleet-sprint/sprint-progress.mjs` | SHIPS |
| `fleet-sprint/vcs-module.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/index.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/azure-devops.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/bitbucket.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/dolt.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/generic-git.mjs` | SHIPS |
| `fleet-sprint/vcs-providers/github.mjs` | SHIPS |
| `fleet-sprint/viewer-extensions.mjs` | SHIPS |

## Regression guard

`test/qqof-supervisor-selfcontained-audit.test.mjs` builds a REAL installed tree
(the same `buildDevManifest()` / `extractWorkflowSubsystemAssets()` path
`apra-fleet install` uses) and walks the full static import graph from the
installed `bin/serve.mjs`, asserting every resolved module stays inside the
installed tree. Unlike `n4lu2-packaged-supervisor-boot.test.mjs` (which pins the
two n4lu files and boots serve.mjs), this guard covers the ENTIRE reachable
graph, so a future out-of-tree import from ANY supervisor module fails the test.
