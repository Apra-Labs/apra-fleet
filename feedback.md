# Plan Review -- KB Trust-Ops Sprint (epic yashr-bp2)

Reviewer: pm-plan-reviewer. Target: PLAN.md at commit 38e2197, checked against
requirements.md (F1-F11), design.md (D1-D9), and current source on branch
feat/code-intelligence-abstraction. Every factual anchor (line references,
guard predicates, cwd sites, CLI dispatch, degraded-status pattern) was
verified against the working tree. The D1 proposal/activation split was
attack-checked against the live kb_promote, kb_query, kb_session_prime, and
kb-server implementations.

## VERDICT: CHANGES NEEDED

2 HIGH, 1 MEDIUM, 2 LOW. The plan is structurally excellent -- full F1-F11
coverage, correct shared-file sequencing, sane models, honest planning-context
section -- but the D1 gate as planned does NOT close yashr-9ha: kb_promote
remains an agent-callable activation path, and the pending representation's
retrieval-exclusion premise is factually wrong against current code.

## HIGH findings

### H1. kb_promote can ACTIVATE a pending directive proposal (yashr-9ha reopened)

SqliteProvider.promote() (src/services/knowledge/sqlite-provider.ts:762-798)
has NO type guard and climbs the ladder one step per call:
UNVERIFIED -> INFERRED -> CONFIRMED. kb_promote (src/tools/kb-promote.ts) is
agent-callable over MCP and passes straight through. Under the plan, a pending
proposal is UNVERIFIED + flagged + tagged 'directive:pending' with
type='user-directive'. Two kb_promote calls therefore mint
type='user-directive' AND confidence='CONFIRMED' -- which is EXACTLY the
rekeyed guard predicate T1.1 step 4 defines as an ACTIVE directive. The forged
entry then gets every D6 semantic: never decayed, agent-unsupersedable,
CONFIRMED-tier retrieval. Neither T1.1 nor any other task mentions kb_promote.

Aggravating factor: pending proposals carry flagged_for_review=1, so they
appear in kb_query(flagged_only:true), whose response note
(src/tools/kb-query.ts:49) explicitly instructs agents to resolve flagged
entries "by calling kb_promote (keep)". The plan's own T3.7 e2e exercises that
exact resolution flow. An agent following documented kb-review guidance would
activate a forged directive semi-legitimately.

Required change:
- T1.1 must add a promote() gate: promote refuses (or caps below CONFIRMED)
  any entry with type='user-directive' (or carrying the 'directive:pending'
  tag), with an error directing to the CLI approve path. Activation must be
  reachable ONLY via approveDirective/addDirective (CLI).
- T1.3's fail-then-pass test must include the promote-ladder attack: call
  kb_promote twice on a pending proposal and assert it is still not ACTIVE.
- The flagged_only resolution note (kb-query.ts) must carve out
  directive-pending entries (resolve via `apra-fleet kb approve-directive` /
  `reject-directive`, never kb_promote).

### H2. Pending proposals are NOT excluded from retrieval defaults; the plan's premise is false and breaks its own mandated test

Ambiguity resolution 1 and T1.1 step 5 assert "kb_query/prime defaults already
exclude flagged+UNVERIFIED entries" and forbid adding filters. This is
factually wrong against current code: SqliteProvider.query()
(sqlite-provider.ts:478-490) filters ONLY superseded_at and stale by default;
there is no flagged_for_review filter and no confidence filter. prime()
delegates to query() (sqlite-provider.ts:657-662) and the kb_query tool layer
(src/tools/kb-query.ts:53-60) adds nothing. A pending proposal (stale=0,
superseded_at NULL) WILL surface in kb_query and kb_session_prime defaults via
any FTS match. Design D1 carries the same wrong premise, but the plan is the
executable artifact: T1.3's MANDATED fail-then-pass assertion (b) -- "absent
from kb_query and kb_session_prime DEFAULT results" -- will fail, while T1.1
step 5 forbids the doer from adding the filter that would fix it. The doer is
stranded in a contradiction on the sprint's headline test.

Required change: T1.1 must add an explicit default exclusion for pending
directive proposals (e.g. exclude entries tagged 'directive:pending', or
flagged+UNVERIFIED user-directive rows, from query()/prime() defaults --
flagged_only listing must still surface them), record the deviation from D1's
"assert rather than filter" wording in progress.json notes per the plan's own
deviation rule, and keep T1.3's assertion (b) as written so it proves the
exclusion.

## MEDIUM findings

### M1. Global-scope directive proposals are unlistable and unapprovable

kb_capture routes scope='global' (non-context-cache) entries to the GLOBAL KB
(src/tools/kb-capture.ts:61-63), so kb_capture(type='user-directive',
scope='global') stores a pending proposal in ~/.apra-fleet/data/knowledge/
global/kb.sqlite. T1.2's CLI opens "the SAME project KB" only -- a global
proposal can never be listed, approved, or rejected (dead-end audit trail),
and the guard rekey must also hold in the global provider. Pin the scope
story in T1.1/T1.2: either force type='user-directive' captures to project
scope (documented), or make `apra-fleet kb directives`/approve/reject operate
on both scopes. Add a test either way.

## LOW findings

### L1. kb_capture schema description still advertises the removed exemption

kb-capture.ts:24 describes user-directive as "highest trust: stored CONFIRMED,
exempt from the clamp". T1.1 removes the behavior but does not list updating
the tool description (or the role param text). Post-F1 the description would
actively mislead agents about proposal-only semantics. Add the description
update to T1.1's file list and done criteria.

### L2. T1.1 decay wording is off (UNVERIFIED entries do not decay)

decayConceptEntries only demotes INFERRED -> UNVERIFIED
(sqlite-provider.ts:397-406). A pending proposal stored UNVERIFIED never
"decays like any UNVERIFIED entry" -- it is already at the floor. The proposed
SQL rekey (`AND NOT (type='user-directive' AND confidence='CONFIRMED')`) is
correct and still needed (a proposal promoted once to INFERRED -- if H1's gate
allows a single step -- or any future INFERRED proposal must decay), but
T1.1's test bullet "decay touches pending" should be restated as: an INFERRED
user-directive row decays; a CONFIRMED one never does. Cosmetic; fix wording
so the doer does not chase an unobservable assertion.

## Checklist results (what passed)

1. Coverage: F1 (T1.1-T1.3), F2 (T1.4), F3 (T1.5), F4 (T1.6), F5 (T2.1/T2.2),
   F6 (T2.2/T2.3), F7 (T2.4), F8 (T3.1/T3.2), F9 (T3.3-T3.5), F10 (T3.6),
   F11 (T3.7). Done criteria are precise and testable throughout. F1
   fail-then-pass mandated in T1.3 and re-checked in T3.8 step 5; F3
   fail-then-pass discipline explicit in T1.5; F11 e2e present (T3.7, all five
   stages).
2. D1 attack-check: capture path closed (clamp applies); kb_feedback cannot
   touch confidence (D7); export/seed round-trip cannot mint an active
   directive -- the cold-seed (kb-session-prime.ts:248-287) merges bible
   entries into prime OUTPUT only, never the DB, and the kb-server HTTP layer
   (src/commands/kb-server.ts) uses explicit routes, so T1.1's provider
   primitives are not auto-exposed. kb_promote is the one open door (H1);
   retrieval-default exclusion premise is wrong (H2). Planner resolution 2
   (proposal never supersedes an active directive) IS implemented (T1.1 step
   4) and tested (T1.1 test list + T1.3 step 2) -- pass.
3. Factual anchors: all verified accurate. kb-capture exemption 84-95,
   validateAuthor 15-20, author='user' stamp 103-108; audn hasOppositePolarity
   28-36 with includes() at 31-34, supersede guard predicate at line 151
   (plan cites the 140-150 comment block -- close enough); decay guard
   sqlite-provider.ts:391-405 with the exact `AND type != 'user-directive'`
   clause; the two cwd sites (kb-export.ts:60, kb-session-prime.ts:250);
   check-status degraded pattern (codeIntelligenceHealth:312,
   codeIntelligenceCompactLine:372); CLI kb dispatch already in src/index.ts
   (lines 98-119, existing `kb invalidate` -- T1.2's "without disturbing
   existing commands" covers it); install.ts findProjectRoot:89,
   runInstall:435.
4. Shared-file orderings all present and coherent: kb-capture (T1.1 only),
   audn (T1.1 -> T1.5), kb-session-prime (T1.6 -> T3.5, append-after),
   kb-export (T1.6 -> T3.3), check-status (T2.2 -> T2.4), index.ts
   (T1.2 -> T2.1 -> T3.1 by phase order).
5. D5 respected: drift is visibility only, "no task may add a CI check that
   reads the KB" is a sprint-wide constraint and restated in T2.1/T2.3. D8
   installer copy step present (T3.4, non-fatal on every path). D6
   degraded-safe (T2.4: omit silently on any disk-read failure).
6. Models sane: F1 core (T1.1) and test rewrite (T1.3) on claude-opus-4-8,
   docs on haiku, rest sonnet -- matches the KB-coverage rationale. All three
   VERIFY tasks carry the analyze-then-checkout gotcha verbatim and the
   never-main/no-PR rule; ASCII constraints (including the template-literal
   hook gotcha) are sprint-wide.
7. Ambiguity resolutions (7 recorded): all reasonable except resolution 1's
   false retrieval premise (H2). Resolution 3 (promoted_at on approval) was
   specifically checked against every promoted_at reader: kb-export
   updated_at (kb-export.ts:78 -- intended, keeps drift math coherent), decay
   guard (sqlite-provider.ts:405 -- irrelevant at CONFIRMED), promote()
   itself (no-ops on CONFIRMED, returns unchanged) -- no bad interaction.
   Resolution 6 matches D4; resolution 7 is the right call for F11.

## Notes (no action required)

- An agent with file-write access can inject CONFIRMED-labeled entries into
  cold-session prime output by writing .fleet/kb-canonical.json (bible
  entries carry no directive semantics and never enter the DB). Pre-existing
  D8-accepted exposure, out of scope for this sprint; the committed-and-
  reviewed nature of the bible is the control.
- After H1's gate, decide whether promote() refuses user-directive rows
  entirely or allows UNVERIFIED -> INFERRED only; refusing entirely is
  simpler and keeps the pending state binary (recommended).
