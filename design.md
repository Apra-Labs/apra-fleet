# Design -- Code Intelligence Power

Binding decisions for the code-intelligence-power sprint (epic yashr-8m0).
The planner and reviewers check code against these; deviations need a recorded
reason in progress.json notes.

## D1 -- New tools go through the existing provider abstraction

`code_map`, `code_flow`, `code_tests` are methods on the
`CodeIntelligenceProvider` interface (src/tools/code-intelligence.ts), implemented
by `GitNexusProvider` via the shared guarded `callGitNexus` helper. This gives
pre-flight index check, connection resilience, freshness note, and (new)
telemetry for free. Tool registration follows the existing pattern in
src/index.ts.

Investigation-first rule: the gitnexus MCP child's actual tool surface is
UNKNOWN until listed. The first task of Phase 1 connects to the child
(`npx gitnexus mcp`) and records its tool list + schemas in
docs/code-intelligence-child-surface.md. Every P1/P9 mapping decision cites
that document.

Fallback ladder per capability (communities, flows, upstream-for-tests):
1. Child exposes a direct tool -> proxy it.
2. Child exposes a generic query that can express it -> compose.
3. Neither -> descope that tool, document in docs/ + backlog item. Do NOT
   parse ladybugdb (`lbug`) directly -- its format is private to gitnexus.

## D2 -- Embeddings are opt-in and never a hard dependency

If populating embeddings requires anything beyond a local flag (API key,
model download beyond npx), it ships as config plumbing + docs only, default
OFF. The KB config file pattern (`~/.apra-fleet/data/code-intelligence/
config.json`) is the single place such config lives.

## D3 -- Auto-reindex lives in the fleet server process, in memory

- Trigger point: inside the freshness-note computation path (already per-call,
  already knows repo + divergence). No new watchers, no cron.
- State: a module-level Map<repoPath, { runningChild?, lastFinishedAt }> in a
  new module src/tools/code-intelligence-reindex.ts. In-memory is acceptable:
  the server is long-lived; a restart just means one extra reindex.
- Semantics: single-flight per repo + cooldown (default 120000 ms, override via
  config.json { autoReindex: { cooldownMs, enabled } }, default enabled: true).
- Spawn: `npx gitnexus analyze` with cwd = repo, detached, stdio ignored except
  a tail of stderr captured to the fleet log on non-zero exit. Never awaited on
  the tool-call path.
- The debounce/single-flight decision function is a pure exported function
  taking (state, now) so it unit-tests without timers.

## D4 -- Cross-linking dependency direction: KB may call CI; CI may call KB read-only

- P4a (code_context -> KB): the gitnexus provider file must NOT import the KB
  service directly (avoids a src/tools <-> src/services cycle). Instead the
  enrichment happens one layer up -- in the tool handler in src/index.ts (or a
  small src/tools/code-intelligence-kb-enrich.ts helper imported only by the
  handler), which calls both the provider and the KB service and merges.
- P4b (kb_session_prime -> CI): the KB service side already models
  recommended_code_calls; the expansion calls the CI provider through the
  PROVIDERS map (getProvider()), guarded by try/catch with a hard skip on any
  error. Depth 1, neighbor cap 10, added-entry cap 5 (constants, exported for
  tests).
- Both joins are read-only with respect to the other system. No write in
  either direction. Both degrade to current behavior when the other side is
  unavailable.

## D8 -- Telemetry format

- File: `~/.apra-fleet/data/code-intelligence/usage.jsonl`, one JSON object per
  line: { ts: ISO8601, tool: string, target: string, repo: string | null }.
  `target` is the symbol/query/name argument as given.
- Write: fs.appendFile fire-and-forget wrapped in try/catch; a telemetry
  failure must never surface to the caller.
- Rotation: before append, if size > 5 MB rename to usage.jsonl.1 (overwrite
  any existing .1) and start fresh. Simple, lossy-by-design.
- Read (fleet_status): single pass over usage.jsonl (and .1 if present),
  filter ts >= now - 30d, aggregate count by target, top 5. Wrapped in
  try/catch -> section omitted on any error.
- Recording happens in the shared tool-handler layer (same place as D4a
  enrichment), NOT inside GitNexusProvider -- provider stays a pure proxy.

## D9 -- Test-path matcher

Exported pure function `isTestPath(path: string): boolean` in
src/tools/code-intelligence-tests.ts: true when any path segment is `test`,
`tests`, or `spec` (case-insensitive), or the filename matches
/\.(test|spec)\.[^.]+$/. Depth for upstream traversal fixed at 2.

## Phasing guidance (risk order)

Riskiest first: the child-surface investigation (P1 spike) gates P1 and P9
mappings, and the embeddings spike (P2) is the largest unknown -- both spikes
belong in Phase 1 alongside the highest-value build work. P4b touches the KB
service internals (kb-session-prime + sqlite provider interplay) and is the
riskiest pure-code task. Telemetry (P8) and code_tests (P9 build half) are
low-risk and can ride later phases.
