# apra-fleet -- Code Intelligence Power Sprint Plan

Sprint epic: yashr-8m0. Branch: `feat/code-intelligence-abstraction` (base: `main`).
Sources of truth: `requirements.md` (features P1, P2, P3, P4, P8, P9) and
`design.md` (binding decisions D1-D9; deviations need a recorded reason in
progress.json notes).

> Raise the capability ceiling of the code intelligence stack: new tools
> (code_map, code_flow, code_tests), semantic search investigation, self-healing
> freshness, KB/graph cross-linking, and usage telemetry.

## Planning context (KB-informed)

KB was warm at planning time (21+ CONFIRMED entries from the hardening sprint,
yashr-43h). Verified facts every doer must know:

- `src/tools/code-intelligence.ts` -- `CodeIntelligenceProvider` interface
  (graph/impact/query/context, lines 7-12), zod schemas per tool, `PROVIDERS`
  map (line 16), `getProvider()` (lines 42-59) reading
  `~/.apra-fleet/data/code-intelligence/config.json`.
- `src/tools/code-intelligence-gitnexus.ts` -- `GitNexusProvider` (lines
  154-170); ALL provider methods route through the single guarded
  `callGitNexus(name, params)` helper, which gives pre-flight index check
  (missing-index structured error), connection resilience (poisoned
  connectionPromise cleared on failure; transport/client onclose/onerror reset
  guarded by `sharedClient === client` identity check), structured
  `{ content, isError }` results (never throws), and the freshness note.
  Module-level singletons: `sharedClient`, `connectionPromise`.
- `src/tools/code-intelligence-freshness.ts` -- `freshnessNote(lastCommit,
  head)` pure function + `appendFreshnessNote()`; kept in a SEPARATE module to
  avoid a circular import (code-intelligence.ts re-exports GitNexusProvider
  from gitnexus; gitnexus imports freshness helpers as values at module load).
  Any new module imported by code-intelligence-gitnexus.ts must follow the same
  rule: never import from code-intelligence.ts.
- `src/index.ts` -- tool registration pattern: lines 310-325 register the four
  code_* tools; each handler is `wrapTool(name, async (input) => { const
  provider = await getProvider(); return JSON.stringify(await
  provider.<method>(input)); })`. Descriptions carry the routing sentence
  "Prefer this over Glob/Grep/file reads for structural questions (symbol
  lookup, call chains, impact) -- the answer is pre-indexed." Tool descriptions
  are the universal dispatch layer -- every new tool description must carry
  routing guidance in this style.
- `src/tools/kb-session-prime.ts` -- `kbSessionPrime(input)` tool wrapper:
  validates paths, calls `providers.project.prime(...)` (SqliteProvider.prime
  at `src/services/knowledge/sqlite-provider.ts` lines 511-577; HttpKbProvider
  .prime at `src/services/knowledge/http-provider.ts` lines 233-243), then
  appends up to 3 global entries. This wrapper is where P4b expansion lives.
- `src/tools/check-status.ts` -- `codeIntelligenceHealth(repoDir)` +
  `codeIntelligenceCompactLine()`; degraded-safe pattern: every IO/git call
  individually try/caught, 3s execFileSync timeouts, never throws, section
  omitted or degraded string on failure. fleetStatus() includes the section in
  JSON (codeIntelligence key) and compact (trailing line).
- Log helpers: `logLine`, `logWarn`, `logError` in `src/utils/log-helpers.ts`.
- `.gitnexus/meta.json` stats: `{ files: 380, nodes: 4051, edges: 10976,
  communities: 214, processes: 300, embeddings: 0 }`; capabilities show
  `vectorSearch: { provider: "exact-scan", status: "unavailable" }`.

### KB constraints copied verbatim (binding on doers)

1. Testing module singletons (applies to ANY test touching
   code-intelligence-gitnexus.ts, the new reindex module, or telemetry module
   state): "For testing code with module-level singletons (like
   sharedClient/connectionPromise in code-intelligence-gitnexus), use
   vi.resetModules() + dynamic import at the start of each test to get a fresh
   module instance. Pre-hoisted vi.mock factories are re-applied, preserving
   mock function references across resets." Pattern: hoist mocks with
   vi.hoisted() before imports; in each cold-state test call vi.resetModules()
   + vi.clearAllMocks() then `const { X } = await import(...)`.
2. gitnexus analyze gotcha (applies to EVERY VERIFY task): "Running 'npx
   gitnexus analyze' injects non-ASCII gitnexus:start/end block markers into
   AGENTS.md and CLAUDE.md, violating ASCII-only convention. This happens in
   every VERIFY phase. Fix: run 'git checkout -- AGENTS.md CLAUDE.md'
   immediately after analyze to discard injected markers, keeping only the real
   code intelligence updates to other files."

## Sprint-wide constraints

- ASCII only in every file written. `-` for dashes, `->` for arrows.
- Never push to `main`. NO PR -- the user raises PRs.
- Every new tool: registered in src/index.ts, routed through callGitNexus
  (except pure-KB paths), description carries routing guidance, zod schema in
  code-intelligence.ts style, tests present (D1).
- Do NOT parse ladybugdb (`lbug`) files directly -- format is private to
  gitnexus (D1 fallback ladder step 3).
- Known pre-existing test failures: only the 2 timezone failures in
  tests/time-utils.test.ts (beads yashr-302) may fail.
- Telemetry, KB enrichment, and auto-reindex must NEVER fail or block a tool
  call (D3, D4, D8): fire-and-forget + try/catch everywhere.

## Phase 1 -- Spikes + riskiest build work

Per design.md phasing guidance: both spikes gate later mapping decisions and
belong here; P4b is the riskiest pure-code task and rides alongside.

### T1.1 SPIKE: gitnexus MCP child tool surface investigation

- type: spike
- model: claude-opus-4-8
- Deliverable: `docs/code-intelligence-child-surface.md` (new file) + a note in
  progress.json. NO product code changes.
- The gitnexus MCP child's actual tool surface is UNKNOWN until listed (design
  D1). Connect to the child the same way the fleet server does (see
  getGitNexusClient in src/tools/code-intelligence-gitnexus.ts -- it spawns
  `npx gitnexus mcp` over stdio) and list its tools. Practical options: a
  short throwaway node script using @modelcontextprotocol/sdk Client +
  StdioClientTransport calling listTools(); and/or read the installed gitnexus
  package (node_modules/gitnexus or `npm ls gitnexus` then its dist/docs) to
  confirm tool names, input schemas, and output shapes. Record for EVERY child
  tool: name, input schema, output shape (run one sample call per tool where
  cheap, e.g. against this repo's existing .gitnexus index).
- Answer these three capability questions explicitly, one section each
  (design D1 fallback ladder: 1. direct tool -> proxy; 2. generic query surface
  that can express it -> compose; 3. neither -> descope + docs + backlog):
  a. Communities: is there a direct communities/map tool? If not, can the
     query/graph surface return community data (meta.json says 214 communities
     exist)?
  b. Flows/processes: is there a direct flows/processes tool? (meta.json says
     300 processes exist; code_query responses already include a `processes`
     array -- document whether that surface is filterable by from/to/name.)
  c. Upstream traversal for tests: can impact/graph express "callers of X,
     depth 2" as needed by P9 code_tests?
- End the doc with a "Decisions" table: capability -> ladder rung chosen ->
  child tool + params to use (or DESCOPED + backlog bead text). T2.1, T2.2 and
  T4.4 cite this table; write it so those doers need no further investigation.
- ASCII only. Do not commit any throwaway scripts (scratch dir or delete).
- Done: docs/code-intelligence-child-surface.md exists with tool list, schemas,
  three capability sections, Decisions table; progress.json notes updated.

### T1.2 SPIKE: embeddings population investigation

- type: spike
- model: claude-sonnet-4-6
- Deliverable: `docs/code-intelligence-embeddings.md` (new file, short: what
  works, what it needs, cost) + finding recorded in progress.json notes. NO
  wiring in this task (T2.3 does the wiring).
- Context: `.gitnexus/meta.json` shows `embeddings: 0` and `vectorSearch:
  { provider: "exact-scan", status: "unavailable", reason: "LadybugDB VECTOR is
  disabled on this platform; semantic search uses exact scan when embeddings
  exist." }` -- code_query is lexical FTS only today.
- Timebox: this is an investigation, not a build. Determine how the INSTALLED
  gitnexus version populates embeddings: CLI flag on `npx gitnexus analyze`?
  config file? external model/API key? or unsupported in this version. Methods:
  `npx gitnexus analyze --help`, `npx gitnexus --help`, read the installed
  package's docs/source, try a candidate flag against a small test repo (NOT
  this repo's live index; if you must run analyze here, afterwards run
  `git checkout -- AGENTS.md CLAUDE.md` -- analyze injects non-ASCII
  gitnexus:start/end markers into those files, see KB constraint 2).
- Classify the outcome for T2.3 (design D2): LOCAL (flag or bundled model,
  works offline via npx) vs EXTERNAL (API key or heavyweight model download) vs
  UNSUPPORTED. State the classification on the first line of the doc.
- Done: doc exists with classification + evidence + cost notes; progress.json
  notes record the finding (required by requirements.md even if UNSUPPORTED).

### T1.3 P4b: kb_session_prime graph-neighbor expansion

- type: work
- model: claude-opus-4-8
- Riskiest pure-code task of the sprint (design phasing guidance): touches the
  kb-session-prime tool wrapper + CI provider interplay.
- File: `src/tools/kb-session-prime.ts` (design D4: expansion calls the CI
  provider through the PROVIDERS map via getProvider() from
  `./code-intelligence.js`; the KB service side already models
  recommended_code_calls; do NOT modify SqliteProvider.prime or
  HttpKbProvider.prime -- the join lives one layer up, in this wrapper, so it
  works for both project providers).
- Behavior, after `providers.project.prime(...)` returns and direct hint
  matches are collected:
  1. For each `hint_symbols` entry, call the CI provider (impact or context,
     depth 1 semantics -- use `provider.context({ name: symbol })` or
     `provider.impact({ target: symbol, direction: 'upstream' })`, whichever
     T1.1's surface doc shows returns parseable neighbor symbol names) to get
     neighbor symbols. Parse defensively: the provider returns either an MCP
     result object or a structured `{ isError: true }` result -- treat isError,
     missing content, and unparseable JSON all as "no neighbors for this
     symbol".
  2. Collect neighbor names not already in hint_symbols, capped at
     NEIGHBOR_CAP (default 10, exported const).
  3. Run ONE extra KB query batch over those neighbors: a single
     `providers.project.query({ query: neighbors.join(' '), l1_only: true,
     limit: 10, include_stale: false })`.
  4. Merge results into `result.top_entries`: skip entries already present
     (by id), mark each added entry with `via: "graph-neighbor"`, rank them
     BELOW all direct hits (append after), cap additions at ADDED_ENTRY_CAP
     (default 5, exported const).
- Constants NEIGHBOR_CAP = 10 and ADDED_ENTRY_CAP = 5 exported for tests
  (design D4).
- Graceful skip (design D4): the ENTIRE expansion is wrapped in try/catch with
  a hard skip on any error -- graph unavailable, no index, child down, KB query
  failure -> prime returns exactly what it returns today. No error text in the
  response, no throw. Also skip when hint_symbols is empty/absent.
- Tests (new file or extend tests/knowledge/kb-session-prime.test.ts): neighbor
  expansion with a mocked provider (mock getProvider/PROVIDERS -- KB constraint
  1 verbatim: "For testing code with module-level singletons ... use
  vi.resetModules() + dynamic import at the start of each test to get a fresh
  module instance. Pre-hoisted vi.mock factories are re-applied, preserving
  mock function references across resets."); cap enforcement (11 neighbors ->
  10 queried; 8 candidate entries -> 5 added); dedupe against direct hits;
  graceful-skip path (provider throws -> output identical to non-expanded
  prime); via marker present and ranked below direct hits.
- Done: expansion works behind caps, all tests green, no behavior change when
  graph is unavailable, build clean.

### T1.4 VERIFY Phase 1

- type: verify (no model)
- Sequence:
  1. `npm run build` -- must be clean.
  2. `npm test` -- green except known pre-existing: only the 2 timezone
     failures in tests/time-utils.test.ts (beads yashr-302) may fail.
  3. `npx gitnexus analyze` -- non-fatal if it errors.
  4. KB constraint 2 verbatim: "Running 'npx gitnexus analyze' injects
     non-ASCII gitnexus:start/end block markers into AGENTS.md and CLAUDE.md
     ... Fix: run 'git checkout -- AGENTS.md CLAUDE.md' immediately after
     analyze." Then confirm `git status` shows no unexpected AGENTS.md /
     CLAUDE.md modifications.
  5. Push branch `feat/code-intelligence-abstraction`. Never push main. NO PR.

## Phase 2 -- New tools from the child surface (P1) + embeddings outcome (P2)

### T2.1 code_map tool (communities)

- type: work
- model: claude-sonnet-4-6
- Gated by T1.1. Decision rule (apply the Decisions table in
  docs/code-intelligence-child-surface.md, communities row): if the child
  exposes a direct communities/map tool -> proxy it via callGitNexus; elif the
  child's generic query surface can express communities -> compose (one or more
  callGitNexus calls + mapping code in the provider method); else -> DESCOPE:
  implement nothing in src/, record the gap in
  docs/code-intelligence-child-surface.md and progress.json notes with a
  backlog item, and mark this task descoped in progress.json. Do NOT parse
  ladybugdb (lbug) directly.
- If building: input schema `codeMapSchema` in src/tools/code-intelligence.ts:
  `{ repo?: string, top?: number }` (repo described exactly like existing
  schemas; top = max communities to return). Add `map(params)` to the
  CodeIntelligenceProvider interface and GitNexusProvider (method body routes
  through callGitNexus like the existing four -- pre-flight index check,
  resilience, freshness note, ASCII-only output all come for free, design D1).
  Output: the repo's architectural map -- communities with their key
  symbols/files, sized/ranked, shaped per what the child returns (document the
  mapping in code comments citing the surface doc).
- Register in src/index.ts next to the existing code_* block, handler pattern
  identical (getProvider() -> provider.map(input) -> JSON.stringify), with a
  routing-guidance description in the established style, e.g.: 'Get the
  architectural map of a repository: module communities with their key symbols
  and files, ranked by size. Prefer this over directory listings or file reads
  when orienting in an unfamiliar codebase -- the answer is pre-indexed.'
- Tests (tests/code-intelligence.test.ts or a new file): schema validation;
  missing-index error path reuse (same structured error as existing tools);
  mocked child response mapping test. KB constraint 1 verbatim applies: "For
  testing code with module-level singletons (like sharedClient/
  connectionPromise in code-intelligence-gitnexus), use vi.resetModules() +
  dynamic import at the start of each test to get a fresh module instance.
  Pre-hoisted vi.mock factories are re-applied, preserving mock function
  references across resets."
- Done: tool registered + tested, or documented descope with backlog note in
  progress.json (silent omission is NOT acceptable per requirements.md).

### T2.2 code_flow tool (process flows)

- type: work
- model: claude-sonnet-4-6
- Gated by T1.1. Decision rule (Decisions table, flows row): if direct
  flows/processes tool -> proxy via callGitNexus; elif generic query surface
  can express it (note: code_query responses already carry a `processes`
  array; T1.1 documents whether that is filterable) -> compose; else ->
  descope + docs + backlog note in progress.json. Do NOT parse ladybugdb
  directly.
- If building: input schema `codeFlowSchema` in src/tools/code-intelligence.ts:
  `{ from?: string, to?: string, name?: string, repo?: string }` -> matching
  process flows (entry -> steps -> exit). Add `flow(params)` to
  CodeIntelligenceProvider + GitNexusProvider routing through callGitNexus.
  Filtering by from/to/name happens child-side if supported, else in the
  provider method over the child's response.
- Register in src/index.ts with routing-guidance description, e.g.: 'Find
  process flows (entry -> steps -> exit) matching a name or endpoints. Prefer
  this over manually tracing call chains across files -- the flows are
  pre-indexed.'
- Tests: schema validation; missing-index error path reuse; mocked child
  response mapping test (including from/to/name filter behavior). KB constraint
  1 (vi.resetModules + dynamic import + vi.hoisted mocks) applies verbatim as
  in T2.1.
- Done: tool registered + tested, or documented descope with backlog note.

### T2.3 Embeddings outcome implementation (P2)

- type: work
- model: claude-sonnet-4-6
- Gated by T1.2. Decision rule (classification on line 1 of
  docs/code-intelligence-embeddings.md, design D2):
  - LOCAL (flag or bundled model, offline via npx) -> wire it: `/pm index`
    (skills/pm/index.md) and the VERIFY re-index step pass the flag; document
    the flag in skills/pm/index.md; update docs/code-intelligence-embeddings.md
    with the wiring.
  - EXTERNAL (API key or heavyweight model) -> do NOT wire by default: plumb an
    OPT-IN config field in `~/.apra-fleet/data/code-intelligence/config.json`:
    `{ embeddings: { enabled: boolean, provider: string, ... } }` (read where
    the analyze command line is built -- when enabled, append the necessary
    flags/env; default OFF so behavior is unchanged); document in
    docs/code-intelligence-embeddings.md + skills/pm/index.md; create a
    follow-up backlog item in progress.json notes. The sprint is NOT blocked
    on external dependencies.
  - UNSUPPORTED -> docs-only: finalize docs/code-intelligence-embeddings.md
    with the finding + backlog item in progress.json notes; no code.
- Config lives ONLY in the code-intelligence config.json (design D2 -- "the
  single place such config lives"); reuse the CONFIG_PATH constant pattern from
  src/tools/code-intelligence.ts (do not duplicate parsing style).
- Tests: only if code is written -- config parsing (enabled/disabled/absent ->
  correct analyze args), default-OFF behavior.
- Done: one of the three branches fully executed; docs + progress.json updated
  in all branches (a documented descope with a backlog item is acceptable;
  silent omission is not).

### T2.4 VERIFY Phase 2

- type: verify (no model)
- Same sequence as T1.4: npm run build; npm test (only the 2 pre-existing
  timezone failures in tests/time-utils.test.ts, beads yashr-302, may fail);
  npx gitnexus analyze (non-fatal); then per KB constraint 2 run
  `git checkout -- AGENTS.md CLAUDE.md` to discard the injected non-ASCII
  gitnexus:start/end markers; push branch. Never push main. NO PR.

## Phase 3 -- Self-healing freshness (P3) + code_context KB enrichment (P4a)

### T3.1 Auto-reindex module: state, decision function, spawn

- type: work
- model: claude-sonnet-4-6
- New file `src/tools/code-intelligence-reindex.ts` (design D3). Must NOT
  import from src/tools/code-intelligence.ts (circular-import rule -- this
  module will be imported by code-intelligence-gitnexus.ts in T3.2, mirroring
  the freshness module precedent).
- Contents:
  - Module-level `Map<repoPath, { runningChild?: ChildProcess,
    lastFinishedAt?: number }>` (in-memory is acceptable: the server is
    long-lived; a restart just means one extra reindex -- design D3).
  - Pure exported decision function taking `(state, now)` -- e.g.
    `shouldStartReindex(entry: { running: boolean, lastFinishedAt?: number } |
    undefined, now: number, cooldownMs: number): boolean` -- so it unit-tests
    without timers (design D3). Semantics: single-flight per repo + cooldown; a
    trigger while one analyze runs or within cooldownMs of the last finish is a
    no-op. Cooldown default 120000 ms.
  - Config override via `~/.apra-fleet/data/code-intelligence/config.json`
    `{ autoReindex: { cooldownMs?: number, enabled?: boolean } }`, default
    enabled: true (design D3). enabled: false -> scheduling function always
    no-ops.
  - `maybeScheduleReindex(repoPath: string): boolean` (returns whether a
    reindex was started): consults config + decision function, then spawns
    `npx gitnexus analyze` with cwd = repo, detached, stdio ignored EXCEPT a
    tail of stderr captured and written to the fleet log (logWarn/logError from
    src/utils/log-helpers.ts) on non-zero exit (design D3). Never awaited on
    the tool-call path; on child exit update lastFinishedAt and clear
    runningChild. All failures logged, never thrown (requirements P3:
    "failures are logged and never affect the tool call"). Windows note: use
    shell-safe spawn of npx (spawn('npx', ['gitnexus', 'analyze'], { shell:
    process.platform === 'win32', ... }) or equivalent existing pattern in the
    codebase).
- Tests (tests/code-intelligence-reindex.test.ts): decision function as a pure
  unit (running -> false; within cooldown -> false; past cooldown -> true;
  undefined entry -> true; custom cooldownMs honored); single-flight guarantee
  (two maybeScheduleReindex calls -> one spawn); spawn-args correctness (mock
  child_process); enabled:false no-op. Module has state -> KB constraint 1
  verbatim: "For testing code with module-level singletons ... use
  vi.resetModules() + dynamic import at the start of each test to get a fresh
  module instance. Pre-hoisted vi.mock factories are re-applied, preserving
  mock function references across resets."
- Done: module + tests green; no import from code-intelligence.ts; build clean.

### T3.2 Wire auto-reindex into the freshness path + note suffix

- type: work
- model: claude-sonnet-4-6
- File: `src/tools/code-intelligence-gitnexus.ts`. Trigger point is inside the
  existing freshness-note computation in callGitNexus (design D3: "already
  per-call, already knows repo + divergence; no new watchers, no cron"): when a
  divergence is detected for params.repo, call
  `maybeScheduleReindex(params.repo)` (import from
  ./code-intelligence-reindex.js -- value import is safe, no cycle). The tool
  call itself still returns immediately with the note; scheduling is
  fire-and-forget and wrapped so any error is swallowed/logged.
- When maybeScheduleReindex returned true, the freshness note text gains the
  exact suffix: ` A background re-index has been started.` (requirements P3;
  note the leading space). Extend freshnessNote/appendFreshnessNote in
  src/tools/code-intelligence-freshness.ts as needed (keep the pure function
  pure: e.g. add a parameter `reindexScheduled: boolean`).
- Tests: extend tests/code-intelligence-freshness.test.ts (pure function with
  and without suffix -- exact string) and tests/code-intelligence.test.ts
  (divergence triggers exactly one schedule call; schedule failure does not
  affect the tool result). KB constraint 1 (vi.resetModules + dynamic import,
  vi.hoisted mock factories) applies verbatim -- these tests touch the
  gitnexus module singletons.
- Done: divergence -> background reindex scheduled at most once per
  repo/cooldown; note carries suffix only when scheduled; no tool-call latency
  or failure introduced; tests green.

### T3.3 P4a: code_context inlines KB entries

- type: work
- model: claude-sonnet-4-6
- Design D4 layering is binding: the gitnexus provider file must NOT import the
  KB service (avoids a src/tools <-> src/services cycle). Implement a small
  helper `src/tools/code-intelligence-kb-enrich.ts` imported ONLY by the
  code_context handler in src/index.ts; the handler calls the provider, then
  the helper, and merges.
- Behavior: after a successful code_context child call (result not isError),
  query the KB -- `getKbProviders()` from
  src/services/knowledge/kb-providers.js, `providers.project.query({ query:
  <name>, l1_only: true, include_stale: false, ... })` -- and filter to
  CONFIRMED entries whose `symbols` array contains the requested name (exact
  match on the symbols field, same repo scope as the project provider).
  Append a compact block to the response text:
  `[knowledge-bank] N confirmed entries for <name>:` then one line per entry
  (`- <title> -- <summary first 120 chars>`). Zero matching entries -> NO
  block at all. KB read errors -> no block, never fail the call (try/catch
  around the whole enrichment). ASCII only.
- Do not enrich error results; do not enrich other code_* tools.
- Tests (new tests/code-intelligence-kb-enrich.test.ts): append path (2 mocked
  CONFIRMED entries with matching symbols -> block with N=2, 120-char summary
  truncation verified); no-append path (zero entries; entries whose symbols do
  not contain the name; non-CONFIRMED entries excluded); error path (KB service
  mock throws -> response identical to un-enriched). Mock the KB service
  module.
- Done: enrichment behind the handler only, provider file untouched by KB
  imports, all three test paths green.

### T3.4 VERIFY Phase 3

- type: verify (no model)
- Same sequence as T1.4: npm run build; npm test (only the 2 pre-existing
  timezone failures in tests/time-utils.test.ts, beads yashr-302, may fail);
  npx gitnexus analyze (non-fatal); then per KB constraint 2 run
  `git checkout -- AGENTS.md CLAUDE.md` to discard injected non-ASCII markers;
  push branch. Never push main. NO PR.

## Phase 4 -- Telemetry (P8) + code_tests (P9)

### T4.1 Telemetry recorder: append + rotation + handler wiring

- type: work
- model: claude-sonnet-4-6
- New file `src/tools/code-intelligence-telemetry.ts` (design D8):
  - `recordUsage(tool: string, target: string, repo: string | null): void` --
    appends one JSON object per line to
    `~/.apra-fleet/data/code-intelligence/usage.jsonl`:
    `{ ts: ISO8601, tool: string, target: string, repo: string | null }`.
    `target` is the symbol/query/name argument as given.
  - Rotation: before append, if file size > 5 MB rename to `usage.jsonl.1`
    (overwrite any existing .1) and start fresh. Simple, lossy-by-design (D8).
  - Write is fs.appendFile fire-and-forget wrapped in try/catch (including
    mkdir of the parent dir on first write); a telemetry failure must NEVER
    surface to the caller (D8).
- Wiring (design D8: "recording happens in the shared tool-handler layer, NOT
  inside GitNexusProvider -- provider stays a pure proxy"): in each code_*
  handler in src/index.ts (code_graph, code_impact, code_query, code_context,
  plus code_map/code_flow from Phase 2 and code_tests from T4.4 if they were
  built), call recordUsage(toolName, <symbol|target|query|name arg>, input.repo
  ?? null) before/alongside the provider call. Keep it one line per handler; do
  not touch code-intelligence-gitnexus.ts.
- Tests (tests/code-intelligence-telemetry.test.ts): append format (exact JSON
  keys, ISO ts, repo null when absent); rotation trigger (mock fs stat > 5MB ->
  rename called with overwrite semantics, fresh file appended); error isolation
  (fs throws -> recordUsage never throws). If module keeps any state, KB
  constraint 1 (vi.resetModules + dynamic import) applies.
- Done: every code_* call is recorded, failures invisible to callers, tests
  green.

### T4.2 fleet_status: top symbols (30d)

- type: work
- model: claude-haiku-4-5
- File: `src/tools/check-status.ts`. Extend the existing code-intel section
  (codeIntelligenceHealth / codeIntelligenceCompactLine -- follow their
  degraded-safe pattern exactly: every IO call try/caught, never throw, omit on
  failure).
- Behavior (design D8 read spec): single pass over
  `~/.apra-fleet/data/code-intelligence/usage.jsonl` AND `usage.jsonl.1` if
  present; parse each line (skip unparseable lines), filter `ts >= now - 30d`,
  aggregate count by `target`, take top 5 by count. Keep it fast: one pass, cap
  total bytes read (files are already size-capped at ~5MB each by rotation).
- Surface in BOTH formats: JSON -- add `topSymbols: [{ target, count }, ...]`
  to the codeIntelligence object; compact -- append
  `top symbols (30d): a (12), b (9), ...` to the code-intel line. No usage
  file or any error -> field/segment omitted entirely (try/catch around the
  whole computation).
- Tests (extend tests/fleet-status-code-intelligence.test.ts): top-N
  aggregation (ties, fewer than 5 targets), 30d time filter excludes old
  entries, reads .1 file too, unparseable lines skipped, error isolation
  (missing file / bad JSON -> section omitted, no throw).
- Done: json + compact both show top 5, all failure modes silent, tests green.

### T4.3 isTestPath pure function

- type: work
- model: claude-haiku-4-5
- New file `src/tools/code-intelligence-tests.ts`. Exported pure function
  exactly per design D9: `isTestPath(path: string): boolean` -- true when any
  path segment is `test`, `tests`, or `spec` (case-insensitive), or the
  filename matches `/\.(test|spec)\.[^.]+$/`. Handle both `/` and `\`
  separators (Windows paths appear in child output on this platform). No other
  exports needed yet (T4.4 adds to this file or imports from it).
- Tests (tests/code-intelligence-tests.test.ts): segment matches
  (`tests/foo.ts`, `src/TESTS/x.ts`, `a\spec\b.ts`); filename matches
  (`foo.test.ts`, `bar.spec.js`); negatives (`contest/file.ts`,
  `attest.ts`, `testfile.ts`, `src/lib/protest.spec` without extension after
  spec -- verify regex requires `.something` after `.test`/`.spec`);
  mixed-separator paths.
- Done: function + exhaustive table-driven tests green.

### T4.4 code_tests tool (test-to-symbol mapping)

- type: work
- model: claude-sonnet-4-6
- Gated by T1.1. Decision rule (Decisions table, upstream-traversal row): if
  the child's impact/graph surface supports upstream traversal usable for
  "callers of X, transitively, depth <= 2" -> compose it; else -> descope:
  no code, record gap in docs/code-intelligence-child-surface.md +
  progress.json notes with a backlog item. Do NOT parse ladybugdb directly.
- If building: input schema `codeTestsSchema` in
  src/tools/code-intelligence.ts: `{ symbol: string, repo?: string }`. Add
  `tests(params)` to CodeIntelligenceProvider + GitNexusProvider, routed
  through callGitNexus (upstream impact/graph query per the surface doc, depth
  fixed at 2 -- design D9), then filter the returned callers to test paths
  using `isTestPath` from src/tools/code-intelligence-tests.ts (T4.3). Output:
  the test files/functions that transitively call the symbol.
- Register in src/index.ts; description tells agents the use (requirements
  P9), e.g.: 'Find the test files and test functions that exercise a symbol
  (transitive callers, depth 2). Use this to run targeted tests for the code
  you changed instead of the full suite. Prefer this over Grep for test
  discovery -- the call graph is pre-indexed.'
- Wire telemetry recording in the handler like the other tools (T4.1 pattern).
- Tests: mocked child response filtering (mixed test/product callers -> only
  test paths remain; depth semantics per mocked shape); missing-index error
  path reuse; schema validation. KB constraint 1 (vi.resetModules + dynamic
  import + vi.hoisted mocks) applies verbatim -- gitnexus module singletons.
- Done: tool registered + tested, or documented descope with backlog note in
  progress.json.

### T4.5 VERIFY Phase 4 (final)

- type: verify (no model)
- Same sequence as T1.4: npm run build; npm test (only the 2 pre-existing
  timezone failures in tests/time-utils.test.ts, beads yashr-302, may fail);
  npx gitnexus analyze (non-fatal); then per KB constraint 2 run
  `git checkout -- AGENTS.md CLAUDE.md` to discard injected non-ASCII markers.
  Additionally: final ASCII sweep over all files changed this sprint (reject
  any non-ASCII byte); confirm every investigation outcome (P1 child surface,
  P2 embeddings) is reflected in docs/ + progress.json notes even where
  descoped (sprint-wide done criteria). Push branch. Never push main. NO PR.

## Task summary

| Phase | Tasks | Models |
|-------|-------|--------|
| 1 | T1.1 spike (opus), T1.2 spike (sonnet), T1.3 P4b (opus), T1.4 verify | 2 opus, 1 sonnet |
| 2 | T2.1 code_map (sonnet), T2.2 code_flow (sonnet), T2.3 embeddings (sonnet), T2.4 verify | 3 sonnet |
| 3 | T3.1 reindex module (sonnet), T3.2 wiring (sonnet), T3.3 P4a (sonnet), T3.4 verify | 3 sonnet |
| 4 | T4.1 telemetry (sonnet), T4.2 fleet_status (haiku), T4.3 isTestPath (haiku), T4.4 code_tests (sonnet), T4.5 verify | 2 sonnet, 2 haiku |

13 work/spike tasks: 2 x claude-opus-4-8, 9 x claude-sonnet-4-6,
2 x claude-haiku-4-5. 4 VERIFY tasks (no model). 17 tasks total.
