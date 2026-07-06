# PLAN -- KB Integrity Sprint (epic yashr-oaf)

Branch: feat/code-intelligence-abstraction (base: main). All work lands on this
branch. NEVER push to main. NO PR -- the user raises PRs. Requirements:
requirements.md (F1-F8, phases P0/P1/P2). Binding decisions: design.md (D1-D8),
as REVISED in commit b97ee58 (D2 candidate-discovery fix, D3 content-hash scope,
D4 fourth FTS site, D7 harvest-is-autowired). This plan is the second revision,
folding in plan-review feedback.md (1 HIGH, 4 MEDIUM, 1 LOW).

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
- No mass migration (D1/D3/D5): existing KB rows -- the 44 directly-CONFIRMED
  entries, free-string author/source values, entries with no file-hash basis
  -- are historical data and MUST NOT be rewritten. All enforcement is
  forward-looking and documented as such. Entries lacking a hash basis are
  treated as fresh/unknown, never falsely stale.
- Tests: npm test must stay green except the 2 pre-existing timezone failures
  in tests/time-utils.test.ts (beads yashr-302), which are allowed to fail.
- Use code intelligence tools (code_context, code_impact, code_query,
  code_map, code_flow) for structural questions; never Glob/Grep for call
  graphs or symbol lookups. code_graph works via cypher CALLS traversal.

## Shared-file sequencing (binding order)

Tasks execute strictly in listed order; each is committed before the next.

- src/services/knowledge/audn.ts: T1.4 edits makeAudnDecision (contradiction
  logic); T2.1 edits makeFtsQuery (OR-join). Disjoint functions, T1.4 first
  (Phase 1) then T2.1 first-in-Phase-2 -> clean sequential rebase.
- src/services/knowledge/sqlite-provider.ts is the most-touched file. Order:
  T1.3 (evaluateAudn 'update' branch) -> T1.4 (findAudnCandidates type-filter)
  -> [Phase 1 commit] -> T2.1 (prime() searchTerms join) -> T2.2 (capture()
  hash-basis store + schema column + prime() checkFreshness) -> T3.1
  (decayConceptEntries guard). prime() is touched by T2.1 (searchTerms line)
  and T2.2 (new checkFreshness call) in different regions -- edit carefully,
  do not restructure T2.1's join.
- src/tools/kb-capture.ts: T1.1 (clamp) -> T2.3 (provenance stamping) -> T3.1
  (user-directive clamp exemption goes live). Sequential, each builds on prior.
- src/tools/kb-session-prime.ts: T2.1 edits the global-append query (line ~83)
  AND the neighbor-batch join (line ~141); T3.5 adds a canonical cold-seed
  block AFTER the neighbor expansion. T2.1 first, T3.5 last; T3.5 must not
  restructure T2.1's code. F3 (T2.2) deliberately does NOT edit this file
  (freshness lives in SqliteProvider.prime).
- src/tools/kb-harvest.ts: T2.3 edits the author/source literals (provenance,
  must compile with the revised enums); T3.2 keeps the autowire, cleans
  templates/docs, and adds the UNVERIFIED+source test. Disjoint concerns.
- src/services/knowledge/types.ts: T2.3 (Author/CaptureSource unions) -> T3.1
  (ContentType += 'user-directive'). Sequential.

---

## Phase 1 -- P0 Trust core (riskiest first: F1 gate, F2 supersede/contradiction)

### T1.1 -- F1: Enforce the CONFIRMED gate in kb_capture (D1)

- Model: claude-opus-4-8
- Files: src/tools/kb-capture.ts, src/index.ts (tool description), new
  tests/knowledge/kb-capture-gate.test.ts.
- Today kb-capture.ts accepts confidence 'CONFIRMED' from any caller (zod enum
  at line 19, applied as `input.confidence ?? 'INFERRED'` at line 64). Audit
  evidence: 44/44 CONFIRMED entries bypassed kb_promote. Implement the D1
  clamp in the kbCapture handler (server-side, NOT just the zod schema; the
  zod confidence param stays for back-compat):
  - UNVERIFIED and INFERRED pass through unchanged.
  - CONFIRMED is downgraded to INFERRED. The clamp must be visible to the
    caller: return `confidence_clamped: true` in the JSON result (alongside
    id and audn_decision) AND append a short bracketed note to the entry
    content (use string concatenation, not a template literal, per the ASCII
    hook gotcha), e.g. "[confidence clamped: CONFIRMED requires kb_promote]".
    Never silently mislead the caller (D1).
  - kb_promote (src/tools/kb-promote.ts, provider promote()) remains the ONLY
    path to CONFIRMED. Do not change promote logic.
  - D6 forward-compat: write the clamp with an explicit exemption
    `input.type === 'user-directive'` that bypasses the clamp. That type does
    not exist in the ContentType union until T3.1, so guard it in a way that
    compiles today (compare against the raw string with a TODO comment
    referencing T3.1). Comment it as the D6 exception.
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
- Documentation only, no code:
  - tpl-kb-agent.md: instruct the KB Agent to capture at INFERRED and use
    kb_promote (id + reason) to mint CONFIRMED after verification. Reconcile
    the confidence decision table with the enforced behavior from T1.1
    (capture never yields CONFIRMED; promotion does; user-directive is the
    future exception per D6).
  - docs/kb-trust-model.md (new, one short page): the trust ladder
    UNVERIFIED -> INFERRED -> CONFIRMED, kb_promote as the sole CONFIRMED
    mint, the D1 forward-only enforcement note (existing direct-CONFIRMED
    rows are historical and not migrated), the D6 user-directive exception
    (one sentence, implemented in Phase 3), and a note that auto-harvested
    entries are UNVERIFIED regex-extracted low-trust captures (D7 -- harvest
    is autowired, not dead).
- ASCII only (these are .md files -- the pre-commit hook scans them).
- Done: template tells KB Agent to use kb_promote for CONFIRMED; decision
  table matches enforced behavior; docs note exists; no non-ASCII.

### T1.3 -- F2a: Supersede for real -- 'update' marks old entry superseded_at + stale (D2)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/sqlite-provider.ts (evaluateAudn, 'update'
  branch, line ~272), tests/knowledge (extend sqlite-provider/audn tests).
- Verified current state (feedback.md resolution (c) CONFIRMED): the 'update'
  branch DOES set superseded_at (line 273) but does NOT set stale = 1. D2
  requires both. Change the statement to set superseded_at = now AND stale = 1
  on the old entry; leave content_hash intact. Do not touch the flagged or
  none branches (T1.4 owns the contradiction path). One concern per task.
- Tests (MUST FAIL on today's code, PASS after): capture entry A, then
  capture a correcting entry B with overlapping symbols AND files, same type,
  similar title (so AUDN decides 'update'); assert old row has superseded_at
  set AND stale = 1 (the stale assertion fails today). Assert the new entry is
  live and query() excludes the old one by default.
- Done: fail-then-pass test on the stale column; superseded_at still set;
  suite green.

### T1.4 -- F2b: Loosen contradiction detection + widen candidate discovery (D2)

- Model: claude-opus-4-8
- Files: src/services/knowledge/audn.ts (makeAudnDecision,
  hasContradictionKeywords, CONTRADICTION_KEYWORDS),
  src/services/knowledge/sqlite-provider.ts (findAudnCandidates, line ~231),
  tests/knowledge/audn.test.ts.
- This task fixes TWO coupled halves of the same concern: the contradiction
  logic AND the candidate discovery that feeds it. Both are required by the
  revised D2; without the discovery half the loosened logic is unreachable
  end-to-end (feedback.md findings 2 and 5).

  HALF A -- loosen makeAudnDecision (audn.ts). Today line 50 gates EVERYTHING
  on `symMatch && fileMatch`; a contradiction on shared symbols with no shared
  file is invisible (0 flagged across 92 live entries). Restructure per D2:
  - CONTRADICTION path: flag when symbolsOverlap(input.symbols,
    candidate.symbols) AND a contradiction signal exists -- REGARDLESS of
    filesOverlap. Keep existing flagged behavior (mark existing entry
    flagged_for_review = 1; new entry gets confidence UNVERIFIED,
    contradiction_of = candidate.id).
  - Contradiction signal = hasContradictionKeywords(input.content) OR a light
    opposite-polarity check between input and candidate content/title (D2:
    "keyword or opposite-polarity content"). Implement polarity conservatively
    as a small pure function over antonym pairs (broken/fails/does not work
    vs fixed/works/now works); it must catch the code_graph pair below without
    flagging ordinary refinements. Extending CONTRADICTION_KEYWORDS (e.g. 'no
    longer', 'is fixed', 'now works') is acceptable; keep it conservative.
  - DEDUP ('none') and UPDATE paths keep same-topic semantics AND now must
    also require candidate.type === input.type (since discovery no longer
    filters by type -- see HALF B). Only the contradiction path is cross-type.
  - Do not break T1.3's supersede behavior (evaluateAudn untouched here).

  HALF B -- widen findAudnCandidates (sqlite-provider.ts, revised D2
  CANDIDATE-DISCOVERY FIX). Today it filters `AND e.type = ?` (line ~242), so
  a cross-type contradiction (the code_graph pair: two 'knowledge' entries, or
  knowledge-vs-learning) is never even a candidate. Remove the same-type
  restriction from candidate discovery so symbol-overlap candidates of ANY
  type are returned; makeAudnDecision (HALF A) re-imposes same-type for the
  dedup/update decisions. Keep the FTS + superseded_at IS NULL + LIMIT
  structure. State in a comment that dedup/update remain same-type-only via
  the makeAudnDecision gate.
- Tests (MUST FAIL on today's code, PASS after) -- PURE level here; the
  capture()-level e2e proof is T2.1 (needs the OR-join to make FTS discovery
  work): feed makeAudnDecision the code_graph pair shape -- candidate: symbols
  ['GitNexusProvider.graph','callGitNexus'], type 'knowledge', source_files
  ['docs/code-intelligence-child-surface.md'], content "call_graph tool does
  not exist / code_graph is broken"; input: same symbols, type 'knowledge',
  source_files ['src/tools/code-intelligence-gitnexus.ts'] (NO shared file),
  content "code_graph now works / fixed via cypher CALLS traversal". Expect
  decision 'flagged' with contradiction_of set (today: null -> 'add'). Also:
  a same-symbol entry WITHOUT contradiction signal and without file overlap is
  NOT flagged (no false positive); existing dedup/update tests stay green (add
  a same-type dedup case to prove HALF A's re-imposed type gate).
- Reconciling the live code_graph pair in the apra-fleet KB is OUT of scope
  (live data); proving the new logic WOULD flag it is IN scope (D2).
- Done: fail-then-pass pure contradiction test; findAudnCandidates returns
  cross-type candidates; dedup/update stay same-type; suite green.

### T1.5 -- VERIFY Phase 1

- Type: verify (no model)
- Steps, in order:
  1. npm run build -- must be clean.
  2. npm test -- green; ONLY the 2 pre-existing timezone failures in
     tests/time-utils.test.ts (yashr-302) may fail.
  3. npx gitnexus analyze -- non-fatal (a failure here does not block).
  4. MANDATORY (KB runbook 3fa771af): git checkout -- AGENTS.md CLAUDE.md
     immediately after analyze to discard the non-ASCII markers it injects.
  5. Confirm no non-ASCII in any changed .md/.yml/.sh file.
  6. git push origin feat/code-intelligence-abstraction. NEVER push main.
     NO PR.

---

## Phase 2 -- P1 Freshness and retrieval (F4, F3, F5)

Order rationale: T2.1 (F4) first so its audn.ts + prime edits land immediately
after Phase 1's audn.ts/provider work (clean sequential rebase), AND because
the OR-join is what finally makes the F2 cross-type contradiction reachable at
capture() -- so T2.1 carries the F2 e2e proof. Then T2.2 (F3 freshness) and
T2.3 (F5 provenance), sequenced because both touch the capture path.

### T2.1 -- F4: FTS OR-join across ALL implicit-AND sites + F2 e2e proof (D4; closes yashr-5n2, yashr-17i)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/audn.ts (makeFtsQuery + new shared helper),
  src/services/knowledge/sqlite-provider.ts (prime(), line ~536),
  src/tools/kb-session-prime.ts (global-append line ~83 AND neighbor batch
  line ~141), tests/knowledge (audn.test.ts, sqlite-provider tests,
  kb-session-prime.test.ts).
- KB finding 83726d75 (verbatim): "SqliteProvider.query() passes the query
  string verbatim into FTS5 MATCH, treating space-separated terms as implicit
  AND. ... clean backlog follow-up: OR-join sanitized terms
  (neighbors.join(' OR ')) so entries matching ANY neighbor surface." Live
  proof: this sprint's planner prime with 7 hint_symbols returned ZERO
  top_entries from a 46-entry KB.
- Revised D4 requires fixing ALL FOUR implicit-AND sites via ONE shared
  helper. Sites (feedback.md finding 3 added the fourth):
  1. audn.ts makeFtsQuery (line 20): CHANGED. Decision (stated per D4): the
     shared OR-join helper replaces its join. Rationale: makeFtsQuery feeds
     findAudnCandidates; the F2 cross-type contradiction e2e (below) is
     unreachable while it AND-joins ("code_graph now works" tokens would
     require the OLD "broken" entry to contain 'works'). OR-join makes the
     old entry a candidate. Each token stays [a-zA-Z0-9_]{3,} (FTS-safe).
  2. sqlite-provider.ts prime() searchTerms (line ~536): today
     `searchTerms.join(' ')`. Sanitize each term (quote tokens per ftsSafeTerm
     -- tokens WITHIN one term stay space-joined = AND within a term) and join
     ACROSS terms with ' OR '.
  3. kb-session-prime.ts neighbor batch (line ~141): `.join(' ')` becomes the
     shared OR-join; ftsSafeTerm (intra-name quoted tokens) unchanged.
  4. kb-session-prime.ts global-append query (line ~83): today
     `input.session_files?.join(' ') ?? input.hint_symbols?.join(' ')` --
     multi-symbol implicit-AND AND raw file paths ('/', '.') are FTS5-hostile
     and throw into the silent catch (feedback.md finding 3). Sanitize with
     ftsSafeTerm and OR-join so multi-hint global appends actually return.
  Extract ONE exported helper (e.g. orJoinFtsTerms in audn.ts) used by all
  sites rather than hand-rolled joins. Ranking unchanged (ORDER BY rank /
  bm25 still applies). include_stale / l1_only filters intact.
- Shared-file note: SECOND edit to audn.ts (after T1.4, disjoint function) and
  FIRST Phase-2 edit to kb-session-prime.ts (T3.5 comes later).
- Tests:
  - Multi-term retrieval (MUST FAIL today, PASS after): seed two entries, one
    containing only termA, one only termB; a prime with both hint terms
    returns both (today: nothing). Single-term behavior unchanged (regression).
  - Neighbor-batch and global-append multi-term tests: two symbols that never
    co-occur now each surface entries; use the module-singleton pattern (KB
    989d00c3: vi.resetModules + dynamic import + vi.hoisted) as
    kb-session-prime.test.ts already does.
  - F2 e2e (MUST FAIL today, PASS after -- fulfils requirements F2 "add a test
    that proves it" at capture() level, feedback.md finding 5): call
    provider.capture() with entry A ("code_graph is broken", type 'knowledge',
    symbols [GitNexusProvider.graph, callGitNexus]), then capture() entry B
    ("code_graph now works, fixed via cypher CALLS", type 'learning' to prove
    CROSS-TYPE, same symbols, NO shared source_file). Assert audn_decision ===
    'flagged' and B.contradiction_of is A's id. Today this returns 'add'
    (candidate never discovered: type filter + AND-join). This is the
    integration proof that T1.4 + T2.1 together make F2 real.
- Done: fail-then-pass at prime, neighbor, global-append, AND capture()-level
  cross-type contradiction; single-term regression green; suite green.

### T2.2 -- F3: Auto-staleness at prime, keyed off source_files with a capture-time hash basis (revised D3)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/sqlite-provider.ts (schema/init migration,
  capture(), insertEntry, prime() + new private checkFreshness helper),
  tests/knowledge (sqlite-provider capture + prime tests).
- Today file-hash staleness runs only on explicit kb_invalidate; prime() runs
  decayConceptEntries but never hash-checks (audit: 0 entries stale across 2+
  weeks). The revised D3 (feedback.md finding 4) forbids the naive
  content_hash approach: content_hash is set ONLY for context-cache, and
  prime() excludes context-cache from top_entries (line 542), so a
  content_hash check would near-no-op. Instead key freshness off source_files
  with a per-file hash basis persisted AT CAPTURE for ALL types:

  PART A -- capture-time hash basis (additive, no migration):
  - Add an additive column `source_file_hashes TEXT NOT NULL DEFAULT '{}'`
    (JSON map file->hash) via the same try/catch ALTER TABLE pattern used for
    scope (init(), line ~147). Existing rows default to '{}' (no basis).
  - In SqliteProvider.capture() (NOT the kb-capture handler -- capture() is
    the single choke point that kb_capture, kb_harvest, and future paths all
    call, so every path gets a basis): when input.source_files is non-empty,
    computeFileHashBatch(source_files) and store the resolvable hashes as the
    JSON map on the new column. Files that do not resolve are simply absent
    from the map. insertEntry gains the column. Do this for ALL types.
  - No migration: existing rows keep '{}' and are treated fresh/unknown.

  PART B -- prime-time freshness check (bounded, non-fatal):
  - New private checkFreshness(entries) in SqliteProvider: for each candidate
    top_entry that HAS source_files AND a non-empty stored basis, re-hash its
    files (ONE computeFileHashBatch over the union of files in the primed set
    -- bounded, never the whole KB) and compare to the basis. If any basis
    file changed hash or is now missing, set stale = 1 on that entry (one
    UPDATE) and drop it from the returned top_entries. Entries with an empty
    basis are left untouched (never falsely stale).
  - Call it in prime() after top_entries is built, wrapped in try/catch: any
    error -> prime returns exactly today's output (graceful degradation).
- Tests: (a) capture an entry with a source file (basis stored), modify the
  file, prime again -> entry marked stale=1 and absent from top_entries;
  (b) error path: force the hash batch to throw -> prime output identical to
  today's; (c) an entry with no source_files / empty basis is untouched by a
  prime even when unrelated files change. Use a temp-dir sqlite DB + temp
  source files per test as existing provider tests do.
- Done: capture stores a per-file basis for all types; stale-on-prime proven
  by test keyed off source_files; error path degrades; work bounded to the
  primed set; suite green.

### T2.3 -- F5: Provenance enums stamped by the tool layer (D5 + D7 harvest provenance, LOW finding 6)

- Model: claude-sonnet-4-6
- Files: src/services/knowledge/types.ts, src/tools/kb-capture.ts,
  src/tools/kb-promote.ts, src/tools/kb-harvest.ts (author/source literals
  only), src/index.ts (tool descriptions), tests.
- Audit: author is a free string ({"", claude, kb-agent, Knowledge Agent, pm,
  pm-planner, kb-harvest}); source is used loosely. Implement D5, and fold in
  the harvest-provenance LOW finding:
  - types.ts: `Author = 'doer' | 'reviewer' | 'planner' | 'plan-reviewer' |
    'kb-agent' | 'harvest' | 'pm' | 'user'`. NOTE: 'harvest' is ADDED to the
    D5 list per the revised D7 (harvested entries need a distinct author from
    real KB-Agent captures; feedback.md LOW finding 6). Record this deviation
    from D5's literal enum in progress.json notes. `CaptureSource = 'session'
    | 'review' | 'harvest' | 'promotion' | 'user-directive' | 'unknown'`.
  - Tolerant reads (no migration): existing rows carry legacy source values
    ('doer','reviewer','user_interrupt','kb_agent_harvest') and legacy authors.
    Type the KBEntry read side tolerantly (e.g. `source: CaptureSource |
    string`, `author: string`) so rowToEntry does not lie and NO row is
    migrated (D5). New WRITES are enum-only.
  - Tool-layer stamping (never free strings): the kb-capture handler accepts
    an optional role hint, validates it against Author, and stamps the
    validated value; an invalid/absent hint is stamped as the literal
    'unknown' (D5: "validated against the enum and defaulted to 'unknown' if
    invalid -- never a free string"; type the write path Author | 'unknown').
    source is stamped by the handler, never the caller: kb_capture -> 'session'
    (or 'review'/'user-directive' when the validated role/type implies it);
    kb_promote path -> 'promotion'. Tighten the zod schemas so callers cannot
    pass arbitrary strings.
  - kb-harvest.ts (LOW finding 6 + revised D7): change the two literals only
    -- author 'kb-harvest' -> 'harvest', source 'kb_agent_harvest' ->
    'harvest'. This is required here (not deferred) because changing the
    CaptureSource union breaks kb-harvest.ts compilation otherwise. Confidence
    stays UNVERIFIED (do not touch). The autowire, templates, docs, and the
    UNVERIFIED-assertion test are T3.2's concern (disjoint lines).
- Tests: capture with a valid role -> stamped enum value; invalid/absent ->
  'unknown'; promote path stamps 'promotion'; a harvested entry gets
  author='harvest' + source='harvest'; existing-row reads with legacy values
  still parse.
- Done: no free-string author/source can enter via the tool layer; harvest
  provenance canonicalized; no row migration; build green (kb-harvest.ts
  compiles against the new unions); suite green.

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
  src/services/knowledge/sqlite-provider.ts (decayConceptEntries;
  findAudnCandidates is already cross-type from T1.4),
  src/services/knowledge/audn.ts (makeAudnDecision supersede guard),
  skills/pm/tpl-kb-agent.md + the PM skill page (skills/pm/SKILL.md or
  index.md), tests.
- Semantics (D6, all four binding):
  1. Add 'user-directive' to ContentType. Captured via kb_capture with
     type='user-directive'; the tool layer stamps author='user',
     source='user-directive' (enums from T2.3) and confidence='CONFIRMED' --
     the SOLE exemption from the T1.1 clamp. Replace T1.1's raw-string guard
     with the typed union now that it exists.
  2. NEVER auto-decayed: add `AND type != 'user-directive'` to
     decayConceptEntries' UPDATE WHERE. (Belt-and-braces: decay today only
     touches confidence='INFERRED' rows and a user-directive is CONFIRMED, so
     it is already safe -- state this in a comment; the guard is defensive.)
  3. Only superseded by another user-directive: in makeAudnDecision
     (preferred: pure + testable; state the choice in a comment), when the
     matched candidate.type === 'user-directive' and input.type !==
     'user-directive', the 'update'/supersede decision is FORBIDDEN -- degrade
     to 'flagged' if a contradiction signal exists (T1.4 logic), else 'add'.
     An agent capture can never retire a user directive. When BOTH are
     user-directives, normal supersede applies. This relies on T1.4's
     cross-type findAudnCandidates (so a user-directive candidate is actually
     discovered for a differently-typed agent capture) -- confirm that path.
  4. Retrieval: confidence='CONFIRMED' gives CONFIRMED-equivalent ranking with
     no extra ranking code -- state this in a comment.
  Document WHEN to record one (tpl-kb-agent.md + PM skill): "when the user
  gives a standing instruction/correction during a sprint ('always do X',
  'never do Y', 'we decided Z')" (D6 wording).
- Tests: a user-directive is retrievable at top rank via prime/query;
  decayConceptEntries run does NOT downgrade it (control INFERRED concept
  entry IS downgraded); an agent capture (different type) with contradicting
  content + shared symbols does NOT supersede it (old keeps superseded_at IS
  NULL, gets flagged); a second user-directive DOES supersede the first
  (superseded_at + stale per T1.3); clamp exemption stores CONFIRMED at
  capture.
- Done: all four semantics proven by tests; templates document the trigger;
  suite green.

### T3.2 -- F7: Keep kb_harvest autowired; make it honest and low-trust (revised D7)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-harvest.ts (comment/description clarifying the manual
  path is discouraged -- provenance literals were already fixed in T2.3),
  src/tools/execute-prompt.ts (VERIFY the autowire is unchanged -- do NOT
  remove it), tests/knowledge/kb-harvest-autowire.test.ts (must stay green),
  skills/pm/tpl-doer.md, skills/pm/tpl-kb-agent.md,
  skills/pm/doer-reviewer-loop.md, docs referencing harvest, new/extended test.
- CORRECTED premise (revised D7, feedback.md HIGH finding 1): kb_harvest is
  NOT vestigial. src/tools/execute-prompt.ts lines ~323-330 auto-dispatch
  kbHarvest fire-and-forget on every successful execute_prompt, passing the
  session transcript (the agent itself lacks it). tests/knowledge/
  kb-harvest-autowire.test.ts asserts this wiring. The 14 harvest-sourced KB
  entries came from this path. So do NOT rip harvest out.
  - Keep the autowire exactly as-is (execute-prompt.ts unchanged;
    kb-harvest-autowire.test.ts must still pass). Confirm harvested entries are
    UNVERIFIED (they are, line 114) and that the D1 clamp (T1.1) covers this
    path -- harvest can never mint CONFIRMED. Provenance (author='harvest',
    source='harvest') was set in T2.3; this task just confirms it.
  - Remove ONLY the redundant "call kb_harvest yourself at session end"
    manual-path instruction from tpl-doer.md IF present (the agent calling it
    manually with no transcript is the useless path). Do NOT strip the
    autowire description. Keep tpl-kb-agent.md's direct-capture flow as the
    primary documented path; add one line clarifying the autowire is a
    separate, low-trust, transcript-fed path that produces UNVERIFIED entries.
  - Update docs to describe harvest accurately (autowired, UNVERIFIED,
    regex-extracted) rather than calling it dead.
- Tests: kb-harvest-autowire.test.ts stays green (do not break the wiring
  strings it greps for). ADD a behavioral test: run kbHarvest against a
  fixture transcript containing a matchable learning and assert the captured
  entry is confidence UNVERIFIED and source='harvest' (author='harvest').
- Done: autowire preserved + autowire test green; harvested entries proven
  UNVERIFIED + source='harvest'; only the redundant manual instruction removed
  from tpl-doer.md; docs accurate; ASCII only in .md edits; suite green.

### T3.3 -- F8a: kb_list tool (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-list.ts (new), src/index.ts (register), tests.
- New read-only tool in the kb-*.ts style (zod schema + handler like
  kb-query.ts): input { confidence?, type?, module?, symbol?, limit? } ->
  matching entries (id, type, confidence, title, summary, symbols,
  source_files). Routed through providers.project (getKbProviders). Purpose:
  make the CONFIRMED set visible (the "gate is decorative" audit finding
  becomes auditable). Filtering: confidence/type/module are column filters;
  symbol filters entries whose symbols array contains the value (json_each, as
  context() does for source_files). Excludes superseded/stale by default.
  Register in src/index.ts with a clear description ("List KB entries by
  confidence/type/module/symbol -- audit the CONFIRMED set"). Read-only: must
  NOT bump use_count (query() bumps it at lines 406-411, confirmed in review;
  add a query option or a dedicated provider read -- state the choice).
- Tests: filter by confidence returns only that tier; type/module/symbol
  filters work; limit respected; superseded entries excluded.
- Done: kb_list registered and filter-proven by tests; suite green.

### T3.4 -- F8b: Canonical export -- .fleet/kb-canonical.json (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-export.ts (new, small), src/index.ts (register),
  skills/pm/tpl-kb-agent.md (post-promotion step), the PM skill page, tests.
- Export half of the shareable, diffable team bible:
  - kb_export tool (D8 calls it "a small exported helper kb_export"; decision:
    register it as a real MCP tool so the KB Agent -- MCP-only -- can invoke it
    after promoting): writes all CONFIRMED, non-superseded, non-stale project
    entries to <repo>/.fleet/kb-canonical.json with the STABLE field set: id,
    type, title, summary, symbols, source_files, confidence, updated_at.
    Deterministic ordering (by id) so diffs are meaningful. ASCII-safe output:
    JSON.stringify with 2-space indent, and ensure non-ASCII in entry text is
    escaped (\u) since the file is committed under the ASCII-only convention.
    Repo root: accept an explicit validated repo path input, consistent with
    other fleet tools.
  - tpl-kb-agent.md: after kb_promote, run kb_export; the PM commits
    .fleet/kb-canonical.json (document in the PM skill page). The commit is
    documentation only -- no automation here.
- Tests: export writes the expected JSON shape (fixture KB with a CONFIRMED +
  an INFERRED + a superseded CONFIRMED -> only the live CONFIRMED appears);
  field set exact; deterministic ordering; missing .fleet dir is created.
- Done: export proven by tests; templates document the flow; suite green.

### T3.5 -- F8c: kb_session_prime cold-seed from kb-canonical.json (D8)

- Model: claude-sonnet-4-6
- Files: src/tools/kb-session-prime.ts (LAST sequenced edit -- T2.1's global-
  append and neighbor-expansion blocks must not be restructured),
  tests/knowledge/kb-session-prime.test.ts.
- After the existing prime + global-append + graph-neighbor blocks: when the
  local KB is cold (named const threshold, e.g. COLD_KB_MAX = 3: fewer than 3
  entries in top_entries after all merges), read <repo>/.fleet/kb-canonical.json
  if present and merge its entries into top_entries marked
  `via: 'canonical-bible'`, BELOW all live-KB hits, deduped by id, capped
  (reuse ADDED_ENTRY_CAP or a new const). Prefer canonical entries whose
  symbols/module match hint_symbols/hint_modules when hints exist; else take
  the first N. Non-fatal: entire block in try/catch -- missing file,
  unreadable JSON, or bad shape degrades to today's output exactly (same
  hard-skip contract as the neighbor expansion above it). Repo root: derive
  from session_files/cwd the way other prime inputs are validated; if none is
  reliable, skip silently.
- Tests (module-singleton pattern, KB 989d00c3: vi.resetModules + dynamic
  import + vi.hoisted, as this file already does): (a) cold KB + fixture
  canonical file -> canonical entries appear with via:'canonical-bible' below
  any live hits; (b) file absent -> output identical to today; (c) malformed
  JSON -> output identical to today; (d) warm KB (>= threshold live hits) ->
  no canonical merge.
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
| T1.3 | F2 supersede stale | claude-sonnet-4-6 | work |
| T1.4 | F2 contradiction + candidate discovery | claude-opus-4-8 | work |
| T1.5 | -- | (none) | verify |
| T2.1 | F4 OR-join (4 sites) + F2 e2e | claude-sonnet-4-6 | work |
| T2.2 | F3 staleness (capture basis + prime) | claude-sonnet-4-6 | work |
| T2.3 | F5 provenance + harvest provenance | claude-sonnet-4-6 | work |
| T2.4 | -- | (none) | verify |
| T3.1 | F6 user-directive | claude-opus-4-8 | work |
| T3.2 | F7 harvest honest + low-trust | claude-sonnet-4-6 | work |
| T3.3 | F8 kb_list | claude-sonnet-4-6 | work |
| T3.4 | F8 export | claude-sonnet-4-6 | work |
| T3.5 | F8 cold-seed | claude-sonnet-4-6 | work |
| T3.6 | -- | (none) | verify |

12 work tasks (3 opus, 8 sonnet, 1 haiku) + 3 verify. Fail-then-pass tests are
mandatory for T1.1 (gate clamp), T1.3 (supersede stale), T1.4 (contradiction
flag, pure), T2.1 (OR-join AND the F2 cross-type contradiction at capture())
per sprint done-criteria.
