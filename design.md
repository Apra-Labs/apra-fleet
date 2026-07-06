# Design -- KB Integrity

Binding decisions for the kb-integrity sprint (epic yashr-oaf). Planner and
reviewers check code against these; deviations need a recorded reason in
progress.json notes.

Relevant code (verified 2026-07-06):
- src/tools/kb-capture.ts -- confidence param `z.enum(['CONFIRMED','INFERRED',
  'UNVERIFIED']).optional()` (line 19), applied `input.confidence ?? 'INFERRED'`
  (line 64). This is the open gate.
- src/tools/kb-promote.ts -- kbPromote upgrades confidence; registered as a tool
  (src/index.ts:363). Appends a promotion note.
- src/services/knowledge/sqlite-provider.ts -- capture() runs AUDN
  (makeAudnDecision) and returns audn_decision (add/none/update/flagged); query()
  builds FTS MATCH (makeFtsQuery in audn.ts); sync() does file-hash staleness
  (lines 436-490, computeFileHashBatch) but is only called by kb_invalidate;
  prime() runs decayConceptEntries (line 512) but NOT file-hash sync.
- src/services/knowledge/audn.ts -- hasContradictionKeywords, symbolsOverlap,
  filesOverlap, makeFtsQuery, makeAudnDecision (the AND-logic contradiction gate).
- src/services/knowledge/types.ts -- KBEntry / KBEntryInput / Confidence /
  CaptureSource definitions.
- src/tools/kb-session-prime.ts -- the prime wrapper (P4b neighbor expansion here
  too); calls providers.project.prime then appends globals.

## D1 -- Gate: kb_capture caps at INFERRED; only kb_promote mints CONFIRMED

- kb_capture clamps any incoming confidence to a max of INFERRED. UNVERIFIED and
  INFERRED are accepted as-is; CONFIRMED is downgraded to INFERRED with the
  clamp recorded (a note or a returned flag) so the caller is not silently
  misled. Prefer keeping the confidence param (back-compat) but enforcing the cap
  server-side in kbCapture/provider.capture -- not just the zod schema.
- kb_promote remains the ONLY path to CONFIRMED. It already requires an id +
  reason; keep that.
- The single exception is entry type `user-directive` (D6), which is authoritative
  on capture and bypasses the clamp.
- Do NOT mass-migrate the existing 44 direct-CONFIRMED rows -- they are historical.
  Enforcement is forward-only. Document this in kb-capture.ts and a one-paragraph
  docs/kb-trust-model.md.

## D2 -- Supersede for real + looser contradiction flagging

- In provider.capture(), when AUDN returns 'update' (a correcting entry for an
  existing one), the OLD entry MUST be updated: set superseded_at = now and
  stale = 1 (and content_hash left intact). Verify the current update branch --
  the live code_graph pair proves the old entry was neither superseded nor
  staled. Add a test asserting the superseded/stale columns after an update.
- Contradiction flagging (makeAudnDecision + hasContradictionKeywords): today it
  requires symbol overlap AND file overlap. Loosen to: flag when there is symbol
  overlap AND contradiction signal (keyword or opposite-polarity content),
  regardless of file overlap. Keep dedup/update behavior for genuine same-topic
  refinements; only widen the CONTRADICTION path. Add a test using the
  code_graph broken-vs-fixed shape (same symbol code_graph/call_graph, no shared
  file necessarily) -> expect flagged.
- CANDIDATE-DISCOVERY FIX (plan review, MEDIUM): findAudnCandidates currently
  filters candidates by `AND e.type = ?`, so a contradiction across entry types
  (e.g. a 'knowledge' "code_graph broken" vs a later 'knowledge' fix, or across
  knowledge/learning) is never even considered. The code_graph pair in the live
  KB is exactly this. For the CONTRADICTION path, candidate discovery must match
  on symbol overlap WITHOUT the same-type restriction (dedup/update may keep the
  type filter). Without this fix the loosened contradiction logic is unreachable
  end-to-end, and the e2e flag test cannot pass. This is required for F2, not
  optional.
- Reconciling the existing live code_graph pair is OUT of scope (live data). The
  new logic proving it WOULD flag going forward (via test) is IN scope.

## D3 -- Auto-staleness at prime

- kb_session_prime, before returning, runs the file-hash staleness check for the
  source_files of the entries it is about to surface (build a checkFreshness(files)
  helper using computeFileHashBatch from file-hash.js; sync() at
  sqlite-provider.ts:610 is a STUB, do not use it; HttpKbProvider has no local
  files -> skip there). Entries whose files changed are marked stale=1 and
  excluded from top_entries (prime already filters include_stale:false).
- CONTENT-HASH SCOPE FIX (plan review, MEDIUM): today only context-cache entries
  carry a content_hash, and prime already excludes context-cache from top_entries,
  so a naive "compare content_hash" staleness check would near-no-op. Instead key
  the freshness check off source_files presence, not content_hash: for ANY entry
  in the primed set that has source_files, hash those files now (computeFileHashBatch)
  and compare against a stored per-file basis. If entries lack a stored file-hash
  basis, this sprint must ALSO persist one at capture time (store file hashes for
  source_files on capture, for all types, not just context-cache) so staleness is
  computable. State the storage approach in the task; keep it a small additive
  column/side-table, no migration of existing rows (they simply have no basis ->
  treated as fresh/unknown, never falsely stale).
- Fast + non-fatal: wrap in try/catch; any error -> prime behaves as today. Bound
  the work (only the files in the primed set, not the whole KB).
- Tests: an entry whose source file is modified after capture is marked stale and
  dropped from a subsequent prime; error path degrades gracefully.

## D4 -- FTS OR-join

- makeFtsQuery (audn.ts) currently joins terms so FTS5 treats them as implicit
  AND. Change multi-term queries to OR semantics (FTS5 `term1 OR term2 OR ...`,
  each term still sanitized/quoted per the existing ftsSafeTerm approach).
  Single-term queries unchanged. Ranking still applies (bm25/order), so more-
  relevant entries surface first even with OR.
- This fixes kb_session_prime multi-symbol primes AND the P4b neighbor batch
  (yashr-5n2, yashr-17i). Keep include_stale/l1_only filters intact.
- ALL implicit-AND SITES (plan review, MEDIUM -- fix every one via one shared
  helper): (1) SqliteProvider.prime searchTerms.join(' ') at
  sqlite-provider.ts:536; (2) the P4b neighbor batch .join(' ') at
  kb-session-prime.ts:141; (3) the additional term-join at kb-session-prime.ts:83
  flagged in review. makeFtsQuery (audn.ts:20) is only used by
  findAudnCandidates -- decide whether the shared OR-join helper also replaces it
  or leave the AUDN dedup query as-is (state the choice; dedup semantics differ
  from retrieval, so leaving AUDN's join alone is acceptable if justified).
- Tests: a two-term query where no single entry contains both terms returns the
  entries containing either (today: returns nothing); single-term unchanged.

## D5 -- Provenance enums stamped by the tool layer

- types.ts: define `Author` and `CaptureSource` string-literal union types.
  Author = 'doer' | 'reviewer' | 'planner' | 'plan-reviewer' | 'kb-agent' | 'pm'
  | 'user'. CaptureSource = 'session' | 'review' | 'harvest' | 'promotion' |
  'user-directive' | 'unknown'.
- The tool layer (kb-capture / kb-promote handlers) stamps these; the caller may
  pass a role hint but it is validated against the enum and defaulted to 'unknown'
  if invalid -- never a free string. Existing rows keep their historical values
  (no migration).
- Tests: capture with a valid role stamps it; an invalid/absent value -> 'unknown'
  / correct default.

## D6 -- user-directive entry type (highest trust)

- Add 'user-directive' to the entry type union (types.ts). Semantics: captured at
  an authoritative tier -- treat as CONFIRMED-equivalent for retrieval, EXEMPT
  from the D1 clamp, NEVER auto-decayed by decayConceptEntries, and only
  superseded by another user-directive (agent captures cannot supersede a
  user-directive).
- Capture path: kb_capture with type='user-directive' (author='user',
  source='user-directive'). Document in tpl-kb-agent.md and the PM skill WHEN to
  record one: when the user gives a standing instruction/correction during a
  sprint ("always do X", "never do Y", "we decided Z").
- Tests: a user-directive is retrievable at top rank, survives decay, and an
  agent capture with contradicting content does NOT supersede it (only flags).

## D7 -- Fix kb_harvest provenance (CORRECTED -- harvest is auto-wired, not dead)

CORRECTION (plan review, verified): kb_harvest is NOT vestigial. It is
auto-dispatched by src/tools/execute-prompt.ts (lines ~323-330) on every
successful execute_prompt, with the session transcript passed in;
tests/knowledge/kb-harvest-autowire.test.ts asserts this wiring. The 14
kb_agent_harvest-sourced entries in the apra-fleet KB came from this path. So
harvest DOES produce entries -- via the autowire, which has the transcript the
agent itself lacks.

Revised decision: do NOT rip harvest out. Instead:
- Keep the autowire. Harvested entries MUST be low-trust: force confidence
  UNVERIFIED (they are regex-extracted, unreviewed) -- this is consistent with
  the D1 gate (harvest can never mint CONFIRMED). Confirm kb-harvest.ts already
  captures at UNVERIFIED (it does, per audit) and that the D1 clamp covers it.
- Canonicalize harvest provenance under D5: author='kb-agent' is wrong for the
  autowire; stamp author='kb-agent' only for real KB-Agent captures. Harvested
  entries get source='harvest' and a distinct author (e.g. 'harvest') so the two
  paths are distinguishable in queries.
- Do NOT strip harvest from templates blindly: the KB-Agent direct-capture flow
  and the execute_prompt autowire are DIFFERENT paths. Keep the autowire; only
  remove any redundant "call kb_harvest yourself at session end" instruction from
  tpl-doer.md if present (the agent calling it manually with no transcript is the
  useless path; the autowire is the useful one). Update docs to describe harvest
  accurately (autowired, UNVERIFIED, regex-extracted) rather than calling it dead.
- Tests: kb-harvest-autowire.test.ts must still pass; add/adjust a test asserting
  harvested entries are UNVERIFIED and carry source='harvest'. Do not break the
  autowire.

## D8 -- kb_list + canonical git bible

- New tool kb_list: input { confidence?, type?, module?, symbol?, limit? } ->
  matching entries (id, type, confidence, title, summary, symbols, source_files).
  Read-only, routed through the KB service (providers.project). Register in
  src/index.ts with a clear description. Schema in the kb-*.ts style.
- Canonical export: a function (invoked by the KB Agent after promotion, or a
  small exported helper kb_export) writes CONFIRMED entries for the repo to
  <repo>/.fleet/kb-canonical.json (stable field set: id, type, title, summary,
  symbols, source_files, confidence, updated_at). The PM commits this file.
- Seed on cold KB: kb_session_prime, when the local KB returns few/no top_entries,
  reads <repo>/.fleet/kb-canonical.json (if present) and merges its entries into
  the primed set (marked via:"canonical-bible"), below live-KB hits. Non-fatal.
- Tests: kb_list filters; export writes the expected JSON shape; prime seeds from
  a fixture canonical file when the KB is cold and skips gracefully when absent.

## Phasing (risk order)

- Phase 1 (P0, trust core, riskiest): F1 gate, F2 supersede+contradiction. These
  touch capture/promote/audn/provider -- the integrity core. Front-load.
- Phase 2 (P1): F3 auto-staleness, F4 FTS OR-join, F5 provenance enums.
- Phase 3 (P2): F6 user-directive, F7 retire harvest, F8 kb_list + canonical bible.

F4 (OR-join in audn.ts makeFtsQuery) and F2 (audn.ts contradiction logic) both
touch audn.ts -- sequence them so the second rebases cleanly on the first, or
note the shared file so the doer edits both coherently. F8's prime-seed and F3's
prime-staleness both touch kb-session-prime.ts -- same caution.
