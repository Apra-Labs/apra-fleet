<!-- /autoplan restore point: /c/Users/yashr/.gstack/projects/Apra-Labs-apra-fleet/feat-knowledge-bank-autoplan-restore-20260611-014531.md -->
# apra-fleet -- Knowledge Layer Implementation Plan

> Two-plane architecture: GitNexus (codebase structure) + KB Service (learned
> knowledge). Five goals: read files once, never repeat mistakes, smarter agents,
> no bloated context, lower cost. KB Agent as a fleet member role. MemoryProvider
> abstraction lets the team start with SQLite and upgrade to Postgres or Mem0 via
> config swap with no code change.

---

## Tasks

### Phase 0: Validation + ADRs

No code. Validates the two riskiest assumptions and writes the three ADRs
required by requirements.md before any feature work begins.

#### Task 0: Foundation ADRs + GitNexus Spike

- **Change:** ADR-001 and ADR-002 are already written in `design.md` (design
  review output). This task runs the GitNexus spike to produce evidence for
  ADR-003, which currently has the decision criteria but not the actual result.
  Run on the actual repo:
  ```
  npx gitnexus analyze
  gitnexus context "registry"
  gitnexus impact "src/services/registry.ts"
  ```
  Update ADR-003 in `design.md` with the actual output and state the explicit
  Go/No-Go verdict. If No-Go: also update `design.md` to descope the Codebase
  Plane (remove GitNexus from In Scope, move to Deferred), and note that
  `recommended_gitnexus_calls` is removed from Task 10 spec.
  No other code changes.
- **Files:** `design.md`
- **Tier:** cheap
- **Done when:** ADR-003 contains actual `gitnexus context` output snippet and
  an explicit "VERDICT: Go" or "VERDICT: No-Go" statement. If No-Go, Codebase
  Plane descoped in design.md and Task 1 marked skipped.
- **Blockers:** None. First task.

#### VERIFY: Phase 0

- ADR-001 documents Beads vs MEMORY.md vs new with explicit trade-offs.
- ADR-002 documents HTTP relay architecture (transport, auth, port, offline).
- ADR-003 states GitNexus Go/No-Go with evidence.
- No code changes.

---

### Phase 1: Foundation

Installs both planes before any user-facing feature. Everything in Phase 2+
depends on this being solid. No MCP tools yet -- just infrastructure.

#### Task 1: GitNexus Integration

- **Change:** Add `gitnexus` to `.mcp.json` as a new MCP server alongside the
  existing apra-fleet server. Run `npx gitnexus analyze` on the repo to build
  the initial graph. Verify the 16 MCP tools respond (`context`, `impact`,
  `detect_changes`, `query`, `cypher`, etc.). Document the GitNexus config in
  `docs/knowledge-layer.md` (stub -- to be filled in Phase 4).
- **Files:** `.mcp.json`, `docs/knowledge-layer.md`
- **Tier:** cheap
- **Done when:** `gitnexus context "registry"` returns a populated 360-degree
  view in Claude Code. `detect_changes` returns clean on a fresh repo state.
  GitNexus PostToolUse hook installed and fires after a test commit.
- **Blockers:** Task 0 GitNexus spike returned Go. If No-Go, skip Task 1 entirely
  and remove `recommended_gitnexus_calls` from Task 10 spec.

#### Task 2: MemoryProvider Interface + KBEntry Types

- **Change:** Create `src/services/knowledge/types.ts` with:
  - `ContentType` union: `context-cache | learning | knowledge | runbook`
  - `Confidence` union: `CONFIRMED | INFERRED | UNVERIFIED`
  - `CaptureSource` union: `doer | reviewer | user_interrupt | kb_agent_harvest`
  - `KBEntry` interface (full schema: id, type, title, summary, content,
    source_files, symbols, module, tags, content_hash, content_hash_type,
    stale, flagged_for_review, contradiction_of, author, source,
    confidence, created_at, superseded_at, promoted_at, use_count, last_accessed)
    Note: `content_hash_type: 'git' | 'sha256'` -- records which method was
    used at capture time so checkStaleness uses the same method.
    `flagged_for_review: boolean` -- set by AUDN contradiction detection.
    `contradiction_of?: string` -- ID of the entry this contradicts.
  - `KBEntryInput` (omit: id, stale, superseded_at, use_count, last_accessed)
  - `QueryOptions`, `KBResult`, `FileContextResult`, `PrimedContext`,
    `SyncOptions`, `SyncResult`, `ProviderConfig` interfaces
  - `MemoryProvider` interface (8 methods: capture, query, context, invalidate,
    prime, promote, sync, init)
  - `AudnDecision` type: `'add' | 'update' | 'flagged' | 'none'`
    ('flagged' replaces 'delete' in v1: contradiction detected, flagged for human review.
    'delete' is reserved for v2 auto-delete path.)
  - `GitNexusCall` type: `{tool: string; args: Record<string, string>}`
  - `PrimedContext.recommended_gitnexus_calls: GitNexusCall[]` (structured,
    not pseudo-code strings)
- **Files:** `src/services/knowledge/types.ts`
- **Tier:** standard
- **Done when:** File compiles with zero errors. All types are exported.
  No implementation yet -- interface only.
- **Blockers:** None.

#### Task 3: SQLiteProvider -- Schema, FTS5, Init

- **Change:** Create `src/services/knowledge/sqlite-provider.ts` implementing
  `MemoryProvider` with `better-sqlite3`:
  - DB path: `~/.apra-fleet/data/knowledge/kb.sqlite`
  - Table `entries`: all KBEntry columns. JSON columns for arrays
    (source_files, symbols, tags).
  - FTS5 virtual table `entries_fts` on (title, summary, content, tags).
    Triggers to keep FTS in sync on insert/update/delete.
  - Indexes: `(type)`, `(confidence)`, `(created_at)`, `(superseded_at)`,
    `(use_count)`.
  - `init()`: creates DB and tables if not present (idempotent).
    On init, set SQLite pragmas: `PRAGMA journal_mode=WAL`,
    `PRAGMA busy_timeout=5000`, `PRAGMA synchronous=NORMAL`,
    `PRAGMA cache_size=-20000`. WAL mode is required for concurrent
    agent access (doer + reviewer write simultaneously).
  - DB path: `path.join(FLEET_DIR, 'knowledge', 'kb.sqlite')` where
    `FLEET_DIR` is imported from `src/paths.ts`. Do NOT hardcode
    `~/.apra-fleet` -- respect `APRA_FLEET_DATA_DIR` env override.
  - FTS5 virtual table `entries_fts` on (title, summary, content, tags).
    Use content-indexed triggers. FTS5 UPDATE must be DELETE + INSERT:
    ```sql
    CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
      VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      INSERT INTO entries_fts(rowid, title, summary, content, tags)
      VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
    END;
    ```
    Direct FTS5 UPDATE is not supported -- always DELETE + INSERT.
  - Content cap: truncate `content` at 4,000 chars at write time
    (append '...[truncated]' suffix).
  - All queries use better-sqlite3 prepared statements via `db.prepare()`.
    No string concatenation in SQL. Security audit (Task 15) verifies.
  - better-sqlite3 is synchronous. All SqliteProvider methods are `async`
    but wrap synchronous calls in implicit resolved Promises. Do NOT use
    `await` on `db.prepare().run()` calls.
  - Stub implementations for all 8 MemoryProvider methods (throw
    `NotImplementedError` for methods not yet done).
  - `KBService` class in `src/services/knowledge/kb-service.ts`:
    wraps provider, holds config, exposes `getProvider()`.
  - `getKBService()` singleton factory.
  Add `better-sqlite3` and `@types/better-sqlite3` to package.json.
- **Files:** `src/services/knowledge/sqlite-provider.ts`,
  `src/services/knowledge/kb-service.ts`, `package.json`
- **Tier:** standard
- **Done when:** `better-sqlite3` installs and builds. `init()` creates the
  DB file. FTS5 virtual table confirmed with a direct `SELECT` in a test.
  All 8 stub methods present. `npm run build` succeeds.
- **Blockers:** Task 2 (types). `better-sqlite3` may need native build tools
  (node-gyp) -- document in troubleshooting if so.

#### Task 4: computeFileHash + Staleness Logic

- **Change:** Add to `src/services/knowledge/kb-service.ts`:
  - `computeFileHash(filePath: string): Promise<{hash: string; type: 'git' | 'sha256'} | null>`:
    try `git hash-object <filePath>` via `child_process.execFile` (NOT exec).
    On success, return `{hash, type: 'git'}`. On failure or empty output,
    fall back to SHA-256: return `{hash: sha256hex, type: 'sha256'}`.
    If file does not exist: return `null` (caller handles as missing).
    If git output is empty string: treat as failure, fall back to SHA-256.
  - `computeFileHashBatch(filePaths: string[]): Promise<Record<string, {hash: string; type: 'git' | 'sha256'} | null>>`:
    batch version for performance. Uses single `execFile('git', ['hash-object', ...filePaths])`.
    Parses output line-by-line (one hash per file). Falls back to per-file SHA-256
    for any file git can't hash. Returns a map of filePath -> result.
    Used by `kb_context` to avoid N subprocess spawns.
  - `checkStaleness(entry: KBEntry): Promise<StalenessResult>`:
    if `entry.type !== 'context-cache'`, return `{stale: false}`.
    If `entry.content_hash === 'invalidated'`, return `{stale: true, reason: 'invalidated'}`.
    Run `computeFileHash(entry.source_files[0])` using `entry.content_hash_type`
    (git or sha256 -- must match what was used at capture time).
    If null (file missing), return `{stale: true, reason: 'file_missing'}`.
    If EACCES or unreadable, return `{stale: true, reason: 'unreadable'}`.
    Compare hash. Return `{stale: boolean, currentHash?: string}`.
  Unit tests for all staleness scenarios:
  - fresh file (hash matches)
  - modified file (hash mismatch)
  - deleted file (file_missing)
  - unreadable file (EACCES -> reason: 'unreadable')
  - non-git file (SHA-256 fallback)
  - `content_hash='invalidated'` (immediate stale)
  - `computeFileHashBatch` with 3 files (single git call, verify output parsing)
  - `computeFileHash` with non-existent file (returns null)
- **Files:** `src/services/knowledge/kb-service.ts`, `src/services/knowledge/kb-service.test.ts`
- **Tier:** standard
- **Done when:** Unit tests pass for all four staleness scenarios.
  `computeFileHash` returns different hashes after file modification.
  `checkStaleness` correctly identifies all three states (fresh, stale, missing).
  `npm test` passes.
- **Blockers:** Task 3 (KBService exists).

#### VERIFY: Phase 1 -- Foundation

- `gitnexus context "registry"` returns populated results in Claude Code.
- `gitnexus detect_changes` returns clean on unmodified repo.
- `npm run build` succeeds.
- `npm test` passes (staleness unit tests green).
- DB initializes at `~/.apra-fleet/data/knowledge/kb.sqlite`.
- FTS5 table exists and accepts inserts.
- No regressions in existing tools (`npm test` full suite).

---

### Phase 2: Write Path

Adds the capture pipeline: agents can write to the KB. AUDN ensures the
compiled truth stays clean. Git hook closes the invalidation loop.

#### Task 5: kb_capture MCP Tool

- **Change:** Create `src/tools/kb-capture.ts` and register in `src/index.ts`.
  Input schema:
  - `type` (required): ContentType
  - `title` (required): short description
  - `summary` (required): 2-4 sentences
  - `content` (required): full detail
  - `source_files` (optional): related file paths
  - `symbols` (optional): function/class names
  - `module` (optional): module name
  - `tags` (optional): labels
  - `source_file` (required when type=context-cache): file to hash
  The tool calls `computeFileHash` for context-cache entries, sets
  `source: 'doer'` by default (overridable), `confidence: 'INFERRED'`.
  Returns `{id: string, audn_decision: AudnDecision}`.
  Implement `SqliteProvider.capture()` fully, including AUDN evaluation:
  - FTS search for near-duplicate title/symbols/source_files.
  - If match found: compare content, decide Add/Update/Delete/None.
  - On Update: set `superseded_at` on old entry, insert new.
  - On None: return existing ID, skip write.
- **Files:** `src/tools/kb-capture.ts`, `src/index.ts`,
  `src/services/knowledge/sqlite-provider.ts`
- **Tier:** cheap
- **Done when:** Calling `kb_capture` creates an entry visible in the DB.
  Duplicate capture returns `audn_decision: none`. Updated fact supersedes
  old entry. `npm test` passes.
- **Blockers:** Task 4 (computeFileHash).

#### Task 6: kb_invalidate MCP Tool + Git Hook

- **Change:** Create `src/tools/kb-invalidate.ts` and register in `src/index.ts`.
  Input: `files: string[]` (list of file paths).
  Implement `SqliteProvider.invalidate()`: for each path, find all entries
  where `source_files` contains that path AND `type = 'context-cache'`
  AND `superseded_at IS NULL`. Set their `content_hash` to `'invalidated'`
  so next `checkStaleness` returns stale immediately without re-hashing.
  Add a CLI shim: `node dist/index.js kb invalidate <file1> <file2> ...`
  that calls `invalidate()` directly (no MCP needed, for git hook use).
  Add git hook installer to `kb_setup` (Task 14 will flesh out kb_setup fully,
  this task adds the hook template):
  ```bash
  # .git/hooks/post-commit
  git diff-tree --no-commit-id -r --name-only HEAD | while IFS= read -r f; do
    [ -n "$f" ] && node dist/index.js kb invalidate "$f" 2>/dev/null || true
  done
  ```
  Note: quoting `"$f"` handles file paths with spaces. `while read` handles
  multiple files correctly (one per line, not space-separated).
- **Files:** `src/tools/kb-invalidate.ts`, `src/index.ts`,
  `src/services/knowledge/sqlite-provider.ts`
- **Tier:** cheap
- **Done when:** Calling `kb_invalidate(["src/foo.ts"])` marks the context-cache
  entry for `src/foo.ts` as stale. Git hook fires after a test commit and
  invalidates changed files. Non-context-cache entries are not affected.
- **Blockers:** Task 5 (entries exist to invalidate).

#### Task 7: AUDN Evaluation -- Full Implementation

- **Change:** Harden the AUDN logic in `SqliteProvider.capture()`:
  - Implement semantic dedup: FTS search on title similarity above threshold.
  - Implement symbol overlap dedup: if `symbols` arrays intersect and
    `source_files` overlap, treat as same topic.
  - Implement Update path: when a `learning` or `knowledge` entry covers the
    same topic with higher confidence, supersede the old one.
  - Implement flag-for-review path (replaces Delete in v1): when new entry
    appears to contradict existing (keyword signals: "was wrong", "actually",
    "correction", "not true"), set `flagged_for_review: true` on existing entry,
    store new entry as UNVERIFIED with `contradiction_of: <existing_id>`.
    Do NOT auto-delete. Reviewer or user confirms deletion via kb_promote.
  - Add `flagged_for_review: boolean` column to `entries` table and type.
  - Self-wiring links: on every new entry, scan existing entries for shared
    symbols and source_files. Insert rows into a `links` table
    (from_id, to_id, link_type: 'shares_symbol' | 'shares_file').
  - Add `links` table to schema. Add `getLinked(id)` to provider.
  Unit tests covering all AUDN decisions and self-wiring:
  - Add: no existing match -> new entry stored
  - None: exact title+content duplicate -> skip, return existing ID
  - Update: same topic, higher confidence -> old entry superseded, new stored
  - flagged: contradiction keyword in new entry -> `flagged_for_review: true`
    on existing, new stored as UNVERIFIED with `contradiction_of: <id>`
  - Symbol overlap but different source_files and different title -> Add (NOT merge)
    (verifies AND-logic: single symbol overlap is insufficient for merge)
  Self-wiring: two entries sharing `registry.ts` are linked in `links` table.
- **Files:** `src/services/knowledge/sqlite-provider.ts`,
  `src/services/knowledge/sqlite-provider.test.ts`
- **Tier:** standard
- **Done when:** Add, Update, None, and flag-for-review AUDN decisions produce
  correct outcomes in tests. Auto-Delete is not implemented.
  Self-wiring: two entries sharing `registry.ts` are automatically linked.
  Evidence trail: superseded entries have `superseded_at` set, not deleted.
  Contradiction: existing entry has `flagged_for_review: true`, new entry
  has `contradiction_of` set.
  `npm test` passes.
- **Blockers:** Task 5 (capture tool, basic AUDN stub exists).

#### VERIFY: Phase 2 -- Write Path

- Capture learning, knowledge, runbook, context-cache entries via `kb_capture`.
- Capture duplicate -> AUDN returns `none`, DB has one entry.
- Capture update -> old entry has `superseded_at`, new entry exists.
- `kb_invalidate` marks context-cache entries stale.
- Git hook fires after commit, stale entries confirmed in DB.
- Self-wiring: two entries about same file are linked in `links` table.
- `npm test` passes. `npm run build` succeeds.

---

### Phase 3: Read Path

Agents can now retrieve knowledge efficiently. This is where goals 1, 4, and 5
are delivered: no re-reads, no bloated context, lower cost.

#### Task 8: kb_query MCP Tool -- Two-Level Retrieval

- **Change:** Create `src/tools/kb-query.ts` and register in `src/index.ts`.
  Input schema:
  - `query` (optional): free-text search string
  - `type` (optional): ContentType filter
  - `symbols` (optional): symbol name filter
  - `source_files` (optional): file path filter
  - `tags` (optional): label filter
  - `include_stale` (optional, default false): include stale context-cache
  - `include_superseded` (optional, default false): include old entries
  - `l1_only` (optional, default false): return titles + summaries only
  - `limit` (optional, default 20)
  Implement `SqliteProvider.query()`:
  - L1: FTS query on (title + summary). Returns KBEntry with content=undefined.
    Increments `last_accessed` and `use_count` on retrieved entries.
  - Caller can then request L2 by calling `query({...opts, ids: [id1, id2]})`
    which loads full content for specific IDs.
  - For context-cache results: run `checkStaleness()` on each. Set `stale` flag.
    Exclude stale unless `include_stale: true`.
  Returns: `{results: KBEntry[], total: number, l1_only: boolean}`.
- **Files:** `src/tools/kb-query.ts`, `src/index.ts`,
  `src/services/knowledge/sqlite-provider.ts`
- **Tier:** standard
- **Done when:** L1 query returns results with `content: undefined` in <100ms
  for a DB with 1000 entries. L2 expand loads full content. Stale entries
  excluded by default. `use_count` increments on each retrieval.
- **Blockers:** Task 7 (entries in DB with AUDN).

#### Task 9: kb_context MCP Tool -- Batch File Freshness

- **Change:** Create `src/tools/kb-context.ts` and register in `src/index.ts`.
  Input: `files: string[]` (list of file paths to check).
  Implement `SqliteProvider.context()`:
  - For each file, find the most recent non-superseded context-cache entry.
  - Use `computeFileHashBatch(files)` (single git call for all files, not N
    separate subprocess calls) then check each entry's hash against the batch result.
  - Return `FileContextResult[]`:
    - If fresh: `{file, status: 'fresh', summary, content_hash, entry_id}`
    - If stale: `{file, status: 'stale', reason, entry_id}`
    - If missing: `{file, status: 'missing'}`
  The tool's output tells the agent exactly which files it MUST read
  (status=stale or missing) and which it can skip (status=fresh).
- **Files:** `src/tools/kb-context.ts`, `src/index.ts`,
  `src/services/knowledge/sqlite-provider.ts`
- **Tier:** standard
- **Done when:** For a warm file: `status: fresh`, agent skips reading.
  After file is modified and committed: `status: stale`, agent must re-read.
  After `kb_invalidate`: `status: stale` immediately.
  After file deleted: `status: stale, reason: file_missing`.
  `npm test` passes.
- **Blockers:** Task 8 (query infrastructure), Task 4 (staleness logic).

#### Task 10: kb_session_prime MCP Tool

- **Change:** Create `src/tools/kb-session-prime.ts` and register in
  `src/index.ts`. Input schema:
  - `task` (required): description of the work about to be done
  - `hint_files` (optional): files the agent expects to touch
  - `hint_symbols` (optional): symbols likely to be relevant
  The tool handles the KB plane only. GitNexus structural queries are NOT
  called from within this tool (MCP servers cannot call peer MCP servers in
  the stdio model). The LLM orchestrates GitNexus separately.
  The tool:
  1. Extract keywords from `task` text + `hint_symbols`.
  2. Call `kb_query(l1_only: true)` with extracted symbols + task keywords.
     Filter: exclude `context-cache` entries from this scan by default.
  3. For L1 hits above a relevance threshold, call `kb_query` L2 expand
     (limit: top 5 by relevance + recency).
  4. Call `kb_context(hint_files)` to get fresh summaries + stale list.
  5. Build `recommended_gitnexus_calls`: for each hint_file and hint_symbol,
     generate the gitnexus tool call the LLM should make next as a structured
     object (NOT a pseudo-code string):
     `[{tool: "context", args: {symbol: "registry"}}, {tool: "impact", args: {file: "src/services/registry.ts"}}]`
     The LLM calls `context` MCP tool with `{symbol: "registry"}` directly.
     Unit test: verify output is `GitNexusCall[]` not `string[]`.
  6. Return `PrimedContext`:
     ```
     {
       learnings: KBEntry[],                   // top learnings, L2 expanded
       fresh_summaries: FileContextResult[],   // context-cache hits
       stale_files: string[],                  // agent MUST read these
       recommended_gitnexus_calls: string[],   // LLM follows these next
       token_estimate: number                  // rough estimate of context loaded
     }
     ```
  If gitnexus MCP is not configured, `recommended_gitnexus_calls` is empty.
  Tool works correctly without GitNexus.
- **Files:** `src/tools/kb-session-prime.ts`, `src/index.ts`
- **Tier:** premium
- **Done when:** On a warm session (all files in KB, none stale):
  `stale_files` is empty, `fresh_summaries` covers hint_files.
  Token estimate is under 5,000 for a typical 3-file task.
  GitNexus structural context included when gitnexus MCP is configured.
  Tool degrades gracefully when GitNexus is absent.
  `npm test` passes.
- **Blockers:** Tasks 8, 9 (query and context tools). Task 1 (GitNexus).

#### VERIFY: Phase 3 -- Read Path

- Cold session: `kb_session_prime` returns `stale_files` = all hint_files.
- After capturing context-cache for those files: warm session returns
  `stale_files` = [], `fresh_summaries` populated.
- After modifying one file and committing: that file back in `stale_files`.
- Token estimate for a 3-file warm session: under 5,000.
- L1 query completes in under 100ms on a 1,000-entry DB.
- `recommended_gitnexus_calls` populated correctly for hint_files and
  hint_symbols. Empty when no hints provided.
- **Cost measurement:** run a baseline session (no KB) and a primed session
  on the same task. Record token counts for both. If warm/cold ratio exceeds
  50% (i.e., warm session uses more than half as many tokens as cold), flag
  for investigation -- summaries may be too verbose or incomplete. Document
  the measurement result. Goal is <30% of cold.
- `npm test` passes. `npm run build` succeeds.

---

### Phase 4a: KB Agent + Security + KB Server

Adds the KB Agent role, security audit, and the central HTTP KB server.
Split into 4a (ends premium) and 4b (standard client + docs) to maintain
valid tier ordering within each phase dispatch.

#### Task 11: kb_promote MCP Tool + Confidence Model

- **Change:** Create `src/tools/kb-promote.ts` and register in `src/index.ts`.
  Input: `id: string`, `reason?: string`.
  Implement `SqliteProvider.promote()`:
  - Validate entry exists and is not superseded.
  - If `confidence === 'UNVERIFIED'` -> set to `INFERRED`.
  - If `confidence === 'INFERRED'` -> set to `CONFIRMED`.
  - Append a promotion note to `content`: `"[Promoted: <reason> -- <author>]"`.
  - Set `promoted_at` timestamp.
  Returns: `{id, confidence_before, confidence_after}`.
- **Files:** `src/tools/kb-promote.ts`, `src/index.ts`,
  `src/services/knowledge/sqlite-provider.ts`
- **Tier:** cheap
- **Done when:** Promoting UNVERIFIED -> INFERRED -> CONFIRMED works.
  Evidence trail preserved (original content + promotion note).
  Promoting already-CONFIRMED is a no-op with a clear message.
- **Blockers:** Task 5 (entries exist).

#### Task 12: KB Agent Skill File + Capture Guidance

- **Change:** Create `skills/fleet/knowledge-agent.md` with:
  - Role: `knowledge-curator`. When to be dispatched (after doer, after reviewer,
    on demand for dream cycle).
  - Capture guidance for the doer: when to call `kb_capture`, what makes a
    good title vs summary vs content, symbol extraction hints.
  - Capture guidance for the reviewer: confirm vs new capture, promotion rules.
  - User interrupt recognition: how to detect factual project knowledge in user
    messages, how to capture it, how to acknowledge.
  - Post-session harvest: how to scan a session transcript for uncaptured
    learnings, how to submit through AUDN.
  - Dream cycle procedure: dedup pass, contradiction scan, salience prune,
    stale link repair.
  Update `skills/fleet/skill-matrix.md`: add `knowledge-agent` skill row.
  Create `skills/fleet/kb-capture-guide.md`: one-page cheat sheet for agents
  on what to capture and how (used as AGENTS.md context injection by GitNexus).
- **Files:** `skills/fleet/knowledge-agent.md`,
  `skills/fleet/kb-capture-guide.md`, `skills/fleet/skill-matrix.md`
- **Tier:** cheap
- **Done when:** Skill file is self-contained and actionable. An agent following
  it can operate as KB Agent, doer (with capture), or reviewer (with promotion)
  without additional guidance.
- **Blockers:** All KB tools implemented (Tasks 5-11).

#### Task 13: Post-Session Harvest

- **Change:** Add `kb_harvest` MCP tool in `src/tools/kb-harvest.ts`.
  Input: `session_output: string` (the text output of a completed agent session),
  `source: 'doer' | 'reviewer'`, `session_id?: string`.
  The tool:
  1. Scans session output for patterns indicating knowledge:
     - "I found that...", "Note:", "Warning:", "Bug:", "Gotcha:", "This means..."
     - File paths mentioned with explanatory context
     - Error messages with resolutions
  2. Extracts candidate entries (title + summary + content) for each hit.
  3. Calls `SqliteProvider.capture()` with `confidence: UNVERIFIED` and
     `source: kb_agent_harvest` for each candidate.
  4. Returns `{candidates_found: n, added: n, deduped: n}`.
  Wire automatic harvest: `kb_harvest` runs automatically when `execute_prompt`
  completes (PostSession hook in `src/tools/execute-prompt.ts` or equivalent).
  PM does NOT dispatch manually. PM can trigger on-demand for targeted review
  sessions (`kb_harvest --session-id <id>`).
  Update PM flow documentation to reflect automatic harvest.
- **Files:** `src/tools/kb-harvest.ts`, `src/index.ts`
- **Tier:** standard
- **Done when:** A sample doer session output produces at least 2 UNVERIFIED
  entries via harvest. Duplicates of existing CONFIRMED entries are deduped
  (AUDN returns none). `npm test` passes.
- **Blockers:** Task 7 (AUDN), Task 12 (skill describes what to harvest).

#### Task 14: kb_sync + kb_setup MCP Tools

- **Change:**
  Create `src/tools/kb-sync.ts`:
  Input: `direction: 'push' | 'pull' | 'both'` (default both),
  `peer?: string`.
  Implement `SqliteProvider.sync()`: for default SQLite provider, sync
  is a no-op that returns `{synced: false, reason: 'local-only provider'}`.
  For PostgresProvider (stub): delegates to Postgres replication.
  This task wires the tool and ensures graceful no-op for local installs.
  Create `src/tools/kb-setup.ts`:
  - Installs the git post-commit hook (template from Task 6).
  - Accepts `provider` config and writes `~/.apra-fleet/data/knowledge/config.json`.
  - Stores any remote credentials in the apra-fleet credential store
    (AES-256-GCM, same as SSH passwords).
  - Returns setup summary.
- **Files:** `src/tools/kb-sync.ts`, `src/tools/kb-setup.ts`, `src/index.ts`
- **Tier:** standard
- **Done when:** `kb_setup` installs git hook and writes config. `kb_sync` on
  SQLite provider returns graceful no-op. Credentials stored encrypted.
  No plaintext credentials in logs or tool output.
- **Blockers:** Task 11 (promote, so there are entries worth syncing).

#### Task 15: Security Audit

- **Change:** Review all KB tools and KB Service for:
  - **Command injection**: `computeFileHash` shells out to `git hash-object`.
    Verify file path is passed via `execFile` args array (no shell interpolation).
  - **Credential storage**: `kb_setup` stores remote credentials. Verify
    AES-256-GCM encryption at rest, no plaintext in logs, no credentials
    in MCP tool output.
  - **Network egress**: `kb_sync` makes network calls. Verify it uses
    credentials from the credential store, not environment variables or
    hardcoded values.
  - **Input validation**: all MCP tool inputs validated (types, max lengths,
    path traversal prevention for `source_files` and `hint_files`).
  - **SQLite injection**: all DB queries use parameterized statements
    (better-sqlite3 prepared statements). Verify no string concatenation in SQL.
  Document findings and fixes in `docs/knowledge-layer.md`.
- **Files:** all KB tool and service files, `docs/knowledge-layer.md`
- **Tier:** standard
- **Done when:** No command injection vectors. No plaintext credentials. All
  SQL uses prepared statements. Path traversal blocked on file inputs.
  Audit findings documented.
- **Blockers:** All KB tools implemented (Tasks 5-14).

#### Task 17: KB Server (Central HTTP Service)

- **Change:** Create `src/commands/kb-server.ts`. Add `kb-server` as a new
  CLI subcommand: `node dist/index.js kb-server [--port 7878] [--generate-token]`.
  The server:
  - Starts an HTTP server on the configured port using Node's `node:http`.
  - Wraps `SqliteProvider` internally (server-side KB is a local SQLite DB).
  - Exposes REST endpoints:
    - `GET /api/kb/entries` (query, L1 + L2 via query params)
    - `POST /api/kb/entries` (capture)
    - `PATCH /api/kb/entries/:id/invalidate`
    - `POST /api/kb/entries/:id/promote`
    - `GET /api/kb/context` (batch file freshness)
    - `GET /health`
  - Auth: `Authorization: Bearer <token>` on all endpoints except `/health`.
    Token stored in `path.join(FLEET_DIR, 'knowledge', 'server-token')` (mode 0o600).
    `--generate-token` generates a new token and writes it.
  - Rate limiting: 100 requests/minute per IP (simple in-memory token bucket,
    no external library). Return 429 with `Retry-After: 60` header.
  - Input validation: all paths and query strings validated (path traversal
    blocked), max body size enforced (1MB, return 413 if exceeded).
  - Port in use: if bind fails with EADDRINUSE, print clear error to stderr:
    `KB server: port 7878 is already in use. Try: apra-fleet kb-server --port <other>`
    then exit(1).
  - All responses JSON. Errors return `{error: string, code: string}`.
  - Token path uses `FLEET_DIR` from `src/paths.ts` (not hardcoded `~/.apra-fleet`).
  Add `kb-server` to the CLI router in `src/index.ts`.
- **Files:** `src/commands/kb-server.ts`, `src/index.ts`
- **Tier:** premium
- **Done when:** Server starts, `/health` returns `{status: "ok"}`. Authenticated
  `POST /api/kb/entries` creates an entry. Unauthenticated request returns 401.
  Path traversal attempt in `source_files` returns 400. Server stores and returns
  entries correctly. `npm test` passes (integration test with HTTP client).
- **Blockers:** Tasks 5-11 (all KB tools implemented -- server wraps them).

#### VERIFY: Phase 4a

- `kb_promote` works: UNVERIFIED -> INFERRED -> CONFIRMED.
- `kb_harvest` fires automatically after session close.
- KB Agent skill file actionable without additional guidance.
- KB server starts, `/health` responds, authenticated writes work.
- Unauthenticated request returns 401. Path traversal returns 400.
- `npm test` passes. `npm run build` succeeds.

---

### Phase 4b: HTTP Provider Client + Documentation

Wires the HTTP KB provider (client side) and writes all documentation.

#### Task 18: HttpKbProvider

- **Change:** Create `src/services/knowledge/http-provider.ts` implementing
  `MemoryProvider`. All 8 methods delegate to `kb-server` HTTP endpoints.
  Offline degradation: if HTTP request fails (connection refused, timeout),
  fall back to local `SqliteProvider` for reads. Writes in offline mode are
  queued in memory (max 1000 entries) and flushed on next successful connection.
  Queue is not persisted to disk (lost on process exit -- acceptable for v1).
  On process `beforeExit` event, if offline queue has entries, log to stderr:
  `[KB] WARNING: offline queue has N unsaved captures. Reconnect to the KB
  server and run kb_harvest to recover from the session transcript.`
  This makes data loss discoverable rather than silent.
  Config: `{ provider: "http", url: "http://<host>:7878", token: "<key>" }`.
  Update `kb_setup` to accept `--remote <url> --token <token>` and write
  `HttpKbProvider` config. Token stored encrypted via credential store.
  Update `KBService.getProvider()` factory to instantiate `HttpKbProvider`
  when `config.provider === "http"`.
- **Files:** `src/services/knowledge/http-provider.ts`,
  `src/services/knowledge/kb-service.ts`, `src/tools/kb-setup.ts`
- **Tier:** standard
- **Done when:** `kb_setup --remote http://localhost:7878 --token <key>` writes
  config and stores token encrypted. All MCP tools work transparently through
  `HttpKbProvider`. Offline degradation: disconnect server, capture entry,
  reconnect, entry appears on server after flush. `npm test` passes.
- **Blockers:** Task 17 (server), Task 14 (kb_setup), Task 3 (SqliteProvider
  for offline degradation fallback).

#### Task 16: Documentation

- **Change:** Complete `docs/knowledge-layer.md`:
  - Architecture overview (two-plane diagram).
  - Setup guide: `kb_setup`, GitNexus install, git hook.
  - Usage guide: session prime workflow, capture guide, promotion rules.
  - Provider swap: how to switch from SQLite to Postgres or Mem0.
  - Dream cycle: how to dispatch the KB Agent, what it does.
  - Troubleshooting: GitNexus stale graph, SQLite lock errors, hook not firing.
  Update `docs/architecture.md`: add Knowledge Layer section and diagram.
  Update `README.md`: add Knowledge Layer to feature list and tool reference.
- **Files:** `docs/knowledge-layer.md`, `docs/architecture.md`, `README.md`
- **Tier:** standard
- **Done when:** A new team member can set up the knowledge layer from scratch
  by following the docs. Provider swap is documented with example config.
- **Blockers:** Task 15 (security audit may change setup flow).

#### VERIFY: Phase 4b -- Full System

- Full end-to-end: cold session -> prime -> capture (doer) -> harvest (automatic)
  -> review session -> promote (reviewer) -> warm session -> prime with no
  file reads.
- User interrupt captured correctly with CONFIRMED confidence.
- Dream cycle: create two duplicate entries, run dream cycle, confirm dedup.
- `kb_sync` no-op on SQLite, no crash.
- `kb_setup` installs hook, writes config, stores credentials encrypted.
- **Central service:** `kb-server` starts and accepts authenticated requests.
  `kb_setup --remote http://localhost:7878 --token <key>` configures client.
  All MCP tools work end-to-end through `HttpKbProvider`.
  Offline degradation: disconnect server, make capture calls, reconnect,
  entries flush to server.
  Unauthenticated request returns 401.
- Security: no SQL injection, no command injection, no plaintext credentials,
  no path traversal, no plaintext token in logs.
- `npm test` passes. `npm run build` succeeds.
- `npm run build:binary` produces a working single-executable binary.
- Documentation accurate and complete.

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **better-sqlite3 native build fails** on some platforms (needs node-gyp, MSVC on Windows). | High | Test on Windows in Phase 1. Document build prerequisites. If native build fails, fall back to `node:sqlite` (Node 23+ built-in, no FTS5 on some builds) or `sql.js` (WASM, no native). Decision gate at end of Task 3. |
| **GitNexus graph stale after fast edits** -- agent primes before PostToolUse hook fires. | Medium | `kb_session_prime` calls `detect_changes` before priming. If stale, triggers reindex before returning context. Adds latency on first prime after commits, not subsequent. |
| **AUDN false positives** -- two unrelated entries share symbols, incorrectly merged. | Medium | AUDN uses symbol overlap + file path overlap + title FTS together (AND, not OR). Single symbol overlap insufficient for merge. Threshold tunable. Superseded entries are not deleted -- easy to recover. |
| **kb_session_prime token budget exceeded** -- prime returns too many L2 entries, bloats context. | Medium | Hard cap: top 5 L2 expansions, max 800 tokens each. L1-only mode always available. Agent can call `kb_query` for targeted follow-up instead of loading everything at prime time. |
| **Command injection in computeFileHash** -- file path from user passed to shell. | High | Use `child_process.execFile` (not `exec`). Path is an argument, not shell-interpolated. Security audit (Task 15) verifies. |
| **MemoryProvider interface breaks as requirements evolve** -- adding a method forces all providers to update. | Low | Interface is internal. Only two implementations in v1 (SQLite stub for Postgres). Version the interface (`MemoryProviderV1`) if breaking changes needed. |
| **GitNexus not installed** -- `kb_session_prime` fails if gitnexus MCP absent. | Low | `kb_session_prime` degrades gracefully: `recommended_gitnexus_calls` is empty, KB-only prime returned. No crash. Document GitNexus as optional but recommended. |
| **Single-binary build breaks** -- `better-sqlite3` native module is not bundleable. | High | Use `pkg`-compatible bundling with `--native-option`. Test `npm run build:binary` in Task 3 VERIFY. If unbundleable, ship SQLite as a side-car (copy to `~/.apra-fleet/bin/` on install). |
| **AUDN flag-for-review queue grows unbounded** -- no one reviews flagged entries. | Medium | KB Agent dream cycle surfaces flagged entries count in fleet_status output. Dream cycle pass reviews and auto-expires flagged entries older than 30 days (marks them pruned, not deleted). |
| **KB server auth token leaked in logs or output** -- token appears in error messages or tool responses. | High | Token stored AES-256-GCM encrypted. Never logged. `kb-server` request/response logging redacts Authorization header. Security audit (Task 15) verifies. |
| **HTTP relay port conflict** -- port 7878 already in use on fleet machine. | Low | Port configurable via `--port` flag and `config.json`. `kb-server` reports clear error on bind failure, suggests `--port`. |
| **Offline queue lost on process exit** -- captures made while server unreachable are lost. | Medium | Document limitation. v2: persist offline queue to `~/.apra-fleet/data/knowledge/offline-queue.jsonl`. |

---

## Phase Sizing Notes

- **Phase 0** (1 task: cheap): ADRs + validation spike. No code. Gate on
  GitNexus Go/No-Go and ADRs documented.
- **Phase 1** (4 tasks: cheap, standard, standard, standard): infrastructure.
  No user-facing feature. Gate on build + test passing.
- **Phase 2** (3 tasks: cheap, cheap, standard): write path.
  Tier ordering: cheap, cheap, standard -- valid.
- **Phase 3** (3 tasks: standard, standard, premium): read path.
  Tier ordering: standard, standard, premium -- valid.
- **Phase 4a** (Tasks 11, 12, 13, 14, 15, 17 -- cheap, cheap, standard,
  standard, standard, premium): KB Agent + security + KB server.
  Tier ordering: cheap, cheap, standard, standard, standard, premium -- VALID.
  Ends on premium (Task 17, KB server implementation).
- **Phase 4b** (Tasks 18, 16 -- standard, standard): HTTP client provider +
  documentation. Tier ordering: standard, standard -- VALID.
  PM should split Phase 4 at the Task 17/Task 18 boundary to avoid a
  tier downgrade (premium -> standard) within a single phase context.

---

## Notes

- Each task results in a git commit.
- VERIFY tasks are checkpoints -- stop and report before proceeding.
- Base branch: main
- Implementation branch: feat/knowledge-bank

---

## GSTACK REVIEW REPORT

Generated by /autoplan on 2026-06-11
Reviewer: GStack (automated), user: yashraj
Branch: feat/knowledge-bank

### Phase 1 -- CEO Review

| # | Finding | Severity | Decision | Resolution |
|---|---------|----------|----------|------------|
| 1 | GitNexus used in design with no validation spike -- "28k stars, TypeScript-native" is not evidence | Critical | Add Task 0 spike (ADR-003) before any code | DONE -- Task 0 added to Phase 0, ADR-003 placeholder written |
| 2 | No token reduction measurement -- "85-95% reduction" is a claim, not a spec | Critical | Phase 3 VERIFY must measure warm-hit ratio; < 50% triggers investigation | DONE -- VERIFY criterion added |
| 3 | Central service architecture (ADR-002) missing HTTP implementation tasks | Critical | User gate: scope to v1 | USER DECIDED: v1 = design + validate (Tasks 17 + 18 added) |
| 4 | AUDN auto-Delete path -- keyword-based deletion is too aggressive for v1 | High | Replace Delete with flagged_for_review; dream cycle reviews queue | DONE -- AudnDecision updated, risk register entry added |
| 5 | ADR-001 and ADR-002 not written in design.md | High | Write both ADRs inline in design.md | DONE -- ADR-001 and ADR-002 added |
| 6 | /learn tool overlap with kb_capture not documented | High | Added note to design.md Known Limitations | DONE |
| 7 | kb_session_prime implies MCP-to-MCP calls -- not possible in stdio model | High | Rewrite: prime returns recommended_gitnexus_calls as structured list, LLM orchestrates | DONE -- schema updated to `{tool, args}[]` |
| 8 | KB Agent harvest auto-wired or PM-dispatched? Ambiguous | Medium | Auto-wired to execute_prompt completion, not PM-dispatched | DONE -- Task 13 updated |
| 9 | Git hook quoting bug -- file paths with spaces fail `for f in $FILES` | Medium | Fixed to `while IFS= read -r f; do ... "$f"; done` | DONE -- Task 6 updated |
| 10 | context-cache entries included in all FTS queries -- pollutes learning/knowledge search | Medium | query() must filter by `type` when type is specified | DONE -- Task 7 and Task 9 updated |
| 11 | AUDN dedup gap -- symbol OR file overlap triggers merge; unrelated entries could merge | Medium | Enforce AND-logic: symbol + file + title similarity all required | DONE -- Task 7 notes updated |

**CEO Review verdict:** 11 findings, 10 auto-decided, 1 user gate. All resolved. PLAN.md and design.md updated.

---

### Phase 3 -- Engineering Review

| # | Finding | Severity | Decision | Resolution |
|---|---------|----------|----------|------------|
| ENG-01 | SqliteProvider concurrent writes -- WAL mode not specified, agents will hit SQLITE_BUSY | High | WAL mode + busy_timeout=5000 + synchronous=NORMAL required | DONE -- Task 3 updated |
| ENG-02 | O(N) subprocess overhead in kb_context -- one git hash-object call per file | High | computeFileHashBatch: single subprocess for N files | DONE -- Task 4 + Task 9 updated |
| ENG-03 | FTS5 UPDATE footgun -- UPDATE on FTS5 virtual table corrupts ranking index | High | All updates use DELETE + INSERT pattern; documented in Task 3 | DONE -- Task 3 SQL updated |
| ENG-04 | content_hash_type not stored -- checkStaleness cannot know which method to use at recalc | High | KBEntry.content_hash_type: 'git' or 'sha256'; computeFileHash returns `{hash, type}` | DONE -- types.ts schema + Task 4 updated |
| ENG-05 | Path traversal in kb-server -- no validation on path params sent to SQLite | High | Validate path inputs; security audit (Task 15) covers this | DONE -- Task 17 security notes updated |
| ENG-06 | SqliteProvider.init() not idempotent -- no `IF NOT EXISTS` guard on table creation | Medium | Use `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE IF NOT EXISTS` | DONE -- Task 3 updated |
| ENG-07 | content cap missing -- no limit on content size stored in KB | Medium | Truncate at 4,000 chars on capture; truncation noted in entry | DONE -- Task 3 updated |
| ENG-08 | FLEET_DIR path not enforced -- kb paths could be relative or absolute from different roots | Medium | All KB paths derive from `path.join(FLEET_DIR, 'knowledge', ...)` | DONE -- Task 3 updated |
| ENG-09 | Token file permissions -- KB server token stored without mode restriction | Medium | Token file written with mode 0o600; Task 15 audit verifies | DONE -- Task 17 security notes |
| ENG-10 | HttpKbProvider write queue unbounded -- max queue size not specified | Medium | Max 1000 entries; overflow logs warning and drops oldest | DONE -- Task 18 updated |
| ENG-11 | beforeExit data loss silent -- offline queue lost on exit with no user warning | Medium | Process.on('beforeExit') logs stderr warning if queue non-empty | DONE -- Task 18 updated |
| ENG-12 | prepared statements not called out -- repeated SQL parsing overhead in hot paths | Low | Task 3 notes: use prepared statements for capture/query/invalidate | DONE -- Task 3 updated |
| ENG-13 | EADDRINUSE error message unclear -- raw Node error on port conflict | Low | kb-server catches EADDRINUSE, prints actionable message with --port suggestion | DONE -- Task 17 updated |

**Engineering Review verdict:** 13 findings, all auto-decided. All resolved. PLAN.md and design.md updated.

Test plan artifact: `~/.gstack/projects/Apra-Labs-apra-fleet/yashr-feat-knowledge-bank-eng-review-test-plan-20260611.md`

---

### FINAL VERDICT

**APPROVED WITH CONDITIONS**

Conditions (already satisfied in this document):
1. Task 0 GitNexus spike runs first -- if No-Go, Phase 1 starts without GitNexus
2. Phase 3 VERIFY measures warm-hit ratio -- < 50% triggers design revision
3. Phase 4a completes before Phase 4b (tier ordering enforced)

**NO UNRESOLVED DECISIONS**

All findings from CEO Review (Phase 1) and Engineering Review (Phase 3) have been
resolved and the amendments have been applied to PLAN.md and design.md. The plan is
ready to implement starting at Phase 0, Task 0.
