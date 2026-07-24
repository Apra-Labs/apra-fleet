# gitnexus MCP Child Tool Surface (T1.1 spike)

Source of truth for T2.1 (code_map), T2.2 (code_flow), and T4.4 (code_tests).
Those doers cite the Decisions table at the end and need no further
investigation.

## Method

- Connected to the child exactly as the fleet does (see `getGitNexusClient` in
  `src/tools/code-intelligence-gitnexus.ts`): spawned `npx -y gitnexus mcp` over
  stdio with `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`, then
  `listTools()`. Throwaway probe scripts were run from the scratch dir / npx
  cache and deleted; nothing committed.
- Cross-checked the live `listTools()` output against the installed package
  source: `gitnexus@1.6.7`, tool definitions in
  `node_modules/gitnexus/dist/mcp/tools.js` (`GITNEXUS_TOOLS`). Live list and
  source list match exactly (13 tools).
- Ran one cheap sample call per capability-relevant tool against this repo's
  existing `.gitnexus` index (380 files, 4051 nodes, 214 communities, 300
  processes; `embeddings: 0`).

## RESOLVED (yashr-5t9): graph() retargeted off the non-existent call_graph tool

Original finding (T1.1 spike): `GitNexusProvider.graph()` routed to
`callGitNexus('call_graph', params)`. gitnexus 1.6.7 has NO tool named
`call_graph`. A live call returns `isError: true`, text `Error: Unknown tool:
call_graph`. So the fleet's `code_graph` tool was effectively broken against
this gitnexus version -- it always returned the child's unknown-tool error (the
provider does not throw; the error is surfaced as a normal isError result).

The other three fleet mappings are correct and were confirmed working:
`impact -> impact`, `query -> query`, `context -> context`.

RESOLUTION (fix branch feat/code-intelligence-abstraction): `graph()` was
retargeted to compose two depth-bounded `cypher` traversals over `CALLS` edges
-- one for callers, one for callees -- returning a structured multi-hop call
graph `{ symbol, maxDepth, callers[], callees[] }` (rung 2, same compose
pattern as `map()`/`flow()`; reuses `extractCypherPayload` +
`parseMarkdownTable` + `asciiSanitizeLabel`). Routed through `callGitNexus` so
it inherits the pre-flight index check, connection resilience, and freshness
wiring. The schema `symbol` arg binds to the Cypher `$symbol` param.

Why cypher over the `context` fallback: `cypher` on `CALLS` gives a genuine
multi-hop (depth <= 2) traversal, which keeps `code_graph` MEANINGFULLY DISTINCT
from `code_context`. `code_context` (child `context`) is the depth-1 360-degree
view of a single symbol (direct in/out calls, accesses, KB enrichment);
`code_graph` is the transitive caller/callee graph.

Live verification (re-run during the fix, 2026-07, spawning the child exactly
as the fleet does): `listTools()` returns the same 13 tools below and
`call_graph` is absent; a variable-length query
`MATCH p = (a)-[:CodeRelation*1..2 {type: "CALLS"}]->(b) WHERE ...
RETURN ..., length(p) AS depth` returns the `{ markdown, row_count }` shape and
correctly surfaces depth-1 and depth-2 neighbors. A regression test
(`tests/code-intelligence.test.ts`, "child-tool surface guard") now asserts
every child tool the provider invokes exists in the child surface, so a mapping
to a non-existent tool can never silently ship again.

## Complete child tool inventory (gitnexus 1.6.7, 13 tools)

All tools accept an optional `repo` (indexed repo name/path; also `@group`
group mode). `repo` is only required when multiple repos are indexed; this repo
has one index, so `repo` is optional but the fleet always passes it.

| # | name | required params | key optional params | annotation |
|---|------|-----------------|----------------------|------------|
| 1 | `list_repos` | none | `limit` (1-200, def 50), `offset` | read-only |
| 2 | `query` | `query` (string) | `task_context`, `goal`, `limit` (1-100, def 5), `max_symbols` (1-200, def 10), `include_content`, `repo`, `service` | read-only |
| 3 | `cypher` | `query` (Cypher string) | `params` (object), `repo` | read-only |
| 4 | `context` | none (needs `name` or `uid` in practice) | `name`, `uid`, `file_path`, `kind`, `include_content`, `repo`, `service` | read-only |
| 5 | `detect_changes` | none | `scope` (unstaged/staged/all/compare), `base_ref`, `worktree`, `repo` | read-only |
| 6 | `rename` | `new_name` | `symbol_name`, `symbol_uid`, `file_path`, `dry_run` (def true), `repo` | DESTRUCTIVE |
| 7 | `impact` | `target`, `direction` (upstream/downstream) | `target_uid`, `file_path`, `kind`, `maxDepth` (1-32, def 3), `crossDepth`, `relationTypes[]`, `includeTests`, `minConfidence`, `limit`, `offset`, `summaryOnly`, `timeoutMs`/`timeout`, `repo`, `service`, `subgroup` | read-only |
| 8 | `route_map` | none | `route`, `repo` | read-only |
| 9 | `tool_map` | none | `tool`, `repo` | read-only |
| 10 | `shape_check` | none | `route`, `repo` | read-only |
| 11 | `api_impact` | none (needs `route` or `file`) | `route`, `file`, `repo` | read-only |
| 12 | `group_list` | none | `name` | read-only |
| 13 | `group_sync` | `name` | `skipEmbeddings`, `exactOnly` | DESTRUCTIVE |

There is NO direct tool named `communities`, `map`, `community_map`, `flows`,
`processes`, `flow`, `tests`, or `call_graph`. `route_map`/`tool_map` are
API-route and MCP-tool maps, not module/community maps.

### Output shapes (confirmed by sample calls against this repo's index)

`query` -- returns a JSON object (as text content):
```
{
  "processes": [ ... ],        // ranked execution flows (empty for weak matches)
  "process_symbols": [ ... ],  // symbols in those flows w/ filePath + module
  "definitions": [             // standalone symbols matched (fallback)
    { "id", "name", "filePath", "startLine"?, "endLine"?, "module"? }
  ],
  "timing": { "vector", "bm25", "merge", "symbol_lookup", "ranking", ... }
}
```
The `query` input is natural-language/keyword only (`query`, `task_context`,
`goal`) -- there is NO structured `from`/`to`/`name` process filter on this tool.

`context` -- 360-degree symbol view:
```
{
  "status": "found",
  "symbol": { "uid", "name", "kind", "filePath", "startLine", "endLine" },
  "incoming": { "calls": [ { uid, name, filePath }, ... ], ... },
  "outgoing": { "calls": [...], "accesses": [...], ... }
}
```
Neighbor symbol names are directly parseable from `incoming.calls[].name` and
`outgoing.calls[].name` (relevant to T1.3 P4b). If the name is ambiguous it
returns ranked candidates instead.

`impact` -- blast radius, direction-aware:
```
{
  "target": { id, name, type, filePath },
  "direction": "upstream",
  "impactedCount": N,
  "risk": "LOW|MEDIUM|HIGH|CRITICAL",
  "summary": { direct, processes_affected, modules_affected },
  "byDepthCounts": { "1": 4, "2": 1 },
  "affected_processes": [ ... ],
  "affected_modules": [ { name, hits, impact } ],
  "byDepth": {
    "1": [ { depth, id, name, filePath, relationType, confidence, processes:[] }, ... ],
    "2": [ ... same item shape ... ]
  }
}
```
Confirmed: `direction: "upstream"` + `maxDepth: 2` returns callers grouped at
`byDepth["1"]` and `byDepth["2"]`, each item carrying `filePath`. `includeTests`
(default false) controls whether test files appear.

`cypher` -- returns `{ "markdown": "<table>", "row_count": N }`. Results are a
Markdown table, NOT structured JSON rows, so a composing provider must parse the
markdown table (or shape the RETURN columns and split on `|`). Graph schema
(from the tool description): nodes include `Community`, `Process`, `Route`,
`Tool`, `Function`, `Class`, `Method`; single `CodeRelation` edge table with a
`type` property (`CALLS`, `MEMBER_OF`, `STEP_IN_PROCESS`, `CONTAINS`, etc.).

## Capability question a -- Communities

No direct `communities`/`map` tool exists. The graph surface DOES expose the 214
communities via `cypher` over `Community` nodes and `MEMBER_OF` edges. Confirmed
sample calls against this index:

- `MATCH (c:Community) RETURN c.heuristicLabel AS label, c.symbolCount AS n,
  c.cohesion AS coh ORDER BY n DESC LIMIT 5`
  -> rows: `Providers|47|0.786`, `Services|35|0.554`, `Services|34|0.529`,
  `Providers|26|0.495`, `Providers|24|0.676`.
- `MATCH (f)-[:CodeRelation {type: "MEMBER_OF"}]->(c:Community) RETURN
  c.heuristicLabel AS community, count(f) AS members ORDER BY members DESC
  LIMIT 5`
  -> `Services|218`, `Providers|205`, `Os|114`, `Knowledge|76`, `Cli|68`.

Community node properties (per schema): `heuristicLabel`, `cohesion`,
`symbolCount`, `keywords`, `description`, `enrichedBy`.

Ladder rung: **2 (generic query surface -> compose).** `code_map` composes one
`cypher` call (route it through `callGitNexus('cypher', {...})`) and parses the
returned markdown table. Do NOT parse ladybugdb directly.

## Capability question b -- Flows / processes

No direct `flows`/`processes` tool. Two surfaces reach the 300 processes:

1. `query` returns a `processes` array, but it is ranked by a
   natural-language/keyword `query` string. It is NOT structurally filterable by
   `from`/`to`/`name` -- the tool has no such params. Fuzzy name match only, via
   the free-text query.
2. `cypher` over `Process` nodes IS structurally filterable. Process properties:
   `heuristicLabel`, `processType`, `stepCount`, `communities`, `entryPointId`,
   `terminalId`; steps via `STEP_IN_PROCESS` edges carrying an integer `step`.
   Confirmed sample: `MATCH (p:Process) RETURN p.heuristicLabel AS label,
   p.processType AS ptype, p.stepCount AS steps ORDER BY steps DESC LIMIT 5`
   -> e.g. `RemoveMember -> MaskSecrets | cross_community | 10` (note: the raw
   `heuristicLabel` data contains a unicode arrow between endpoints; a composing
   provider must ASCII-sanitize before writing it anywhere ASCII-only).

Mapping to `code_flow` params `{ from, to, name }`:
- `name` -> `WHERE p.heuristicLabel CONTAINS $name`.
- `from`/`to` -> filter on the endpoints encoded in `heuristicLabel`
  ("Entry -> Terminal"), or resolve `entryPointId`/`terminalId` to symbols and
  match. Endpoint filtering is achievable but requires parsing the label or a
  second lookup.
- To return `entry -> steps -> exit`: `MATCH (s)-[r:CodeRelation {type:
  "STEP_IN_PROCESS"}]->(p:Process) WHERE p.heuristicLabel = $name RETURN s.name,
  r.step ORDER BY r.step`.

Ladder rung: **2 (generic query surface -> compose).** `code_flow` composes
`cypher` (preferred, gives structured `from`/`to`/`name` filtering + ordered
steps) and parses the markdown table; `query` is a weaker fallback for pure
free-text lookups. Do NOT parse ladybugdb directly.

## Capability question c -- Upstream traversal for tests (P9 code_tests)

Directly supported by `impact`. Confirmed live call: `impact { target,
direction: "upstream", maxDepth: 2, includeTests: true }` returns callers in
`byDepth["1"]` and `byDepth["2"]`, each item with a `filePath` field. "Callers
of X, transitively, depth <= 2" maps to `maxDepth: 2` (default traversal is
CALLS/IMPORTS/EXTENDS/IMPLEMENTS; pass `relationTypes: ["CALLS"]` to restrict to
call edges if desired). Set `includeTests: true` so test files are not filtered
out before we see them, then keep only entries whose `filePath` satisfies
`isTestPath` (T4.3).

Ladder rung: **1/2 (direct tool, composed filter).** The upstream traversal
itself is a direct `impact` capability; `code_tests` composes it with the
`isTestPath` filter over `byDepth` `filePath`s. Route via
`callGitNexus('impact', {...})`. Do NOT parse ladybugdb directly.

## Decisions

| Capability (task) | Ladder rung | Child tool + params to use |
|-------------------|-------------|----------------------------|
| Communities (T2.1 `code_map`) | 2 -- compose | `callGitNexus('cypher', { query: 'MATCH (c:Community) RETURN c.heuristicLabel AS label, c.symbolCount AS symbols, c.cohesion AS cohesion, c.keywords AS keywords ORDER BY symbols DESC LIMIT $top', repo })`. For member symbols/files per community: `MATCH (f)-[:CodeRelation {type: "MEMBER_OF"}]->(c:Community) WHERE c.heuristicLabel = $label RETURN f.name, f.filePath`. Parse the returned `{ markdown, row_count }` table. `top` param caps rows. ASCII-sanitize labels. Do NOT parse lbug. |
| Flows / processes (T2.2 `code_flow`) | 2 -- compose | `callGitNexus('cypher', ...)` on `Process` nodes. name: `WHERE p.heuristicLabel CONTAINS $name`. steps: `MATCH (s)-[r:CodeRelation {type: "STEP_IN_PROCESS"}]->(p:Process) WHERE p.heuristicLabel = $name RETURN s.name, s.filePath, r.step ORDER BY r.step`. from/to: filter on the "Entry -> Terminal" endpoints in `heuristicLabel` (or resolve `entryPointId`/`terminalId`). Parse markdown table; ASCII-sanitize the unicode arrow in labels. `query` tool is a free-text-only fallback (NOT from/to/name filterable). Do NOT parse lbug. |
| Upstream traversal depth 2 (T4.4 `code_tests`) | 1/2 -- direct tool + composed filter | `callGitNexus('impact', { target: symbol, direction: 'upstream', maxDepth: 2, includeTests: true, repo })`. Collect `byDepth["1"]` + `byDepth["2"]` items, keep those whose `filePath` passes `isTestPath` (T4.3). Optionally add `relationTypes: ['CALLS']` to restrict to call edges. Do NOT parse lbug. |

### Backlog

- `yashr-5t9.graph-retarget` DONE: `GitNexusProvider.graph()` no longer calls
  the non-existent child tool `call_graph`. Retargeted to compose two
  depth-bounded `cypher` traversals over `CALLS` edges (callers + callees) --
  see the "RESOLVED (yashr-5t9)" section above. A regression test asserting
  every invoked child tool exists in the child surface now guards the bug class.
