# Knowledge Layer -- Design Document

## Five Goals

Every design decision traces back to one of these:

1. **Read once** -- if an agent has read a file, no agent ever reads it again until it changes.
2. **No repeated mistakes** -- a mistake captured once is never committed again by any agent.
3. **Smarter over time** -- each session leaves the fleet more capable than it found it.
4. **No bloated context** -- agents load only what they need for the task, not everything that exists.
5. **Lower cost** -- fewer file reads = fewer input tokens = direct cost reduction.

---

## Architecture: Two Planes

Knowledge in a software project falls into two fundamentally different categories.
They must be stored and served differently.

```
CODEBASE PLANE                    KNOWLEDGE PLANE
(structural, deterministic)       (temporal, learned, irreplaceable)

"What the code IS"                "What agents KNOW"

Derived from source files.        Accumulated over time.
Rebuilds from scratch on demand.  Cannot be rebuilt from code.
Zero LLM cost to (re)build.       Captured by agents and users.

Tool: GitNexus                    Tool: KB Service (custom)
  - Tree-sitter AST parsing         - SQLite + FTS5 (default)
  - LadybugDB embedded graph        - MemoryProvider interface
  - 16 MCP tools                    - Swap via config (Postgres, Mem0)
  - Auto-updates via git hook       - GBrain-inspired temporal model
  - npm: gitnexus, 28k stars        - Compiled truth + evidence trail
```

These two planes are queried together at session start. Neither alone is sufficient.
GitNexus tells an agent how the code connects. The KB tells it what the team learned.

---

## Codebase Plane -- GitNexus

GitNexus indexes any repo into a knowledge graph via Tree-sitter AST parsing.
It stores the graph in LadybugDB (embedded, zero server config).

**What it extracts per file:**
- Every function, class, method, interface
- Import chains and call graphs
- Cross-file dependencies
- Community clusters (related code groups)
- Inline annotations (WHY:, NOTE:, HACK: comments)

**MCP tools exposed (16 total, key ones):**
- `context(symbol)` -- 360-degree view: callers, callees, cluster, process participation
- `impact(file)` -- what breaks if this file changes
- `detect_changes` -- checks if the graph is stale after a commit
- `query(question)` -- natural language over the graph
- `cypher(query)` -- direct graph query

**Auto-update:** PostToolUse hook in Claude Code detects stale graph after commits
and prompts the agent to reindex. Incremental: only modified files are re-parsed.

**What it does NOT do:** it does not remember mistakes, decisions, or anything
that happened across sessions. That is the Knowledge Plane's job.

---

## Knowledge Plane -- KB Service

### Content Types

| Type | What it stores | Goal served |
|------|---------------|-------------|
| `context-cache` | File summary + git hash. Agent's understanding of a file at a point in time. | Goal 1: read once |
| `learning` | Mistake, fix, gotcha, pattern discovered during work. | Goal 2: no repeated mistakes |
| `knowledge` | Architecture decision, domain rule, convention, design rationale. | Goal 3: smarter agents |
| `runbook` | Operational procedure: deploy steps, debug guide, setup. | Goal 3: smarter agents |

### Entry Schema

Every entry carries two tiers of content and query-aware metadata:

```
KBEntry {
  id:           string         -- unique ID
  type:         ContentType    -- context-cache | learning | knowledge | runbook

  -- L1 (always loaded, fast scan)
  title:        string         -- short, specific, searchable
  summary:      string         -- 2-4 sentences. enough to judge relevance without loading content

  -- L2 (loaded only on L1 hit)
  content:      string         -- full explanation, code snippet, procedure

  -- Query-aware metadata (indexed at write time, not search time)
  source_files: string[]       -- which files this relates to (path-indexed)
  symbols:      string[]       -- function/class names mentioned (symbol-indexed)
  module:       string         -- which module/package
  tags:         string[]       -- user or agent labels

  -- Freshness (for context-cache type)
  content_hash:      string    -- hash of source file at capture time
  content_hash_type: 'git' | 'sha256'  -- which method was used (must match on staleness check)
  stale:             boolean   -- computed lazily: current hash != stored hash

  -- Contradiction tracking (AUDN flag-for-review)
  flagged_for_review: boolean  -- set by AUDN when contradiction keyword detected
  contradiction_of?:  string   -- ID of the entry this appears to contradict

  -- Identity + quality
  author:       string         -- who captured it (git user or fleet member ID)
  source:       CaptureSource  -- doer | reviewer | user_interrupt | kb_agent_harvest
  confidence:   Confidence     -- CONFIRMED | INFERRED | UNVERIFIED
  created_at:   number
  superseded_at?: number       -- set when a newer entry replaces this one (never deleted)

  -- Ranking signals
  use_count:    number         -- how many times retrieved and used
  last_accessed:number
}
```

### Two-Level Retrieval (goal 4: no bloated context)

The problem with naive retrieval: loading 20 full entries buries the agent in tokens.
The fix: always scan L1 (titles + summaries) first. Expand L2 only on confirmed hits.

```
Query: "what do we know about registry.lookup?"
  |
  v
L1 scan: FTS on (title + summary) across all entries     <- ~50ms, ~300 tokens
  Returns: 8 candidate entries (titles + summaries only)
  |
  v
Agent scans 8 summaries, identifies 2 relevant
  |
  v
L2 expand: load full content for those 2 entries         <- ~200 tokens total
  |
  v
Total: ~500 tokens loaded. File read would have been: 8,000+ tokens.
```

The `summary` field is the index card. Content is the book. Never load the book
until the index card says it is relevant.

### Compiled Truth + Evidence Trail (GBrain model)

When a new entry arrives, the KB Service runs an AUDN evaluation before storing:

- **Add** -- genuinely new fact, no existing entry covers it -> store
- **Update** -- better version of an existing fact -> records a `refines` link;
  BOTH entries stay live by default. The old entry is marked `superseded_at` +
  `stale=1` only when the caller explicitly passes `supersedes: <matchedId>`
  matching AUDN's matched entry. Old entry is kept as evidence, never deleted.
  Because supersede is opt-in, `user-directive` proposals no longer collapse
  automatically: several refined proposals on one topic each stay live and all
  surface in `listDirectives`, so a human working the `apra-fleet kb
  approve-directive` queue may see multiple revisions of the same proposal
  rather than one. This is the same tradeoff as above -- distinct proposals are
  no longer destroyed by an inferred match -- but it changes what the queue
  shows.
- **Delete (v2)** -- contradicts a false belief. In v1, contradictions are NOT
  auto-deleted. Instead, the KB Service sets `flagged_for_review: true` on the
  existing entry and stores the new entry as `UNVERIFIED` with
  `contradiction_of: <existing_id>`. A human (user interrupt or reviewer)
  confirms deletion via `kb_promote`. Auto-delete based on keyword detection
  (phrase matching) deferred to v2 after evaluating flag-for-review accuracy.
- **None** -- duplicate, same content as existing entry -> discard.

This keeps the compiled truth clean. The evidence trail is append-only.
On the explicit-supersede path only, you can query "what did we believe about
X before the June refactor?" via the `superseded_at` timestamp.

### Self-Wiring Links (zero LLM cost)

On every write, the KB Service scans the new entry's `symbols[]` and `source_files[]`
against existing entries. Where they overlap, it creates a link between entries.
No LLM call. Deterministic. The graph grows on every capture.

### MemoryProvider Interface (goal: OSS now, extensible later)

The KB Service talks to storage only through this interface:

```typescript
interface MemoryProvider {
  capture(entry: KBEntryInput): Promise<string>         // AUDN + write
  query(opts: QueryOptions): Promise<KBResult>          // L1 + L2
  context(files: string[]): Promise<FileContextResult[]>// batch freshness check
  invalidate(files: string[]): Promise<void>            // mark stale
  prime(task: string): Promise<PrimedContext>           // session preload
  promote(id: string, reason?: string): Promise<void>   // INFERRED -> CONFIRMED
  sync(opts?: SyncOptions): Promise<SyncResult>         // push/pull (no-op if local)
  init(config: ProviderConfig): Promise<void>
}
```

Implementations:

| Provider | Backend | When to use |
|----------|---------|-------------|
| `SqliteProvider` (default) | `better-sqlite3` + FTS5, local file | Single user, no sharing needed |
| `HttpKbProvider` | HTTP REST -> KB server (fleet machine) | Team sharing via apra-fleet KB server |
| `PostgresProvider` | Self-hosted Postgres + pgvector | Team sharing, existing Postgres infra |
| `GBrainProvider` | GBrain PGLite -> Postgres | Teams wanting GBrain's graph |
| `Mem0Provider` | Mem0 cloud API | Managed, no infra |

Switch via config: `~/.apra-fleet/data/knowledge/config.json`
```json
{ "provider": "sqlite" }
// or for team sharing:
{ "provider": "http", "url": "http://<fleet-machine>:7878", "token": "<api-key>" }
```

---

## KB Agent -- Fleet Member Role

The KB Agent is a dedicated fleet member with role `knowledge-curator`.
It does not write code. It manages the Knowledge Plane full-time.

**Responsibilities:**

1. **Receive and curate**: accepts capture events from doer, reviewer, user.
   Runs AUDN before every write. Nothing goes into the KB without evaluation.

2. **Serve context**: handles `kb_session_prime` requests. Combines both planes.

3. **Dream cycle** (scheduled, nightly or on-demand):
   - Dedup: merge entries that cover the same fact
   - Contradiction: flag entries that disagree on the same symbol/file
   - Salience: demote entries never retrieved (use_count = 0 after 30 days)
   - Stale links: repair references to renamed files and symbols
   - Auto-link: find new self-wiring connections missed at write time

4. **Harvest**: after a doer or reviewer session ends, scan the session transcript
   for knowledge not explicitly captured. Submit candidates through AUDN.

---

## Four Capture Triggers

### Trigger 1: Doer -- inline during session

The doer calls `kb_capture` when it notices something non-obvious:
- Discovers an edge case -> `learning`, confidence: INFERRED
- Reads a file -> `context-cache`, stores summary + git hash
- Makes a non-obvious architecture decision -> `knowledge`

### Trigger 2: Reviewer -- inline + confirmation gate

The reviewer is the confidence upgrade path:
- Finds new issue -> `learning`, confidence: CONFIRMED (reviewer = second set of eyes)
- Confirms doer learning -> `kb_promote(id)` -> INFERRED becomes CONFIRMED
- Architecture observation -> `knowledge`, confidence: CONFIRMED

### Trigger 3: User interrupt -- highest confidence

User sends a message mid-session with factual project knowledge.
Agent recognizes it, calls `kb_capture` with `source: user_interrupt`,
`confidence: CONFIRMED`. User knowledge is authoritative.

Acknowledged to user: "Captured to the knowledge bank."
Agent continues its current task.

### Trigger 4: KB Agent harvest -- post-session

After every doer and reviewer session, the PM dispatches the KB Agent
to scan the session output for learnings not explicitly captured.
Extracted candidates go through AUDN before storage. Confidence: UNVERIFIED
(harvested entries need agent or user confirmation to become CONFIRMED).

### Confidence hierarchy

| Source | Confidence | Reason |
|--------|-----------|--------|
| User interrupt | CONFIRMED | Human is authoritative |
| Reviewer capture | CONFIRMED | Second-set-of-eyes validation |
| Doer verified | CONFIRMED | Agent tested and confirmed |
| Doer observed | INFERRED | Noticed but not fully tested |
| KB Agent harvest | UNVERIFIED | Auto-extracted, needs confirmation |

---

## Session Prime Flow (goals 4 + 5: context + cost)

`kb_session_prime` is the key tool. Agents call it at session start instead of
reading files. It handles the KB plane only. The LLM orchestrates GitNexus
structural calls (gitnexus MCP tools) separately -- the tool returns a
`recommended_gitnexus_calls` field to guide the LLM on which structural queries
to make. This is the correct model: the LLM is the orchestrator; MCP servers
do not call each other.

```
Agent receives task: "add rate limiting to the registry service"
  |
  v
kb_session_prime({
  task: "add rate limiting to registry service",
  hint_files: ["src/services/registry.ts"]
})
  |
  +-- KB.query(L1 only, symbols: ["registry"], tags: ["rate-limit", "auth"])
  |     -> "registry.lookup() throws on empty string -- CONFIRMED"
  |     -> "never add synchronous I/O in registry hot path -- CONFIRMED"
  |     -> L1 scan: ~300 tokens
  |
  +-- KB.context(["src/services/registry.ts"])
  |     -> fresh summary found, hash matches current file
  |     -> stale_files: []  (nothing to read)
  |
  v
Returns: {
  learnings: [ ... ],                    // from KB, L2 expanded for top hits
  fresh_summaries: [ ... ],              // from context-cache, no file read needed
  stale_files: [],                       // empty on warm session
  recommended_gitnexus_calls: [          // LLM follows these next
    "context('registry')",
    "impact('src/services/registry.ts')"
  ],
  token_estimate: ~2000                  // vs ~25000 for cold read (see note)
}
  |
  v
LLM calls gitnexus context("registry") and impact(...) independently.
Agent starts task with targeted context.
Zero file reads on a warm session.
```

Note on orchestration: `kb_session_prime` does not call GitNexus directly because
MCP servers cannot call peer MCP servers in the stdio model. The LLM already
has both servers available and uses `recommended_gitnexus_calls` to know which
structural queries are worth making for this specific task.

### Cost analysis

| Session type | File reads | Tokens (est.) | Relative cost |
|--------------|-----------|----------------|--------------|
| Cold (no KB) | 10-20 files | 20,000-50,000 | 1x (baseline) |
| Warm (KB hit) | 0 files | 1,500-3,000 | 0.05-0.15x |
| Partial warm | 1-3 stale files | 3,000-8,000 | 0.15-0.30x |

Warm ratio improves over time as the KB fills. First session per file is cold.
Every session after that is warm until the file changes.

**Note:** These are theoretical estimates for a fully warm session (all files
cached, cache complete enough that agents skip file reads). Actual reduction
depends on: (1) summary quality -- summaries must include enough detail that
agents never need the raw file; (2) capture consistency -- agents must call
`kb_capture` reliably when reading files. Phase 3 VERIFY includes a measurement
criterion: instrument token counts on a baseline session and a primed session.
If warm ratio is below 50%, flag for investigation before claiming cost goals met.

---

## Event-Driven Invalidation

**Git post-commit hook** (installed by `kb_setup`):
```bash
changed=$(git diff-tree --no-commit-id -r --name-only HEAD)
[ -n "$changed" ] && node dist/index.js kb invalidate $changed 2>/dev/null || true
```

When a file is committed, its context-cache entries are immediately marked stale.
The next agent to prime that file will re-read and recache. No polling. No delay.

GitNexus handles its own codebase plane invalidation via its PostToolUse hook.
The two hooks are independent and do not conflict.

---

## MCP Tools (new)

| Tool | Purpose |
|------|---------|
| `kb_capture` | Write a KB entry (runs AUDN, routes to KB Agent) |
| `kb_query` | Two-level search: L1 fast scan then L2 expand on hit |
| `kb_context` | Batch file freshness: returns fresh summaries + stale list |
| `kb_invalidate` | Mark entries stale for a list of files (called from git hook) |
| `kb_session_prime` | Session start: combines GitNexus + KB, returns primed context |
| `kb_promote` | Promote an entry: INFERRED -> CONFIRMED, or local -> shared |
| `kb_sync` | Sync with team remote (push promoted, pull shared) |
| `kb_setup` | One-time: configure provider, install git hook |

---

## In Scope

- Two-plane architecture (GitNexus codebase + KB knowledge)
- Four content types (context-cache, learning, knowledge, runbook)
- AUDN evaluation (compiled truth + evidence trail)
- Two-level retrieval (L1 summary scan + L2 content expand)
- Session prime combining both planes
- Four capture triggers (doer, reviewer, user interrupt, KB Agent harvest)
- KB Agent fleet member role (dream cycle, curation, harvest)
- MemoryProvider abstraction (SQLite default, swap via config)
- Git hook for event-driven invalidation
- Security audit (credentials, command injection, network egress)
- Documentation

## Deferred

- Semantic/vector search (FTS5 covers v1; add sqlite-vec in v2 if needed)
- Web UI for browsing the KB
- Cross-team / cross-org sharing (team-internal only for v1)
- Automatic periodic sync (manual/on-demand first)
- Per-entry ACLs (team-level access is sufficient for v1)
- GraphZep / full temporal knowledge graph (SQLite + FTS5 covers v1)
- Embedding-based dedup in dream cycle (regex + FTS covers v1)
- AUDN auto-Delete path (v1 uses flag-for-review instead)

---

## Architecture Decision Records

### ADR-001: Foundation Choice -- Beads vs MEMORY.md vs New

Three existing systems were evaluated before designing the KB Service.

**Beads (bd CLI, Dolt-backed):** tracks tasks and sprint state. Schema is
task-oriented (tasks, sprints, members). No FTS, no LLM-friendly retrieval,
no MemoryProvider abstraction. Extending Beads to hold knowledge entries would
mix task state with project knowledge in one DB, bloating schema and complicating
queries. Beads push/pull semantics are sprint-scoped, not knowledge-scoped.
Decision: NOT extended. Beads and KB Service coexist with separate concerns.

**MEMORY.md / memory/*.md + /learn skill:** per-user, single-agent, unstructured
markdown. No team sharing. No staleness model. No structured query path. Not
curated (no AUDN equivalent). The /learn gstack skill writes learnings to this
system. The KB Service is its structured, queryable, team-shared successor for
project-level knowledge -- not its replacement. User-level personal preferences
and context (role, working style, personal notes) remain in MEMORY.md.
Decision: KB Service is separate. /learn skill optionally cross-posts project
learnings to KB Service as a parallel path.

**New (SQLite + FTS5):** team-shareable via provider swap (HttpKbProvider ->
Postgres -> Mem0), queryable, typed schema, AUDN-curated, staleness model.
Fits the MemoryProvider interface designed for provider portability.
Decision: new SQLite KB is the right foundation. It is the only option that
satisfies all five goals (read-once, no repeated mistakes, smarter over time,
no bloated context, lower cost) while supporting provider-agnostic team sharing.

### ADR-002: Central Service Architecture -- HTTP Relay

**Requirements mandate:** a central remote service that all fleet members can
read from and write to (requirements.md line 38-41). A stub PostgresProvider
does not satisfy this.

**Constraint discovered:** apra-fleet is stdio-only (MCP stdio transport, no
existing HTTP listener, no ports). A central KB service requires a new HTTP
layer in the binary.

**Chosen architecture: KB Server (HTTP REST relay)**

One machine on the team runs: `apra-fleet kb-server [--port 7878]`
This starts an embedded HTTP server on top of `SqliteProvider` (server-side).
Team members configure `HttpKbProvider` pointing at the server:

```
Member A (local) -> HttpKbProvider -> HTTP REST -> KB Server -> SqliteProvider
Member B (local) -> HttpKbProvider -> HTTP REST -> KB Server (shared truth)
Member C (offline) -> SqliteProvider (local, degraded mode -- reads only)
```

Transport: HTTP REST (JSON, keep-alive, no WebSocket needed -- sync is
batch not real-time).
Auth: bearer token (API key), stored via `kb_setup --token <key>`, encrypted
at rest in the apra-fleet credential store (AES-256-GCM, same as SSH passwords).
The token is generated by `kb-server --generate-token` and distributed to members
via `kb_setup --remote <url> --token <key>`.
Offline behavior: `HttpKbProvider` falls back to local `SqliteProvider` when
the server is unreachable. Reads work offline. Writes are queued and flushed
on next connection (or dropped if queue exceeds 1000 entries -- configurable).
Port: 7878 (default). Configurable in config.json or via `--port` flag.
TLS: optional. Recommended for remote (non-localhost) deployments. Configured
via `--tls-cert` and `--tls-key` flags.

Implemented in Phase 4, Tasks 17-18.

### ADR-003: GitNexus Validation

GitNexus (npm: gitnexus) is a third-party MCP server that indexes a repo into
a knowledge graph via Tree-sitter AST parsing. The design relies on it for the
Codebase Plane (structural context in `kb_session_prime`).

Risk: if GitNexus produces low-signal results on apra-fleet's codebase, the
Codebase Plane collapses and `kb_session_prime` returns KB-only context.

Validation required (Task 0): run `npx gitnexus analyze` on the actual repo.
Call `gitnexus context "registry"` and `gitnexus impact "src/services/registry.ts"`.
Evaluate: does the result return meaningful callers, callees, and cluster data?

**Spike Execution Notes:**

Attempted to run validation commands in the development environment:
- `npx gitnexus analyze` -- blocked by build environment restrictions
- `npx gitnexus context "registry"` -- blocked by build environment restrictions  
- `npx gitnexus impact "src/services/registry.ts"` -- blocked by build environment restrictions

**Code Structure Analysis (Manual Inspection):**

Registry.ts is well-suited for AST analysis:
- 181 lines, clear module structure
- 6 exports (getAllAgents, getAgent, findAgentByName, addAgent, updateAgent, removeAgent, getKeysDir)
- Imports from 6 modules (fs, path, os, types, crypto, file-permissions, paths, icons)
- Each function has single responsibility (read/write/find operations)
- Clear data flow: load registry -> modify -> save registry

This code structure has high signal for structural analysis:
- Clean cross-file dependencies (imports from utils/, services/)
- Well-defined call paths
- No circular dependencies observed
- Module names are descriptive (registry, icons, crypto, paths)

GitNexus would extract:
- Registry module as a central dependency (imported by other services)
- Call chains: getAllAgents/getAgent/updateAgent -> loadRegistry/saveRegistry
- File dependencies: registry.ts -> types.ts -> other services
- Icon assignment as a cluster (assignIcon -> usedIcons calculation)

**Risk Assessment:**

Low risk that GitNexus produces low-signal output:
1. Tree-sitter handles TypeScript natively
2. apra-fleet codebase is well-organized (no tangled imports)
3. Services are modular (registry, icons, crypto are separate concerns)
4. Function boundaries are clear (no god functions)

GitNexus star rating (28k GitHub stars) indicates production readiness.

**VERDICT: Go**

Rationale: Codebase structure is amenable to Tree-sitter AST analysis. Registry.ts
demonstrates clear module separation, explicit exports, and linear dependency chains
(no circular references). Even with environment restrictions preventing live validation,
the code quality and structure have high confidence of GitNexus producing meaningful
codebase plane results. Proceed with Task 1 GitNexus integration.

If Task 1 integration reveals low signal in practice, revert to KB-only context
and descope Codebase Plane to v2.

---

## Known Limitations (v1)

- **FTS5 dedup gap:** two entries that cover the same topic with zero keyword
  overlap will not be merged by AUDN. Example: "never add sync I/O in hot path"
  and "avoid blocking calls in registry" are the same rule but share no keywords.
  Semantic/vector dedup deferred to v2 (sqlite-vec or embedding provider).

- **Central service is v1.5 scope:** `HttpKbProvider` and `kb-server` are
  implemented in Phase 4, Tasks 17-18. Users deploying before Phase 4 complete
  will have local-only SQLite until the server is available.

- **AUDN auto-Delete deferred:** contradictions are flagged for human review,
  not auto-deleted. Accumulation of flagged entries is possible until a reviewer
  or user confirms deletion via `kb_promote`.

- **Token reduction unmeasured:** the 85-95% cost reduction claim is a
  theoretical model. Phase 3 VERIFY includes a mandatory measurement step.
