<!-- llm-context: This document describes the auto-sprint workflow installation pipeline -- how auto-sprint.js is sourced from the apra-pm submodule, bundled into the SEA binary, and installed as cost.js (all providers) plus a ~/.claude/workflows/auto-sprint.js copy (Claude only) with appropriate permissions. -->
<!-- keywords: auto-sprint, cost.js, workflow, SEA asset, AssetManifest, PURE_FUNCTIONS_BEGIN, mergePermissions, vendor/apra-pm, install pipeline -->
<!-- see-also: ../architecture.md, ../install.md, ../npm-packaging.md -->

# Auto-Sprint Workflow Install Pipeline

## What it does

When a user runs `apra-fleet install --skill pm`, the installer writes a `cost.js`
file into the PM skill directory for every provider that supports PM. For Claude
specifically, the full `auto-sprint.js` workflow file is also copied into
`~/.claude/workflows/auto-sprint.js` so Claude Code can execute the sprint
accounting loop natively.

`cost.js` is a portable, CJS-wrapped extract of the pure cost-computation functions
from `auto-sprint.js`. It is safe to `require()` in any Node.js context.

## Architecture decisions

### Single source of truth: vendor/apra-pm submodule

`auto-sprint.js` lives in `vendor/apra-pm/.claude/workflows/`. The installer reads
from that path in dev/npm mode, or from an embedded SEA asset in binary mode. This
means cost functions stay in sync with the PM skill automatically -- updating the
submodule pin updates all three artifacts.

### PURE_FUNCTIONS_BEGIN / PURE_FUNCTIONS_END markers

The workflow file has a clearly delimited block of pure functions:

```
// PURE_FUNCTIONS_BEGIN
... DEFAULT_CALIBRATION, computeSprintQuote, etc. ...
// PURE_FUNCTIONS_END
```

The installer slices this block out and wraps it with a `module.exports` footer to
produce `cost.js`. If the markers are absent (e.g. an older submodule build), the
installer emits a warning and skips writing `cost.js` rather than crashing.

The seven exported functions are:
- `DEFAULT_CALIBRATION`
- `computeSprintQuote`
- `computeSprintAnalysis`
- `accumulateBucketTokens`
- `computeUpdatedCalibration`
- `buildSprintSummary`
- `reviewerModelFor`

### AssetManifest.workflows field

`AssetManifest` gained a `workflows: Record<string, string>` field alongside
`skills`, `agents`, etc. In dev/npm mode, `buildDevManifest` populates it from
`vendor/apra-pm/.claude/workflows/` (falling back to `dist/workflows/`). In SEA
mode, `gen-sea-config.mjs` embeds `auto-sprint.js` as a named SEA asset. The key
used for `getAsset()` is the filename directly (e.g. `auto-sprint.js`).

### npm / SEA dual-mode vendoring

`vendor-pm.mjs` (run as `prepublishOnly`) copies
`vendor/apra-pm/.claude/workflows/` to `dist/workflows/` before `npm pack`.
This ensures npm global installs -- where the submodule is absent -- still contain
the workflow file and can write `cost.js`. The same dist fallback logic applies in
`buildDevManifest` and in the Step 8 installer code.

### Provider-scoped permissions

- **Claude + PM**: `mergePermissions` receives `['Skill(auto-sprint)', 'Workflow(auto-sprint)']`
  so Claude Code's allow-list is updated to permit the skill and workflow.
- **All other providers**: `extraPerms` is empty; provider behavior is unchanged.
- **OpenCode**: `mergePermissions` is skipped entirely (OpenCode uses
  `--dangerously-skip-permissions` and per-agent frontmatter; a top-level
  `permissions` key is invalid in its config).

`mergePermissions(paths, extraPerms=[])` is an additive function -- it never
removes existing permissions. The `extraPerms` array is appended to the
provider-specific required permissions before deduplication.

## Install step sequence (PM install only)

```
Step 8: cost.js extraction + auto-sprint workflow copy
  1. Locate auto-sprint.js (SEA asset > vendor path > dist fallback)
  2. Slice PURE_FUNCTIONS_BEGIN..PURE_FUNCTIONS_END block
  3. Write cost.js to skillsDir for ALL providers with PM
  4. If llm == 'claude': write full auto-sprint.js to ~/.claude/workflows/
  5. After skill install: if llm != 'opencode': mergePermissions(paths, extraPerms)
```

## Invariants and constraints

- The PURE_FUNCTIONS_BEGIN/END markers in `auto-sprint.js` must not be renamed or
  removed; the installer depends on them.
- The list of exported names in `cost.js` is hardcoded in `install.ts`. If new
  functions are added to the pure block in `auto-sprint.js`, the export list must
  be updated in both `install.ts` and any tests that validate the exports.
- `cost.js` is auto-generated -- it must not be edited directly. The source of
  truth is `vendor/apra-pm/.claude/workflows/auto-sprint.js`.
- `workflows` is a required field in `AssetManifest`. Tests that build a mock
  manifest via `_setManifestOverride` must include a `workflows: {}` key (or a
  populated one if testing workflow install).
- The `/auto-sprint` completion output is only emitted for claude+PM installs
  (see `agent-transform.ts`).
