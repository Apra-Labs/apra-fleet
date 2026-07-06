# PLAN -- KB Integrity Sprint (epic yashr-oaf)

Branch: feat/code-intelligence-abstraction (base: main). All work lands on this
branch. NEVER push to main. NO PR -- the user raises PRs. Requirements:
requirements.md (F1-F8, phases P0/P1/P2). Binding decisions: design.md (D1-D8).

## Sprint-wide constraints (apply to every task)

- ASCII only: never write non-ASCII characters to any file. Use `-`, `->`,
  `[OK]`.
- ASCII pre-commit hook gotcha (KB, verbatim): the pre-commit ASCII hook
  false-positives on backtick-n/t/r escape sequences inside JS template
  literals -- use string concatenation instead of template literals when a
  string needs \n, \t, or \r in .md/.yml/.sh-adjacent generated content or
  test fixtures that the hook scans. If the hook rejects a commit, check for
  template literals with backslash escapes first.
- gitnexus analyze gotcha (KB runbook 3fa771af, verbatim): "Running 'npx
  gitnexus analyze' injects non-ASCII gitnexus:start/end block markers into
  AGENTS.md and CLAUDE.md, violating ASCII-only convention. This happens in
  every VERIFY phase. Fix: run 'git checkout -- AGENTS.md CLAUDE.md'
  immediately after analyze to discard injected markers, keeping only the real
  code intelligence updates to other files." Every VERIFY task below includes
  this step. It is mandatory.
- Module-singleton test pattern (KB learning 989d00c3, verbatim): "For testing
  code with module-level singletons (like sharedClient/connectionPromise in
  code-intelligence-gitnexus), use vi.resetModules() + dynamic import at the
  start of each test to get a fresh module instance. Pre-hoisted vi.mock
  factories are re-applied, preserving mock function references across
  resets." Use vi.hoisted() for mock fn refs declared before imports. Existing
  example: tests/knowledge/kb-session-prime.test.ts.
- No mass migration (D1/D5, sprint done-criteria): existing KB rows -- the 44
  directly-CONFIRMED entries, free-string author/source values -- are
  historical data and MUST NOT be rewritten. All enforcement is
  forward-looking and documented as such.
- Tests: npm test must stay green except the 2 pre-existing timezone failures
  in tests/time-utils.test.ts (beads yashr-302), which are allowed to fail.
- Use code intelligence tools (code_context, code_impact, code_query,
  code_map, code_flow) for structural questions; never Glob/Grep for call
  graphs or symbol lookups. code_graph works via cypher CALLS traversal.

## Shared-file sequencing (binding order)

- src/services/knowledge/audn.ts is edited by F2 (T1.4, contradiction logic)
  and F4 (T2.1, makeFtsQuery OR-join). Decision: F2 lands first in Phase 1;
  T2.1 is the FIRST task of Phase 2 so its audn.ts edit applies directly on
  top of the committed Phase 1 state. The two edits touch disjoint functions
  (makeAudnDecision vs makeFtsQuery) and rebase cleanly in this order.
- src/tools/kb-session-prime.ts is edited by F4 (T2.1, neighbor-batch OR
  join) and F8 (T3.5, canonical cold-seed). Decision: T2.1 first, T3.5 last;
  T3.5 adds a new block after the graph-neighbor expansion and must not
  restructure T2.1's code. F3 (T2.2) deliberately does NOT edit
  kb-session-prime.ts -- staleness lives in SqliteProvider.prime (see T2.2
  rationale), which keeps the wrapper contention to two sequenced edits.
- Tasks execute strictly in the order listed. Each task is committed before
  the next starts.

---

## Phase 1 -- P0 Trust core (riskiest first: F1 gate, F2 supersede/contradiction)

### T1.1 -- F1: Enforce the CONFIRMED gate in kb_capture (D1)

- Model: claude-opus-4-8
- Files: src/tools/kb-capture.ts, tests (new tests/knowledge/kb-capture-gate.test.ts
  or extend existing kb tool tests).
- Today kb-capture.ts accepts confidence 'CONFIRMED' from any caller (zod enum
  at line 19, applied as `input.confidence ?? 'INFERRED'` at line 64). Audit
  evidence: 44/44 CONFIRMED entries bypassed kb_promote. Implement the D1
  clamp in the kbCapture handler (server-side, NOT just the zod schema; the
  zod confidence param stays for back-compat):
  - UNVERIFIED and INFERRED pass through unchanged.
  - CONFIRMED is downgraded to INFERRED. The clamp must be visible to the
    caller: return `confidence_clamped: true` in the JSON result (alongside
    id and audn_decision) AND append a short bracketed note to the entry
    content (e.g. "[confidence clamped: CONFIRMED requires kb_promote]").
    Never silently mislead the caller (D1).
  - kb_promote (src/tools/kb-promote.ts, provider promote()) remains the ONLY
    path to CONFIRMED. Do not change promote logic.
  - D6 forward-compat: write the clamp with an explicit exemption
    `input.type === 'user-directive'` that bypasses the clamp. The type does
    not exist in the ContentType union until T3.1, so guard it in a way that
    compiles today (e.g. compare against the raw string). Comment it as the
    D6 exception.
  - D1 no-mass-migration: do NOT touch existing rows. Add a code comment in
    kb-capture.ts stating enforcement is forward-only and existing
    direct-CONFIRMED rows are historical.
  - Update the kb_capture tool description in src/index.ts (line ~357) to say
    confidence is capped at INFERRED and CONFIRMED comes only from kb_promote.
- Tests (MUST FAIL on today's code, PASS after): capture with
  confidence:'CONFIRMED' -> stored entry has confidence INFERRED and result
  carries confidence_clamped:true (fails today because the entry stores
  CONFIRMED). Also: UNVERIFIED passes through; INFERRED default unchanged;
  promote still mints CONFIRMED (UNVERIFIED -> INFERRED -> CONFIRMED ladder).
- Done: clamp enforced in handler; clamp visible to caller; tests prove
  fail-then-pass on the gate; build + suite green.

### T1.2 -- F1: Trust-model docs + KB Agent template alignment (D1)

- Model: claude-haiku-4-5
- Files: skills/pm/tpl-kb-agent.md, docs/kb-trust-model.md (new), and the
  confidence decision table wherever tpl-kb-agent.md carries it.
- Mechanical documentation task, no code:
  - tpl-kb-agent.md: instruct the KB Agent to capture at INFERRED and use
    kb_promote (id + reason) to mint CONFIRMED after verification. Reconcile
    the confidence decision table with the enforced behavior from T1.1
    (capture never yields CONFIRMED; promotion does; user-directive is the
    future exception per D6).
  - docs/kb-trust-model.md (new, one short page): the trust ladder
    UNVERIFIED -> INFERRED -> CONFIRMED, kb_promote as the sole CONFIRMED
    mint, the D1 forward-only enforcement note (existing direct-CONFIRMED
    rows are historical and not migrated), and the D6 user-directive
    exception (one sentence, implemented in Phase 3).
- ASCII only (these are .md files -- the pre-commit hook scans them).
- Done: template tells KB Agent to use kb_promote for CONFIRMED; decision
  table matches enforced behavior; docs note exists; no non-ASCII.

### T1.3 -- F2a: Supersede for real -- 'update' marks old entry superseded_at + stale (D2)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/sqlite-provider.ts (evaluateAudn, 'update'
  branch, line ~272), tests/knowledge (extend the sqlite-provider/audn
  integration tests).
- Verified current state: the 'update' branch DOES set superseded_at (line
  273: `UPDATE entries SET superseded_at = ? WHERE id = ?`) but does NOT set
  stale = 1. D2 requires both. Change the statement to set superseded_at =
  now AND stale = 1 on the old entry; leave content_hash intact. Do not touch
  the flagged or none branches (T1.4 owns the contradiction path).
- Context for the doer: the live code_graph broken-vs-fixed pair was never
  superseded because AUDN's AND-gate never matched it as 'update' at all --
  that detection gap is T1.4's concern. This task is solely: WHEN the update
  decision fires, the old row must be fully retired (superseded_at + stale).
  One concern per task.
- Tests (MUST FAIL on today's code, PASS after): capture entry A, then
  capture a correcting entry B with overlapping symbols AND files and same
  type + similar title (so AUDN decides 'update'); assert old row has
  superseded_at set AND stale = 1 (the stale assertion fails today). Assert
  the new entry is live and query() excludes the old one by default.
- Done: fail-then-pass test on the stale column; superseded_at still set;
  suite green.

### T1.4 -- F2b: Loosen AUDN contradiction detection -- flag without file overlap (D2)

- Model: claude-opus-4-8
- Files: src/services/knowledge/audn.ts (makeAudnDecision,
  hasContradictionKeywords, CONTRADICTION_KEYWORDS), tests/knowledge/audn.test.ts.
- Today makeAudnDecision line 50 gates EVERYTHING on
  `symMatch && fileMatch` -- a genuine contradiction on shared symbols with
  no shared file is invisible (0 flagged across 92 live entries; the
  code_graph "broken" vs "fixed" pair was never flagged). Restructure per D2:
  - CONTRADICTION path: flag when symbolsOverlap(input.symbols,
    candidate.symbols) AND a contradiction signal exists -- REGARDLESS of
    filesOverlap. Keep the existing flagged behavior (mark existing entry
    flagged_for_review = 1; new entry gets confidence UNVERIFIED,
    contradiction_of = candidate.id).
  - Contradiction signal = hasContradictionKeywords(input.content) OR a
    light opposite-polarity check between input content/title and candidate
    content/title (D2: "keyword or opposite-polarity content"). Implement
    polarity conservatively as a small pure function over antonym pairs
    (e.g. broken/fails/does not work vs fixed/works/now works); it must
    catch the real code_graph pair shape below without flagging ordinary
    refinements. Extending CONTRADICTION_KEYWORDS (e.g. 'no longer',
    'is fixed', 'now works') is acceptable; keep the list conservative.
  - DEDUP ('none') and UPDATE paths: unchanged semantics -- still require
    symMatch AND fileMatch. Only the contradiction path widens.
  - Do not break T1.3's supersede behavior (evaluateAudn is untouched here;
    this task edits only audn.ts + tests).
- Tests (MUST FAIL on today's code, PASS after): the real code_graph pair
  shape -- candidate: symbols ['GitNexusProvider.graph','callGitNexus'],
  source_files ['docs/code-intelligence-child-surface.md', ...], content
  "call_graph tool does not exist / code_graph is broken"; input: symbols
  ['GitNexusProvider.graph','callGitNexus'], source_files
  ['src/tools/code-intelligence-gitnexus.ts'] (NO shared file), content
  "code_graph now works / fixed via cypher CALLS traversal". Expect decision
  'flagged' with contradiction_of set (today: returns null -> 'add').
  Also: existing dedup/update tests stay green; a same-symbol entry WITHOUT
  contradiction signal and without file overlap is NOT flagged (no false
  positive regression).
- Note: reconciling the live code_graph pair in the apra-fleet KB is OUT of
  scope (live data, not code) -- the test proving the new logic WOULD flag it
  is IN scope (D2).
- Done: fail-then-pass contradiction test on the code_graph shape; no
  regression in dedup/update paths; suite green.

### T1.5 -- VERIFY Phase 1

- Type: verify (no model)
- Steps, in order:
  1. npm run build -- must be clean.
  2. npm test -- green; ONLY the 2 pre-existing timezone failures in
     tests/time-utils.test.ts (yashr-302) may fail.
  3. npx gitnexus analyze -- non-fatal (a failure here does not block).
  4. MANDATORY (KB runbook 3fa771af): git checkout -- AGENTS.md CLAUDE.md
     immediately after analyze. "Running 'npx gitnexus analyze' injects
     non-ASCII gitnexus:start/end block markers into AGENTS.md and CLAUDE.md
     ... run 'git checkout -- AGENTS.md CLAUDE.md' immediately after analyze
     to discard injected markers."
  5. Confirm no non-ASCII in any changed .md/.yml/.sh file.
  6. git push origin feat/code-intelligence-abstraction. NEVER push main.
     NO PR.

---

## Phase 2 -- P1 Freshness and retrieval (F4, F3, F5)

Order rationale: T2.1 (F4) runs first so its audn.ts edit lands immediately
after Phase 1's audn.ts work (clean sequential rebase on the shared file), and
because fixed retrieval de-risks the staleness tests in T2.2.

### T2.1 -- F4: FTS OR-join for multi-term queries (D4; closes yashr-5n2, yashr-17i)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/audn.ts (makeFtsQuery),
  src/services/knowledge/sqlite-provider.ts (prime(), line ~535),
  src/tools/kb-session-prime.ts (neighbor batch join, line ~141),
  tests/knowledge (audn.test.ts, sqlite-provider tests,
  kb-session-prime.test.ts).
- KB finding 83726d75 (verbatim): "SqliteProvider.query() passes the query
  string verbatim into FTS5 MATCH, treating space-separated terms as implicit
  AND. When kb-session-prime batches multiple neighbor names (e.g., 'nbrA'
  'nbrB'), entries must contain ALL tokens to match, usually returning
  nothing. ... clean backlog follow-up: OR-join sanitized terms
  (neighbors.join(' OR ')) so entries matching ANY neighbor surface."
  Live proof: this sprint's own planner prime with 7 hint_symbols returned
  ZERO top_entries from a 46-entry KB.
- Design nuance the doer must know: D4 names makeFtsQuery (audn.ts), but
  makeFtsQuery is only called by findAudnCandidates (verified via
  code_context). The multi-term prime bug lives in TWO other query-builder
  sites that join with ' '. Fix all three coherently:
  1. audn.ts makeFtsQuery: join extracted tokens with ' OR ' when there are
     2+ tokens; single-token output unchanged. Each token is already
     [a-zA-Z0-9_]{3,} so it is FTS-safe; keep it that way.
  2. sqlite-provider.ts prime(): searchTerms (hint_symbols + hint_modules)
     currently `searchTerms.join(' ')`. Sanitize each term (quote tokens per
     the ftsSafeTerm approach -- tokens WITHIN one term stay space-joined,
     i.e. AND within a term) and join ACROSS terms with ' OR '.
  3. kb-session-prime.ts neighbor batch: `.join(' ')` at line ~141 becomes
     `.join(' OR ')` across neighbors; ftsSafeTerm itself (intra-name quoted
     tokens) is unchanged.
  Prefer extracting one shared exported helper (e.g. orJoinFtsTerms in
  audn.ts) used by sites 2 and 3 rather than three hand-rolled joins.
  Ranking is unchanged (ORDER BY rank / bm25 still applies, so OR results
  stay relevance-ordered). include_stale / l1_only filters intact.
- Shared-file note: this is the SECOND edit to audn.ts (after T1.4) and the
  FIRST Phase-2 edit to kb-session-prime.ts (T3.5 comes later). Do not
  restructure makeAudnDecision.
- Tests (MUST FAIL on today's code, PASS after): seed two entries, one
  containing only termA, one containing only termB; a prime/query with both
  hint terms returns both entries (today: returns nothing -- implicit AND).
  Single-term query behavior unchanged (regression test). Neighbor-batch
  test: two neighbors that never co-occur in one entry now surface entries
  for each (use the module-singleton pattern from KB 989d00c3:
  vi.resetModules() + dynamic import + vi.hoisted for the code-intelligence
  provider mock, as tests/knowledge/kb-session-prime.test.ts already does).
- Done: fail-then-pass multi-term test at both the prime and neighbor-batch
  levels; single-term regression green; suite green.

### T2.2 -- F3: Auto-staleness at prime (D3)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/sqlite-provider.ts (prime(), new private
  checkFreshness helper), tests/knowledge (sqlite-provider prime tests).
- Today file-hash staleness runs only on explicit kb_invalidate; prime() runs
  decayConceptEntries (line 512) but never hash-checks, so 0 entries went
  stale across 2+ weeks of code change (audit finding). Implement D3:
  - Placement decision (stated per design.md option "extract a narrower
    checkFreshness(files) if needed"): implement INSIDE SqliteProvider.prime,
    not the kb-session-prime wrapper. Rationale: HttpKbProvider has no local
    files and is skipped automatically (its prime is untouched), and the
    wrapper stays clear for T3.5's edit (shared-file sequencing).
  - Design.md points at "the sync path (lines 436-490)"; verified reality:
    sync() is a local-only stub -- the hash machinery is computeFileHashBatch
    (src/services/knowledge/file-hash.js) as used by context()/invalidate().
    Reuse computeFileHashBatch in a new private checkFreshness(entries):
    collect the distinct source_files of the top_entries candidates ONLY
    (bounded work -- never the whole KB), batch-hash them, and for entries
    whose content_hash is set and mismatches (or whose file is missing) set
    stale = 1 in the DB and drop them from the returned top_entries.
    Entries with empty content_hash (most non-context-cache entries today)
    are skipped -- no hash baseline means no staleness verdict.
  - Non-fatal: wrap the whole check in try/catch; any error -> prime returns
    exactly today's behavior. Fast: one batch hash call, one UPDATE.
- Tests: (a) capture an entry with a source file + content_hash, modify the
  file, prime again -> entry marked stale=1 and absent from top_entries;
  (b) error path: make the hash batch throw -> prime output identical to
  today's (graceful degradation); (c) entries without content_hash are
  untouched. Use a temp-dir sqlite DB per test as existing provider tests do.
- Done: stale-on-prime proven by test; error path degrades to current
  behavior; work bounded to the primed set; suite green.

### T2.3 -- F5: Provenance enums stamped by the tool layer (D5)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/types.ts, src/tools/kb-capture.ts,
  src/tools/kb-promote.ts, src/index.ts (tool descriptions), tests.
- Audit finding: author is a free string ({"", claude, kb-agent, Knowledge
  Agent, pm, pm-planner}); source is used loosely. Implement D5 exactly:
  - types.ts: `Author = 'doer' | 'reviewer' | 'planner' | 'plan-reviewer' |
    'kb-agent' | 'pm' | 'user'` and REDEFINE `CaptureSource = 'session' |
    'review' | 'harvest' | 'promotion' | 'user-directive' | 'unknown'`.
  - Compatibility decision (existing rows carry old source values 'doer',
    'reviewer', 'user_interrupt', 'kb_agent_harvest'): KBEntry keeps reading
    whatever is in the DB -- type the read side tolerantly (e.g.
    `source: CaptureSource | string` on KBEntry, or a LegacyCaptureSource
    union kept alongside) so rowToEntry does not lie and NO row is migrated
    (D5: "existing rows keep their historical values (no migration)").
    New WRITES are enum-only.
  - Tool layer stamps values: kb-capture accepts an optional role hint; the
    handler validates it against the Author union and stamps the validated
    value; an invalid or absent hint is stamped as the literal 'unknown'
    (D5: "validated against the enum and defaulted to 'unknown' if invalid
    -- never a free string"; note 'unknown' is the fallback literal even
    though it is not in the Author union -- type the write path as
    Author | 'unknown'). Source is stamped by the handler, never by the
    caller: kb_capture -> 'session' (or 'review'/'user-directive' when the
    validated role/type implies it), kb_promote path -> 'promotion'. Update
    the zod schemas so callers cannot pass arbitrary strings through.
  - kb-harvest.ts writes source 'kb_agent_harvest' today; map its writes to
    'harvest' (the tool is retired in T3.2 but must still compile).
- Tests: capture with valid role -> stamped enum value; invalid/absent ->
  'unknown'; promote stamps 'promotion' on its note path metadata (or
  documented equivalent); existing-row reads with legacy values still parse.
- Done: no free-string author/source can enter via the tool layer; no row
  migration; suite green.

### T2.4 -- VERIFY Phase 2

- Type: verify (no model)
- Same sequence as T1.5, verbatim:
  1. npm run build
  2. npm test (only the 2 timezone failures in tests/time-utils.test.ts,
     yashr-302, may fail)
  3. npx gitnexus analyze (non-fatal)
  4. MANDATORY: git checkout -- AGENTS.md CLAUDE.md (KB runbook 3fa771af --
     analyze injects non-ASCII markers into both files every time)
  5. ASCII sweep of changed .md/.yml/.sh files
  6. git push origin feat/code-intelligence-abstraction. NEVER main. NO PR.

---

## Phase 3 -- P2 Reach and sharing (F6, F7, F8)

### T3.1 -- F6: user-directive entry type at the highest trust tier (D6)

- Model: claude-opus-4-8
- Files: src/services/knowledge/types.ts (ContentType union),
  src/tools/kb-capture.ts (D1-clamp exemption goes live),
  src/services/knowledge/sqlite-provider.ts (decayConceptEntries, AUDN
  supersede guard), src/services/knowledge/audn.ts if the guard belongs in
  makeAudnDecision, skills/pm/tpl-kb-agent.md + skills/pm/SKILL.md (or
  index.md) for the WHEN-to-record documentation, tests.
- Semantics (D6, all four are binding):
  1. Add 'user-directive' to ContentType. Captured via kb_capture with
     type='user-directive'; the tool layer stamps author='user',
     source='user-directive' (enums from T2.3) and confidence='CONFIRMED' --
     this is the SOLE exemption from the T1.1 clamp (the guard written in
     T1.1 becomes reachable; remove the raw-string workaround and use the
     typed union).
  2. NEVER auto-decayed: decayConceptEntries must exclude
     type='user-directive' (add `AND type != 'user-directive'` to the
     UPDATE's WHERE). It also must never be downgraded by any other
     automatic path.
  3. Only superseded by another user-directive: in the AUDN flow, when the
     matched candidate has type='user-directive' and the input does NOT,
     the 'update' (supersede) decision is forbidden -- degrade to 'flagged'
     when a contradiction signal exists (T1.4 logic), else 'add'. An agent
     capture can never retire a user directive. When BOTH are
     user-directives, normal supersede applies. Decide whether the guard
     lives in makeAudnDecision (preferred: pure, testable) or evaluateAudn;
     state the choice in a comment.
  4. Retrieval: CONFIRMED-equivalent ranking (confidence='CONFIRMED'
     achieves this with no extra ranking code -- state this in a comment).
  Document WHEN to record one in tpl-kb-agent.md and the PM skill: "when the
  user gives a standing instruction/correction during a sprint ('always do
  X', 'never do Y', 'we decided Z')" (D6 wording).
- Tests: a user-directive is retrievable at top rank via prime/query;
  decayConceptEntries run does NOT downgrade it (while a control INFERRED
  concept entry IS downgraded); an agent capture with contradicting content
  and shared symbols does NOT supersede it -- old entry keeps
  superseded_at IS NULL and gets flagged instead; a second user-directive
  DOES supersede the first (superseded_at + stale per T1.3); the clamp
  exemption stores CONFIRMED at capture.
- Done: all four semantics proven by tests; templates document the trigger;
  suite green.

### T3.2 -- F7: Retire kb_harvest (D7)

- Model: claude-haiku-4-5
- Files: src/tools/kb-harvest.ts (description/deprecation), src/index.ts
  (line ~362 registration text), skills/pm/tpl-doer.md,
  skills/pm/tpl-kb-agent.md, skills/pm/doer-reviewer-loop.md, any docs/
  references (search docs/ for harvest mentions), tests (registration only).
- Audit: kb_harvest is vestigial (regex over a transcript the agent cannot
  access). Per D7:
  - Keep the tool REGISTERED (backward compat -- callers must not crash) but
    mark it DEPRECATED in the tool description in src/index.ts and in
    kb-harvest.ts (e.g. "DEPRECATED: no longer dispatched; use kb_capture +
    kb_promote via the KB Agent"). Its behavior may remain as-is; nothing
    dispatches it.
  - Remove every kb_harvest instruction from tpl-doer.md, tpl-kb-agent.md,
    doer-reviewer-loop.md, and docs that present harvest as an active path.
    KB-Agent direct capture (kb_capture + kb_promote) is the sole documented
    capture path.
- Tests: no churn beyond confirming the tool still imports and registers
  without crash (existing registration test or a minimal new one).
- Done: zero template/docs references to harvest as active; tool registered
  + deprecated; suite green. ASCII only in the .md edits.

### T3.3 -- F8a: kb_list tool (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-list.ts (new), src/index.ts (register), tests.
- New read-only tool in the kb-*.ts style (zod schema + handler like
  kb-query.ts): input { confidence?, type?, module?, symbol?, limit? } ->
  matching entries with the field set (id, type, confidence, title, summary,
  symbols, source_files). Routed through providers.project (getKbProviders).
  Purpose: make the CONFIRMED set visible ("the gate is decorative" audit
  finding becomes auditable). Filtering notes: confidence/type/module are
  column filters; symbol filters entries whose symbols array contains the
  value (json_each, as context() does for source_files). Excludes
  superseded/stale by default. Register in src/index.ts with a clear
  description ("List KB entries by confidence/type/module/symbol -- use to
  audit the CONFIRMED set"). Read-only: must not bump use_count (either add
  a query option or a dedicated provider read -- state the choice).
- Tests: filter by confidence returns only that tier; type/module/symbol
  filters work; limit respected; superseded entries excluded.
- Done: kb_list registered and filter-proven by tests; suite green.

### T3.4 -- F8b: Canonical export -- .fleet/kb-canonical.json (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-export.ts (new, small), src/index.ts (register),
  skills/pm/tpl-kb-agent.md (post-promotion step), skills/pm/SKILL.md or
  index.md (PM commits the file), tests.
- Implement the export half of the "shareable, diffable team bible":
  - kb_export tool (D8 calls it "a small exported helper kb_export";
    decision: register it as a real MCP tool so the KB Agent -- which only
    has MCP tools -- can invoke it after promoting): writes all CONFIRMED,
    non-superseded, non-stale project entries to
    <repo>/.fleet/kb-canonical.json with the STABLE field set: id, type,
    title, summary, symbols, source_files, confidence, updated_at. Stable
    ordering (by id) so diffs are meaningful. ASCII-safe JSON output
    (JSON.stringify with 2-space indent; non-ASCII in entry text must be
    escaped -- use \u escapes via a replacer or sanitize -- because the
    file is committed to the repo; note the ASCII-only convention).
    Repo root resolution: accept an explicit repo path input (validated),
    consistent with how other fleet tools resolve the working repo.
  - tpl-kb-agent.md: after kb_promote steps, run kb_export; the PM commits
    .fleet/kb-canonical.json (document in the PM skill page). The PM commit
    step is documentation only -- no automation in this task.
- Tests: export writes the expected JSON shape (fixture KB with a CONFIRMED
  + an INFERRED + a superseded CONFIRMED entry -> only the live CONFIRMED
  appears); field set exact; deterministic ordering; missing .fleet dir is
  created.
- Done: export proven by tests; templates document the flow; suite green.

### T3.5 -- F8c: kb_session_prime cold-seed from kb-canonical.json (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-session-prime.ts (LAST sequenced edit on this shared
  file -- T2.1's neighbor-expansion block must not be restructured),
  tests/knowledge/kb-session-prime.test.ts.
- After the existing prime + global-append + graph-neighbor blocks: when the
  local KB is cold (decision rule: result.top_entries is empty or has fewer
  than 3 entries after all merges -- state the threshold as a named const),
  read <repo>/.fleet/kb-canonical.json if present, and merge its entries
  into top_entries marked `via: 'canonical-bible'`, BELOW all live-KB hits,
  deduped by id, capped (reuse ADDED_ENTRY_CAP or a new const). Relevance:
  prefer canonical entries whose symbols/module match the hint_symbols/
  hint_modules when hints exist; otherwise take the first N. Non-fatal:
  entire block in try/catch -- missing file, unreadable JSON, or bad shape
  degrades to today's output exactly (same hard-skip contract as the
  neighbor expansion above it). Repo root: derive from session_files/cwd the
  same way other prime inputs are validated -- if no reliable repo root is
  available, skip silently.
- Tests (module-singleton pattern per KB 989d00c3: vi.resetModules() +
  dynamic import + vi.hoisted, as this test file already does): (a) cold KB
  + fixture canonical file -> canonical entries appear with
  via:'canonical-bible' below any live hits; (b) file absent -> output
  identical to today; (c) malformed JSON -> output identical to today;
  (d) warm KB (>= threshold live hits) -> no canonical merge.
- Done: seed and all three degrade paths proven by tests; T2.1 block
  untouched; suite green.

### T3.6 -- VERIFY Phase 3 (sprint close)

- Type: verify (no model)
- Same sequence, verbatim:
  1. npm run build
  2. npm test (only the 2 timezone failures in tests/time-utils.test.ts,
     yashr-302, may fail)
  3. npx gitnexus analyze (non-fatal)
  4. MANDATORY: git checkout -- AGENTS.md CLAUDE.md (KB runbook 3fa771af)
  5. ASCII sweep of all sprint-changed .md/.yml/.sh files, including
     .fleet/kb-canonical.json if committed by then
  6. git push origin feat/code-intelligence-abstraction. NEVER push main.
     NO PR -- the user raises PRs.

---

## Task/model summary

| Task | Feature | Model | Type |
|------|---------|-------|------|
| T1.1 | F1 gate clamp | claude-opus-4-8 | work |
| T1.2 | F1 docs/template | claude-haiku-4-5 | work |
| T1.3 | F2 supersede | claude-sonnet-4-6 | work |
| T1.4 | F2 contradiction | claude-opus-4-8 | work |
| T1.5 | -- | (none) | verify |
| T2.1 | F4 OR-join | claude-sonnet-4-6 | work |
| T2.2 | F3 staleness | claude-sonnet-4-6 | work |
| T2.3 | F5 provenance | claude-sonnet-4-6 | work |
| T2.4 | -- | (none) | verify |
| T3.1 | F6 user-directive | claude-opus-4-8 | work |
| T3.2 | F7 retire harvest | claude-haiku-4-5 | work |
| T3.3 | F8 kb_list | claude-sonnet-4-6 | work |
| T3.4 | F8 export | claude-sonnet-4-6 | work |
| T3.5 | F8 cold-seed | claude-sonnet-4-6 | work |
| T3.6 | -- | (none) | verify |

12 work tasks (3 opus, 7 sonnet, 2 haiku) + 3 verify. Fail-then-pass tests
are mandatory for T1.1 (gate clamp), T1.3 (supersede stale), T1.4
(contradiction flag), T2.1 (OR-join) per sprint done-criteria.
