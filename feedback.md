# Phase 1 Review -- KB Integrity Sprint (trust core: F1, F2)

Reviewer: pm-reviewer. Scope: Phase 1 commits c30a7e9 (T1.1 gate clamp),
c40708b (T1.2 docs), 1f4929e (T1.3 supersede), e8a2f35 (T1.4 contradiction +
cross-type discovery). Binding: design.md D1, D2 (as revised in b97ee58),
requirements F1/F2, PLAN.md T1.1-T1.5. Verified against source + a full
build/test run.

## Verdict: APPROVED

All four work tasks implement their binding decisions correctly and at the
right altitude. Build is clean (tsc). Test suite: 1784 passed, 14 skipped,
only the 2 pre-existing yashr-302 timezone failures in tests/time-utils.test.ts
(explicitly allowed) fail -- NO regressions, and specifically none in the
capture/prime/query/audn suites. The KEY regression risk (stale=1-on-supersede
leaking into other retrieval paths) was traced end-to-end and is clean. Three
LOW / informational findings below; none blocks Phase 2.

## Checklist confirmation

### 1. T1.1 gate (D1) -- CONFORMS

- Clamp is enforced server-side in the kbCapture handler
  (src/tools/kb-capture.ts:60-72), not merely in the zod schema. CONFIRMED ->
  INFERRED; UNVERIFIED and INFERRED pass through untouched.
- Caller is informed: result carries `confidence_clamped: true` and a bracketed
  note "[confidence clamped: CONFIRMED requires kb_promote]" is appended to
  content (string concatenation, not a template literal -- ASCII-hook safe).
- kb_promote is untouched (diff does not modify promote()); it remains the sole
  CONFIRMED path. The ladder test (UNVERIFIED -> INFERRED -> CONFIRMED via two
  promote() calls) passes.
- D6 user-directive exemption present as a forward-compat raw-string check
  (`(input.type as string) === 'user-directive'`) with a TODO(T3.1) comment --
  compiles today, full typing deferred to T3.1 as planned.
- No row migration; a code comment states enforcement is forward-only and
  existing direct-CONFIRMED rows are historical.
- Tool description updated in src/index.ts:357 (ASCII clean).
- Fail-then-pass genuinely fails on old code: the test asserts
  `out.confidence_clamped === true` and `entry.confidence === 'INFERRED'`; old
  kbCapture returned only `{id, audn_decision}` (confidence_clamped undefined)
  and stored CONFIRMED verbatim -- both assertions fail pre-T1.1. Verified by
  code inspection of the diff.

Note (LOW, finding 2): the clamp lives at the tool-handler layer, so a direct
`provider.capture({confidence:'CONFIRMED'})` is NOT clamped -- see below.

### 2. T1.3 supersede (D2) -- CONFORMS; KEY REGRESSION RISK CLEARED

- The 'update' branch (sqlite-provider.ts:283) now sets BOTH `superseded_at =
  now` AND `stale = 1` on the old entry; content_hash is left intact. The
  flagged/none branches are untouched (T1.4 owns the contradiction path).
- Fail-then-pass (kb-supersede.test.ts) asserts the old row has superseded_at
  truthy AND stale === true; the stale assertion fails on old code. Sound.

STALE=1-ON-SUPERSEDE DID NOT BREAK ANY OTHER RETRIEVAL PATH. Traced every
reader of the entries table:
- prime() (SqliteProvider, line 545-550) calls query() with
  `include_stale: false` and default `include_superseded` (false), so the
  superseded row was ALREADY excluded via `superseded_at IS NULL` before T1.3.
  Adding stale=1 is redundant-but-consistent -- no behavior change.
- query() default path (lines 370-375) excludes both superseded and stale --
  fine.
- query() `flagged_only` path (kb-query.ts:29-30) uses `include_stale: true` +
  `include_superseded: false`; flagged entries are marked flagged_for_review
  (T1.4), NOT superseded, so they still surface. Unaffected.
- query() regular path (kb-query.ts:58-59) ties include_superseded to the same
  flag as include_stale, so there is no "superseded-true, stale-false" combo.
- getLinked() (line 516) and context() (lines 435, 490) filter
  `superseded_at IS NULL` directly -- a superseded row was already invisible;
  the stale flag changes nothing.
- kb-session-prime.ts wrapper (lines 90, 148) uses include_stale:false + default
  superseded exclusion -- unaffected.
- No kb_list yet (T3.3, Phase 3) -- it must be built to exclude stale/superseded
  by default, which the plan already specifies.

The ONLY behavioral consequence: a caller that wants to SEE a superseded row
must now also pass `include_stale: true`. The sole such caller in the tree was
the existing kb-capture.test.ts 'update' assertion, which the doer correctly
updated (added include_stale:true, plus a new stale===true assertion). No
product code path reads superseded-without-stale. Confirmed clean.

### 3. T1.4 contradiction (D2) -- CONFORMS

- makeAudnDecision (audn.ts): the CONTRADICTION path flags on symbolsOverlap +
  contradiction-signal, checked BEFORE the type/file gates -- so it fires
  regardless of file overlap AND regardless of type. Signal =
  hasContradictionKeywords(newContent) OR hasOppositePolarity(inputText,
  candidateText). Flagged result correctly sets shouldFlagExisting, new-entry
  confidence UNVERIFIED, and contradiction_of = candidate.id.
- DEDUP/UPDATE re-impose `candidate.type === input.type` then require file
  overlap -- so same-type refinements still merge and only the contradiction
  path is cross-type. A cross-type symbol-overlap candidate with no signal
  correctly falls through to `continue` (add), and a cross-type same-file no-
  signal pair yields null (no update) -- both covered by dedicated tests.
- findAudnCandidates (sqlite-provider.ts:240-248) dropped `AND e.type = ?`; FTS
  MATCH + `superseded_at IS NULL` + LIMIT 10 structure intact; a comment states
  dedup/update remain same-type via the makeAudnDecision gate. Coherent.
- Pure test uses the exact code_graph shape from D2/PLAN (candidate symbols
  [GitNexusProvider.graph, callGitNexus], "code_graph is broken", vs input
  "code_graph now works / fixed via cypher CALLS", no shared file) and expects
  flagged + contradiction_of. Meaningful and matches the live-KB pair the sprint
  targets. Fail-then-pass holds (old AND-logic returned null -> add).

### 4. Build + tests -- PASS

- `npm run build` (tsc): clean.
- `npm test`: 1784 passed / 14 skipped; the only 2 failures are the pre-existing
  yashr-302 timezone tests in tests/time-utils.test.ts (allowed). No capture,
  prime, query, supersede, or audn test regressed by the stale=1 change.

### 5. ASCII + docs -- PASS

- All Phase-1-changed files are ASCII clean (docs/kb-trust-model.md,
  tpl-kb-agent.md, kb-capture.ts, audn.ts, sqlite-provider.ts, and the new
  tests). The changed src/index.ts line (357) is ASCII clean.
- docs/kb-trust-model.md and tpl-kb-agent.md accurately describe the ENFORCED
  behavior: cap at INFERRED, server-side clamp, confidence_clamped flag +
  bracketed note, kb_promote as sole CONFIRMED mint, forward-only no-migration,
  D6 user-directive as the Phase-3 exception, harvest UNVERIFIED. The decision
  table was reworked to Capture-at / Then columns matching the clamp. Correct.

## Findings

### LOW 1 -- hasOppositePolarity uses naive substring matching (over-eager antonym risk)

audn.ts POLARITY lists match via `String.includes` on short tokens including
'fixed', 'broken', and 'resolved'. These collide with superstrings: 'prefixed'
and 'suffixed' contain 'fixed'; 'unresolved' contains 'resolved' (and would be
read as POSITIVE polarity despite being negative in meaning). A symbol-
overlapping entry pair where one side mentions e.g. "prefixed" and the other
"broken" could be flagged as a contradiction. Impact is bounded: it requires
symbol overlap AND opposite-polarity text between the two entries, and the
consequence is a review flag (new entry -> UNVERIFIED, old -> flagged_for_review)
-- not data loss or supersession. D2 asked for a conservative matcher; this is
mostly conservative but the substring approach on 'fixed'/'resolved' is a real
false-positive vector. Recommend word-boundary matching (or dropping the bare
'fixed'/'resolved' tokens in favor of the phrase forms already present) in a
follow-up. Non-blocking.

### LOW 2 -- clamp is tool-handler-layer, not provider.capture (per plan; noted)

The D1 clamp is in the kbCapture handler (src/tools/kb-capture.ts), so a direct
`provider.capture({confidence:'CONFIRMED'})` is not clamped. This matches the
plan's explicit direction (T1.1: "in the kbCapture handler") and the audit
threat model (every MCP caller routes through kbCapture; kb_promote is the
separate CONFIRMED mint; harvest already captures UNVERIFIED). It is sufficient
for the stated threat. Flagged only so future maintainers know provider.capture
remains the raw, unguarded path -- if an internal code path ever needs to mint
via capture(), it will bypass the gate. No action required for this sprint.

### INFO 3 -- pre-existing non-ASCII in src/index.ts (out of scope)

src/index.ts carries em-dashes/arrows on lines 28, 137, 186, 210, 273, 274, 307
-- all pre-existing, none touched by Phase 1, and outside the no-migration
scope. The Phase-1-changed line (357) is clean. Not a Phase 1 defect; noted for
awareness only.

## Summary

APPROVED. Findings: 0 HIGH, 0 MEDIUM, 2 LOW (+1 INFO). The trust core is real
and enforced in code: the CONFIRMED gate clamps server-side and informs the
caller, supersede marks superseded_at + stale=1, and contradiction flagging is
loosened to symbol-overlap + signal across files and types with cross-type
candidate discovery. Build clean; suite green modulo the allowed timezone
failures. Critically, the stale=1-on-supersede change broke NO other retrieval
path -- prime/query/getLinked/context/kb-session-prime all either already
excluded superseded rows via `superseded_at IS NULL` or tie include_superseded
to include_stale, and the one test that inspected a superseded row was correctly
updated. Ready for Phase 2.
