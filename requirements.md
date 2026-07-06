# Requirements -- Code Intelligence Hardening

Sprint epic: yashr-43h. Branch: feat/code-intelligence-abstraction (base: main).

## Background

The code intelligence pipeline (gitnexus index -> apra-fleet MCP proxy -> code_graph /
code_impact / code_query / code_context tools) works end to end, but an audit
(2026-07-06, documented in docs/kb-current-state.html) found three weaknesses.
This sprint fixes all three.

The proxy lives in `src/tools/code-intelligence-gitnexus.ts` (spawns `npx gitnexus mcp`
as a stdio MCP child process, one shared client). Tool schemas and provider selection
live in `src/tools/code-intelligence.ts`. Tool registration is in `src/index.ts`.
The gitnexus index lives at `<repo>/.gitnexus/` with `meta.json` holding
`lastCommit`, `indexedAt`, `stats` (files/nodes/edges), and `fileHashes`.

## Fix 3 (RISKIEST -- must be Phase 1): silent-empty failure mode

Today, when the index is missing or the gitnexus child process fails, the tools
return empty results. Agents silently degrade to file reads; nobody learns code
intelligence was offline. This cost a real debugging session on 2026-06-23
(root-caused wrongly as "missing index.db").

### F3.1 Pre-flight index check

In `code-intelligence-gitnexus.ts`, before proxying any call that carries a `repo`
parameter: check `<repo>/.gitnexus/meta.json` exists. If absent, return a structured,
actionable error instead of forwarding the call:
`"No code intelligence index found for <repo>. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry."`
The check must be cheap (fs.existsSync) and must NOT break calls without a `repo` param.

### F3.2 Connection resilience

`getGitNexusClient()` caches `sharedClient` and `connectionPromise` forever:
- A FAILED `connectionPromise` is cached, so one bad startup poisons every later call.
- If the child process dies after connecting, every later call fails opaquely.

Required behavior:
- On connection failure, clear `connectionPromise` so the next call retries.
- Listen for transport close/error; reset `sharedClient`/`connectionPromise` so the
  next call reconnects.
- Wrap `callTool` so a dead-client error returns the same actionable message shape
  as F3.1 (never an unhandled throw, never a silent empty).

### F3.3 Health surfacing in fleet_status

Add a code intelligence section to the `fleet_status` tool output (find its
implementation via code_query; likely `src/tools/check-status.ts` or similar):
for the current working repo (process.cwd() if it has .gitnexus/), report:
index present yes/no, nodes/edges/files from meta.json stats, indexedAt,
and lastCommit vs current git HEAD (matching / N commits behind).
Keep it read-only and fast; degrade gracefully when git or meta.json is unavailable.

## Fix 2: mid-sprint staleness

The index reflects the repo at analyze time. Symbols created in sprint phases 1-2
are invisible to the phase-3 doer.

### F2.1 Re-index at VERIFY checkpoints

In `skills/pm/doer-reviewer-loop.md` (doer template) and `skills/pm/index.md`:
add `npx gitnexus analyze` to the VERIFY checkpoint sequence (after build/lint/tests
pass, before push). Indexing is incremental via fileHashes, so this is seconds.
Non-fatal: an analyze failure must not fail the VERIFY.

### F2.2 Freshness metadata in tool responses

In `code-intelligence-gitnexus.ts`: when a call carries a `repo` param and the index
exists, compare `meta.json.lastCommit` with the repo's current `git rev-parse HEAD`.
When they differ, append a freshness note to the tool response (do not block the
call): `"[code-intelligence] index is behind repo HEAD (indexed <lastCommit:8> vs HEAD <head:8>). Results may miss recent changes; run 'npx gitnexus analyze' to refresh."`
Extract the comparison into a small pure function so it is unit-testable.

## Fix 1: prompt-dependence of tool routing

Agents only use the tools when the dispatch prompt says so. Tool descriptions are
the only channel present on EVERY dispatch path.

### F1.1 Routing guidance in tool descriptions

In `src/tools/code-intelligence.ts` and wherever the user-facing tool descriptions
are registered (check `src/index.ts`), extend each tool description
(code_graph, code_impact, code_query, code_context) with one sentence:
"Prefer this over Glob/Grep/file reads for structural questions (symbol lookup,
call chains, impact) -- the answer is pre-indexed."

### F1.2 Reviewer dispatch template

In `skills/pm/doer-reviewer-loop.md`, the reviewer template has no code
intelligence / KB instructions (planner and doer templates were patched this week).
Add the same style paragraph: kb_session_prime at start (hints from the diff),
code_impact for "who else calls this changed method", kb_query before unfamiliar
file reads.

### F1.3 Confirm fleet-mode templates

Verify `skills/pm/tpl-planner.md`, `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md`
all carry the code intelligence + KB instructions (updated earlier on this branch;
this is a read-and-confirm task, fix only if a gap is found).

## Done criteria (sprint-wide)

- `npm run build` clean (tsc, no errors)
- `npm test` green (vitest) including NEW unit tests for:
  - F3.1 missing-index error (temp dir without .gitnexus)
  - F3.2 connection-promise reset on failure (mockable transport)
  - F2.2 freshness comparison logic (pure function)
- ASCII only in all files (repo rule)
- No PR raised (the user raises PRs explicitly). Work stays on
  feat/code-intelligence-abstraction; never push to main.

## Design note

No separate design.md: the architecture is fixed by the existing provider
abstraction; binding decisions (error message shapes, freshness note format) are
specified inline above. The riskiest work is F3.2 (async lifecycle of the shared
MCP client) -- front-load it.
