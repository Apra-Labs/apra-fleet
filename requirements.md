# Requirements -- Code Intelligence Power

Sprint epic: yashr-8m0. Branch: feat/code-intelligence-abstraction (base: main).
Prior sprint (code-intelligence-hardening, yashr-43h) delivered resilience,
freshness, and routing; this sprint raises the capability ceiling. Binding
architecture decisions are in design.md -- read it before planning.

Six features. Numbering follows the improvement list agreed with the user
(items 5-7 are backlogged as yashr-m7x, yashr-68b, yashr-tfy -- OUT of scope).

## P1 -- Expose communities and flows as new tools (code_map, code_flow)

The gitnexus index already computes module communities (500 for streamsurv) and
process flows (300) -- see `.gitnexus/meta.json` stats. No fleet tool serves them.

- New tool `code_map`: input { repo?: string, top?: number } -> the repo's
  architectural map: communities with their key symbols/files, sized/ranked.
  Backed by whatever the gitnexus MCP child exposes for communities -- FIRST
  investigate the child's tool list (connect to `npx gitnexus mcp` and list
  tools, or read gitnexus docs/package). If the child has no community tool,
  read the data via the child's query surface or descope to reading
  `.gitnexus/meta.json`-adjacent stores ONLY if a stable read path exists;
  otherwise record the gap and descope this half (see design.md D1 fallback).
- New tool `code_flow`: input { from?: string, to?: string, name?: string,
  repo?: string } -> matching process flows (entry -> steps -> exit). Same
  investigation-first rule.
- Both tools: register in src/index.ts with routing-guidance descriptions
  (same style as the four existing code_* tools), route through the shared
  guarded callGitNexus helper (pre-flight index check, resilience, freshness
  note all apply for free), ASCII-only output.
- Tests: schema validation, missing-index error path reuse, and a mocked child
  response mapping test per tool.

## P2 -- Semantic code_query via embeddings (investigation-first)

`meta.json` shows `embeddings: 0` and `vectorSearch: exact-scan` -- code_query
is lexical FTS only. Goal: conceptual queries match code that uses different
words.

- SPIKE first (timeboxed task): determine how gitnexus populates embeddings --
  CLI flag, config, external model/API key, or unsupported in the installed
  version. Deliverable: a written finding in progress.json notes AND
  docs/code-intelligence-embeddings.md (short: what works, what it needs, cost).
- If embeddings need only local/offline means (e.g. a bundled model or a flag):
  wire it -- `/pm index` and the VERIFY re-index pass the flag; document in
  skills/pm/index.md.
- If they need an external API key or heavyweight model: do NOT wire by
  default. Plumb an OPT-IN config field (`~/.apra-fleet/data/code-intelligence/
  config.json`: { embeddings: { enabled, provider, ... } }), document it, and
  create a follow-up backlog item. The sprint is NOT blocked on external
  dependencies.

## P3 -- Auto-reindex on drift (self-healing freshness)

The freshness note (prior sprint) warns when the index is behind HEAD. Upgrade
warn -> self-heal.

- In the fleet MCP server process: when a code_* call computes a freshness
  divergence for a repo, schedule a background incremental
  `npx gitnexus analyze` for that repo (child_process spawn, detached from the
  call path -- the call itself still returns immediately with the note).
- Debounce/single-flight per repo (design.md D3): at most one analyze running
  per repo; a new trigger while one runs or within the cooldown (default 120s,
  configurable) is a no-op. Track in-memory in the server process.
- Failures are logged (existing log helper) and never affect the tool call.
- The freshness note text gains a suffix when a reindex was scheduled:
  ` A background re-index has been started.`
- Tests: debounce logic as a pure/injectable unit (fake timers or injected
  clock), single-flight guarantee, spawn-args correctness (mock child_process).

## P4 -- KB and code graph cross-linking (one retrieval surface)

Two one-way joins; see design.md D4 for the dependency direction rule.

- P4a `code_context` inlines KB: after a successful code_context child call,
  query the KB (same repo scope) for CONFIRMED entries whose `symbols` contain
  the requested name; append a compact block to the response text:
  `[knowledge-bank] N confirmed entries for <name>:` then one line per entry
  (title -- summary first 120 chars). Zero entries -> no block. KB read errors
  -> no block, never fail the call.
- P4b `kb_session_prime` expands hints through the graph: after collecting
  direct hint matches, call the code intelligence provider for each
  hint_symbol (impact/context, depth 1) to get neighbor symbols; run ONE extra
  KB query batch over those neighbors; merge results into top_entries with a
  `via: "graph-neighbor"` marker, ranked below direct hits. Cap neighbors
  (default 10) and total added entries (default 5). Graph unavailable (no
  index, child down) -> prime works exactly as today (graceful skip).
- Tests: P4a append/no-append/error paths (mock KB service); P4b neighbor
  expansion with mocked provider, cap enforcement, graceful-skip path.

## P8 -- Usage telemetry on code intelligence queries

- Record each code_* call (also code_map/code_flow): { ts, tool, symbol/query,
  repo } appended to `~/.apra-fleet/data/code-intelligence/usage.jsonl`
  (design.md D8: JSONL, append-only, size-capped rotation at 5MB -> keep last
  file + one .1 backup). Never block or fail a call on telemetry errors.
- Surface: `fleet_status` code-intel section gains `top symbols (30d): a (12),
  b (9), ...` (top 5) in json + compact; computed by reading usage.jsonl with
  a time filter -- keep it fast (single pass, cap file read).
- Tests: append format, rotation trigger, top-N aggregation, error isolation.

## P9 -- Test-to-symbol mapping (code_tests)

The call graph already contains test files calling product symbols. Expose it:

- New tool `code_tests`: input { symbol: string, repo?: string } -> the test
  files/functions that (transitively, depth <= 2) call the symbol. Implement as
  an upstream code_impact/graph query through the child, then filter results to
  test paths (path contains `test`/`tests`/`spec` or filename *.test.* /
  *.spec.* -- keep the matcher a small exported pure function).
- Description tells agents the use: "run targeted tests for the code you
  changed instead of the full suite."
- Tests: path-matcher pure function cases; mocked child response filtering;
  missing-index reuse.

## Sprint-wide done criteria

- npm run build clean; npm test green (only the 2 pre-existing timezone
  failures, beads yashr-302, may fail).
- Every new tool: registered in src/index.ts, routed through callGitNexus
  (except pure-KB paths), description carries routing guidance, schema in
  code-intelligence.ts style, tests present.
- ASCII only in all files. Never push to main. NO PR (user raises PRs).
- Investigation results (P1 child-tool surface, P2 embeddings) written to
  docs/ and progress.json notes even where a feature was descoped -- a
  documented descope with a backlog item is an acceptable outcome for the
  investigation-gated halves; silent omission is not.
