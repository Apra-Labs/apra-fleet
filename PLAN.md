# PLAN -- KB Trust-Ops Sprint (epic yashr-bp2)

Branch: feat/code-intelligence-abstraction (base: main). All work lands on this
branch. NEVER push to main. NO PR -- the user raises PRs. Requirements:
requirements.md (F1-F11, phases P1/P2/P3). Binding decisions: design.md
(D1-D9). Risk-front-loaded: F1 (the directive trust gate, D1) leads Phase 1
on claude-opus-4-8.

## Planning context (KB coverage, D9 live trial)

D9 asks the planner to call kb_stats with the plan's key symbols and cite the
coverage number. kb_stats does not exist yet (F5 of THIS sprint builds it), so
per the D9 trial protocol this section records coverage qualitatively instead.

kb_session_prime returned session_warm but zero top_entries (the live MCP
server predates the OR-join retrieval fix; hyphenated FTS queries error with
"no such column"). Fallback per-topic kb_query with plain single-word terms
retrieved 11 live entries that replaced essentially all exploratory reads:

- cf0ce11e (CONFIRMED) "kb_capture confidence gate is enforced server-side"
  -> T1.1 (clamp location kb-capture.ts:50-73, exemption at lines 64/69).
- 61770438 (CONFIRMED) "user-directive: sole CONFIRMED clamp exemption" ->
  T1.1/T1.3 (exemption kb-capture.ts:84-95; decay guard
  sqlite-provider.ts:391-401 `AND type != 'user-directive'`; supersede guard
  audn.ts:140-150; 13 existing tests in tests/kb-user-directive.test.ts).
- 0b1678e7 (INFERRED) "TRUST GAP: user-directive forgeable (yashr-9ha)" ->
  F1 motivation and the exact attack path T1.3's fail-then-pass test encodes.
- 04e578fa (CONFIRMED) kb-integrity capstone -> whole-sprint map (promotion
  supersede semantics, cross-type contradiction, staleness, harvest tiers).
- 4cdf2a5d (CONFIRMED) "hasOppositePolarity substring false-positive" ->
  T1.5 (exact POLARITY_NEGATIVE/POSITIVE token lists, audn.ts:28-36,
  includes() sites at lines 31-34).
- 492cabfd (CONFIRMED) "Contradiction detection fires cross-type" -> T1.1
  guard placement (contradiction path before supersede guard; dedup/update
  re-impose same-type at audn.ts:106-119).
- b9df569a (CONFIRMED) "kb_export + cold-seed" -> T1.6/T3.3/T3.5 (export
  field set, asciiSafeStringify, COLD_KB_MAX=3, cold-seed hard-skip contract,
  the recorded LOW that both default repo root to process.cwd()).
- daf640f5 (CONFIRMED) "Provenance enums fixed via tool-layer validation" ->
  T1.1 (validateAuthor, kb-capture.ts:15-20; Author/CaptureSource unions
  types.ts:12-13) and T3.1 (role validation for feedback notes).
- 989d00c3 (INFERRED) module-singleton vitest pattern -> all test tasks.
- 4e11460c + 46e9af43 (CONFIRMED) degraded-safe fleet_status health pattern
  (codeIntelligenceHealth / codeIntelligenceCompactLine, computeTopSymbols
  triple-nested degradation) -> T2.2/T2.4.

Coverage judgment: the trust core (F1), polarity (F3), export/prime (F4, F9),
and status surfacing (F5-F7) are densely covered by CONFIRMED entries with
verified line numbers -> those tasks lean claude-sonnet-4-6. F1's redesign
REVERSES documented invariants (the KB describes the behavior being removed),
which is exactly where reasoning risk concentrates -> claude-opus-4-8 for the
trust-core tasks T1.1 and T1.3. No KB entries cover the new CLI human-terminal
surface or the flagged-pipeline e2e interplay; those get standard models with
extra-explicit descriptions below.

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
  resets." Use vi.hoisted() for mock fn refs declared before imports.
- No mass migration (sprint done criteria): existing KB rows (including any
  pre-existing directly-CONFIRMED user-directive rows) are historical data and
  MUST NOT be rewritten. Enforcement is forward-only and documented as such.
- Tests: npm test must stay green except the 2 pre-existing timezone failures
  in tests/time-utils.test.ts (beads yashr-302), which are allowed to fail.
- D5 constraint (verbatim intent): CI machines have no kb.sqlite, so bible
  drift is VISIBILITY where the KB lives (kb_stats / fleet_status), never a
  CI gate. No task may add a CI check that reads the KB.
- Deviations from design.md D1-D9 need a recorded reason in progress.json
  notes.

## Shared-file sequencing (from design.md Phasing -- binding)

- src/tools/kb-capture.ts: touched ONLY by T1.1 (F1 removes the exemption).
- src/services/knowledge/audn.ts: T1.1 (guard rekey, audn.ts:140-150) BEFORE
  T1.5 (polarity, audn.ts:28-36). Disjoint functions, but the order is fixed
  anyway: T1.1 -> T1.5.
- src/tools/kb-session-prime.ts (cold-seed lives here per current layout;
  design also names src/services/knowledge/kb-session-prime.ts -- doer uses
  whichever path holds the cold-seed block): T1.6 (F4 path robustness) BEFORE
  T3.5 (F9 global seed); T3.5 appends AFTER the existing cold-seed block.
- src/tools/kb-export.ts: T1.6 (F4) BEFORE T3.3 (F9 scope param).
- src/tools/check-status.ts: strictly sequenced T2.2 (F5/F6 surfacing) THEN
  T2.4 (F7 version warning). No parallel edits.
- src/index.ts (tool + CLI registration): touched by T1.2, T2.1, T3.1 --
  strictly in that order (phase order enforces this).

## Ambiguity resolutions (recorded)

1. Pending-proposal representation (D1 leaves the pick to the planner):
   REUSE existing columns -- confidence='UNVERIFIED' + flagged_for_review=1 +
   a 'directive:pending' entry in the existing tags array. No schema
   migration; kb_query/prime defaults already exclude flagged+UNVERIFIED
   entries, which D1 says to assert rather than re-filter.
2. Approval does NOT auto-supersede older active directives. D1's "only a
   user-approved directive supersedes it" is satisfied operationally: the
   human approves the new directive and explicitly runs reject-directive on
   the outdated one (rejection = superseded_at + stale audit trail). No new
   auto-supersede machinery.
3. Approval stamps promoted_at (activation is the promotion-equivalent
   event). Keeps kb_export's updated_at (promoted_at || created_at) and F5's
   promote_ratio coherent for directives.
4. CLI namespace: one `kb` subcommand group dispatched from src/index.ts,
   implemented in a new src/cli/kb-directives.ts (follows the src/cli/*.ts
   command-module pattern, e.g. install.ts).
5. F4 "everywhere feasible" scope: exactly the two cwd sites the design names
   (kb-export.ts default repo path, kb-session-prime cold-seed root) plus
   documenting the precedence. Other tools untouched.
6. F5 hit_rate denominator: entries_retrieved / total LIVE entries (stale and
   superseded excluded), per D4's "retrieved/total live".
7. F11 "flags clear appropriately": the e2e test asserts the ACTUAL behavior
   of kb_promote and supersede on flagged_for_review, and kb-review.md is
   corrected to match reality if its description differs (requirement text
   explicitly allows this documentation pass).

---

## Phase 1 -- Trust closure (P1: F1, F2, F3, F4)

### T1.1 -- F1 core: proposal-only capture + guard rekey (D1)

Model: claude-opus-4-8

The riskiest change of the sprint: it REVERSES the kb-integrity T3.1
invariants documented in the KB. Files: src/tools/kb-capture.ts,
src/services/knowledge/audn.ts, src/services/knowledge/sqlite-provider.ts,
src/services/knowledge/types.ts (only if a helper type is needed).

1. REMOVE the kb-capture clamp exemption (kb-capture.ts:84-95, condition
   `if (isUserDirective) { confidence = 'CONFIRMED'; }` checked before the
   clamp). After this change kb_capture(type='user-directive') stores a
   PROPOSAL: confidence='UNVERIFIED', flagged_for_review=1, tags gains
   'directive:pending' (ambiguity resolution 1). NO trust semantics attach
   while pending.
2. Provenance honesty (D1): STOP stamping author='user' on proposals
   (kb-capture.ts:103-108 currently forces author='user',
   source='user-directive'). Instead stamp the validated role hint via the
   existing validateAuthor (kb-capture.ts:15-20; invalid/absent -> 'unknown').
   Keep source='user-directive' (it describes the channel/type, not identity).
3. Provider activation primitives in sqlite-provider.ts (used by T1.2's CLI,
   NOT exposed over MCP): listDirectives() (pending + active, stable fields),
   approveDirective(id) (sets confidence='CONFIRMED', author='user',
   flagged_for_review=0, removes the 'directive:pending' tag, stamps
   promoted_at -- resolution 3), rejectDirective(id) (superseded_at=now,
   stale=1, keep the tag for audit; never delete), and
   addDirective(text, symbols?) (creates an already-active directive:
   CONFIRMED, author='user', source='user-directive', promoted_at=now).
4. Rekey the guards to ACTIVE directives (type='user-directive' AND
   confidence='CONFIRMED'), per D1:
   - makeAudnDecision supersede guard (audn.ts:140-150, currently
     `candidate.type === 'user-directive' && input.type !== 'user-directive'`)
     must protect only ACTIVE directives. Additionally, because every MCP
     directive capture is now a proposal, a same-type directive capture must
     NEVER supersede an ACTIVE directive (the old both-directives-supersede
     path would let an agent proposal replace an active directive --
     re-opening yashr-9ha). Proposals land as 'add' (or 'flagged' via the
     cross-type contradiction path, which stays untouched and ahead of the
     guard, per KB 492cabfd).
   - decayConceptEntries guard (sqlite-provider.ts:391-401,
     `AND type != 'user-directive'`) becomes
     `AND NOT (type='user-directive' AND confidence='CONFIRMED')` so pending
     proposals decay like any UNVERIFIED entry while active directives never
     decay.
5. Retrieval: do NOT add new filters. Pending proposals are UNVERIFIED +
   flagged so prime/query defaults already exclude them; T1.3 asserts this.
6. Forward-only: no migration of existing rows; add a short comment at the
   removed-exemption site referencing D1 and yashr-9ha.

New/updated unit tests in this task (activation-flow tests come in T1.3):
proposal stored UNVERIFIED+flagged+tagged; role hint stamped (and 'unknown'
fallback); approveDirective/rejectDirective/addDirective state transitions;
supersede guard protects active, not pending; proposal cannot supersede an
active directive; decay touches pending but never active. Use the
module-singleton vitest pattern (verbatim constraint above) where module
state is involved.

Done criteria:
- kb_capture(type='user-directive') can no longer mint CONFIRMED under any
  input combination; the clamp applies to it like any other type.
- Provider primitives exist with the exact state transitions above and are
  not reachable through any MCP tool.
- Both guards key off type+CONFIRMED; an agent directive proposal can neither
  supersede nor outrank an active directive.
- All listed unit tests green; build clean; ASCII only.

### T1.2 -- F1 CLI: human-terminal activation surface (D1)

Model: claude-sonnet-4-6

First human-terminal CLI surface for the KB. Files: new
src/cli/kb-directives.ts + dispatch wiring in src/index.ts (follow the
existing src/cli/install.ts command-module pattern). Depends on T1.1's
provider primitives.

Commands (exact names from D1):
- `apra-fleet kb directives` -- lists pending proposals and active
  directives (id, title/text, proposer author, created_at, status). Plain
  ASCII table or line output.
- `apra-fleet kb approve-directive <id>` -- calls approveDirective; prints
  the activated entry; non-zero exit + clear message when id is missing,
  already active, or rejected.
- `apra-fleet kb reject-directive <id>` -- calls rejectDirective; same error
  discipline.
- `apra-fleet kb add-directive "<text>" [--symbols a,b,c]` -- calls
  addDirective (human terminal = trust root, D1: already-active).

The commands open the SAME project KB (scope resolution consistent with the
MCP server's provider construction) so an approval is visible to the running
server without restart (same sqlite file). Never expose these over MCP.
Trust rationale comment at top of kb-directives.ts: MCP has no user-vs-agent
identity; the human terminal is the only unforgeable channel (D1).

Tests: CLI handler functions invoked directly (not via child_process):
list/approve/reject/add against a temp KB, error paths (unknown id, double
approve), symbols parsing. Watch the ASCII pre-commit hook gotcha when
building CLI output strings with \n -- use string concatenation (verbatim
constraint above).

Done criteria: all four commands work end-to-end against a real temp sqlite
KB; helpful usage text on bad args; wired into the main CLI dispatch without
disturbing existing commands; tests green; ASCII only.

### T1.3 -- F1 proof: fail-then-pass test + directive test rewrite (D1)

Model: claude-opus-4-8

Files: tests/kb-user-directive.test.ts (rewrite of the 13 kb-integrity tests)
plus a new e2e-style test file (e.g. tests/kb-directive-gate.test.ts).
Depends on T1.1 + T1.2.

1. MANDATED fail-then-pass test (sprint done criteria): an agent capture via
   the kb_capture tool handler with type='user-directive' and any
   confidence/role input is NOT an active directive: (a) not CONFIRMED,
   (b) absent from kb_query and kb_session_prime DEFAULT results (flagged +
   UNVERIFIED exclusion asserted, no new filters), (c) NOT protected by the
   supersede guard, (d) NOT exempt from decay. THEN the same entry after
   approveDirective (invoked as the CLI does) IS active: CONFIRMED,
   author='user', top-tier retrieval, never decayed, never
   agent-supersedable. This test encodes the yashr-9ha attack (KB 0b1678e7:
   forge type='user-directive' -> self-elevate) and proves it closed.
2. Rewrite existing kb-user-directive tests through activation: every test
   that previously relied on capture-time CONFIRMED (clamp exemption,
   top-rank retrieval, decay survival, supersede guard, second-directive
   supersede) now creates its directive via proposal + approveDirective (or
   addDirective where the scenario is a human-created directive). The
   both-directives-supersede scenario is updated to the new rule from T1.1:
   proposals never supersede active directives; supersession of an old
   directive is the human approve-new + reject-old flow (resolution 2) --
   test exactly that flow.
3. Keep D6-semantics coverage complete for ACTIVE directives: never decayed,
   only-user supersede, top-tier retrieval, CONFIRMED-equivalent rank.

Use the module-singleton vitest pattern (verbatim constraint above).

Done criteria: fail-then-pass test exists and passes with assertions on BOTH
sides of activation; all rewritten directive tests green; no test creates an
active directive without going through approveDirective/addDirective; full
suite green (timezone exception only).

### T1.4 -- F2: auto-capture standing instructions (docs on top of D1/D2)

Model: claude-haiku-4-5

Documentation/template task, no server code (D2). Files: skills/pm/SKILL.md,
skills/pm/tpl-kb-agent.md (and the sprint docs section of SKILL.md if it has
one).

- SKILL.md gains a short "standing instructions" section: when the user
  issues a standing instruction ("always do X", "never do Y", "we decided
  Z"), the PM immediately proposes a directive via
  kb_capture(type='user-directive') -- safe now because it is proposal-only
  (D1) -- then tells the user it is PENDING and surfaces the exact command:
  `apra-fleet kb approve-directive <id>`.
- tpl-kb-agent.md: the KB Agent may likewise propose directives it detects
  in the session record; same pending flow, same user-facing instruction.
- Also note in kb-review.md (one line): /pm kb-review surfaces pending
  directive proposals and instructs the human to run the CLI (requirement
  F1 bullet 2).
- Keep wording tight (D2): the TRUST boundary is the CLI, not the detection.

Done criteria: all three files updated, ASCII only, wording states pending +
exact CLI command; no server code touched.

### T1.5 -- F3: polarity word-boundary matching (D3)

Model: claude-sonnet-4-6

File: src/services/knowledge/audn.ts, hasOppositePolarity (lines 28-36; the
four String.includes sites at lines 31-34 per KB 4cdf2a5d). MUST land after
T1.1 (same file, disjoint functions -- guard rekey is at lines 140-150).

- Keep POLARITY_NEGATIVE / POLARITY_POSITIVE lists unchanged (multi-word
  phrases like 'does not work', 'no longer works', plus bare 'fixed',
  'broken', 'resolved'). Only tighten matching: word-boundary semantics
  (regex \b with escaped phrase, or tokenize on non-word chars) instead of
  substring includes. Case-insensitive (current behavior lowercases -- keep
  equivalent). Apostrophes in "doesn't exist/work" must keep matching --
  test this explicitly since \b interacts with the apostrophe.
- Fail-then-pass discipline: write the false-positive tests FIRST and watch
  them fail on the includes() implementation, then apply the fix.

Tests (tests for audn or a dedicated polarity block): 'prefixed',
'unresolved', 'suffixed' no longer signal polarity; genuine 'fixed' vs
'broken' pair still flags; "doesn't work" vs "now works" still flags;
case-insensitive checks. Contradiction e2e behavior (flag decision) still
covered by existing audn tests.

Done criteria: the three false-positive words no longer produce polarity
signals (proven fail-then-pass); all genuine pairs still signal; existing
contradiction tests green.

### T1.6 -- F4: explicit validated repo path for export + cold-seed

Model: claude-sonnet-4-6

Files: src/tools/kb-export.ts, src/tools/kb-session-prime.ts (cold-seed
block). KB b9df569a records the LOW: both derive repo root from
process.cwd() fallbacks. MUST land before T3.3/T3.5 (same files).

- kb_export: repo path becomes an explicit validated input everywhere
  feasible; keep the existing existence + isDirectory validation; when no
  explicit path is given, follow the documented precedence: explicit input >
  validated session context (whatever validated repo/root the session or
  server context already carries) > skip with a clear error (export) --
  never silently write relative to an arbitrary cwd.
- kb_session_prime cold-seed: same precedence; the terminal fallback is the
  existing non-fatal hard-skip (prime must never fail because the repo root
  could not be validated).
- Document the precedence in a comment at both sites AND in the tool
  descriptions. NO behavior change when a valid path is provided (existing
  tests must stay green unmodified where they pass explicit paths).

Tests: explicit-path unchanged behavior; invalid path -> export clear error /
cold-seed hard-skip; precedence order exercised.

Done criteria: no code path in these two files trusts bare process.cwd()
without validation; precedence documented; existing export/prime tests green.

### T1.7 -- VERIFY Phase 1

Type: verify (no model)

1. npm run build -- must be clean.
2. npm test -- green except the 2 pre-existing timezone failures in
   tests/time-utils.test.ts (yashr-302).
3. npx gitnexus analyze (non-fatal if it fails), then IMMEDIATELY
   `git checkout -- AGENTS.md CLAUDE.md` (mandatory, verbatim gotcha above).
4. Push the branch (feat/code-intelligence-abstraction). NEVER push main.
   NO PR.

---

## Phase 2 -- Ops and measurement (P2: F5, F6, F7)

### T2.1 -- F5: kb_stats tool + provider stats read (D4, drift per D5)

Model: claude-sonnet-4-6

Files: new src/tools/kb-stats.ts, SqliteProvider.stats() in
src/services/knowledge/sqlite-provider.ts, registration in src/index.ts,
HttpKbProvider stats handling.

- Dedicated read following the kb_list pattern (KB: kb_list is a no-bump
  provider read): stats NEVER bumps use_count or last_accessed.
- Input { repo?, symbols?: string[] }. Output sections (all cheap single
  queries, D4):
  - totals: GROUP BY confidence and by type;
  - stale count, flagged count, superseded count;
  - retrieval: { entries_retrieved (use_count>0), total_uses (SUM(use_count)),
    hit_rate = entries_retrieved / total LIVE entries (resolution 6) };
  - promote_ratio: promoted_at IS NOT NULL / CONFIRMED count;
  - bible: { present, entries, drift } where drift = count of live CONFIRMED
    entries whose updated_at (promoted_at || created_at, matching kb_export)
    is newer than the newest updated_at inside .fleet/kb-canonical.json;
    file absent -> present=false and drift = ALL live CONFIRMED (D5). Repo
    path for the bible file follows T1.6's precedence.
  - coverage: when symbols[] given, per-symbol boolean (EXISTS a live
    CONFIRMED entry whose symbols array contains the symbol, EXACT match)
    plus the overall fraction.
- D5 constraint stated in the tool description: drift is VISIBILITY for the
  machine that owns the KB; CI cannot see the KB and no CI gate exists.
- HttpKbProvider: implement stats() or return a documented not-supported
  result -- NEVER throw (D4).

Tests for EVERY section (empty KB, mixed-confidence fixture, bible absent /
present-with-drift / present-current, coverage exact-match vs substring
near-miss, no use_count bump after stats).

Done criteria: kb_stats registered and returning all sections; zero telemetry
side effects proven by a test; bible drift math matches D5 exactly; http
provider never throws.

### T2.2 -- F5/F6: fleet_status KB health + bible drift surfacing

Model: claude-sonnet-4-6

File: src/tools/check-status.ts. Strictly BEFORE T2.4 (shared file). Depends
on T2.1.

- Add a compact code-KB health line + JSON key to fleetStatus() following the
  degraded-safe precedent (KB 4e11460c: codeIntelligenceHealth /
  codeIntelligenceCompactLine wrap ALL I/O in try/catch, return null on any
  failure, never throw, never block status). Reuse kb_stats/provider stats
  internals for the numbers (totals, stale/flagged, retrieval hit_rate,
  promote_ratio).
- Bible drift line (D5, F6): when drift N > 0 render exactly the actionable
  form: "bible: N promotions behind (run kb_export, commit
  .fleet/kb-canonical.json)". Present in JSON too.
- Degraded-safe: ANY error -> omit the KB section entirely; fleet_status
  never fails because of the KB (D4/D5).

Tests: healthy KB renders line; drift>0 renders the exact actionable wording;
provider error/missing KB -> section omitted, status still succeeds; JSON
shape.

Done criteria: compact + JSON output both carry KB health and drift;
try/catch omission proven by a fault-injection test; no change to existing
status sections.

### T2.3 -- F6 docs: export-then-commit checklist tightening

Model: claude-haiku-4-5

Files: skills/pm/tpl-kb-agent.md, skills/pm/SKILL.md (PM completion flow).

- tpl-kb-agent.md already says export-after-promote; tighten to an explicit
  numbered CHECKLIST item (promote -> kb_export -> commit
  .fleet/kb-canonical.json) and add the drift line to the KB Agent report
  template so the PM sees "bible: N promotions behind" each phase (D5).
- PM completion flow in SKILL.md: same checklist item wording.
- State the D5 constraint in one sentence where the checklist lives: CI
  cannot see the KB; keeping the bible current is an in-repo discipline, not
  a CI gate.

Done criteria: both files updated with checklist-style wording + drift line
in the report template; ASCII only; no code changes.

### T2.4 -- F7: server version handshake (D6)

Model: claude-sonnet-4-6

Files: src/tools/check-status.ts (AFTER T2.2 lands -- shared file), plus a
small helper (either in check-status.ts or a new src/services/version-check.ts),
using src/version.ts serverVersion.

- Compare the compiled-in serverVersion against the on-disk version of the
  code the server was launched from: read version.json/package.json relative
  to the dist entry actually resolved at runtime (findProjectRoot pattern
  from src/cli/install.ts:88-95). SEA binaries embed assets -- read via the
  existing manifest path in that case (D6).
- Mismatch -> fleet_status compact warning line + JSON field, exact spirit:
  "server running vX, disk has vY -- restart your MCP client".
- Degraded-safe: if the disk read fails for ANY reason, omit silently; this
  check NEVER fails or delays fleet_status. No auto-restart (D6: surface
  only).

Tests: match -> no warning; mismatch -> warning with both versions; unreadable
disk version -> omitted, status succeeds; JSON field shape.

Done criteria: warning appears only on true mismatch; all failure paths
omit; T2.2's sections untouched; build + tests green.

### T2.5 -- VERIFY Phase 2

Type: verify (no model)

1. npm run build -- clean.
2. npm test -- green except the 2 timezone failures (tests/time-utils.test.ts,
   yashr-302).
3. npx gitnexus analyze (non-fatal), then IMMEDIATELY
   `git checkout -- AGENTS.md CLAUDE.md` (mandatory).
4. Push the branch. NEVER push main. NO PR.

---

## Phase 3 -- Reach (P3: F8, F9, F10, F11)

### T3.1 -- F8: kb_feedback downvote tool (D7)

Model: claude-sonnet-4-6

Files: new src/tools/kb-feedback.ts, provider support in
sqlite-provider.ts, registration in src/index.ts.

- Input { id, reason, role? }. Effect: stale=1, flagged_for_review=1, append
  ASCII note "[feedback <ISO>] <validated-role>: <reason>" to content,
  respecting CONTENT_CAP. Role validated via the provenance enums
  (validateAuthor pattern, KB daf640f5); invalid/absent -> 'unknown'.
- NEVER deletes. NEVER touches confidence: a downvoted CONFIRMED entry stays
  CONFIRMED-but-stale-flagged; the human resolves it in kb-review -- STATE
  THIS in the tool description (D7).
- user-directive EXCEPTION (D7, verbatim rule): feedback flags directives
  for review but must NOT stale them (directives outrank agent experience;
  the human decides) -- flag only. With T1.1 landed, key this off ACTIVE
  directives (type + CONFIRMED); a pending proposal may be staled like any
  entry.
- ASCII hook gotcha applies to the note formatting -- string concatenation,
  not template literals with \n.

Tests: normal entry -> stale+flagged+note appended (cap respected);
confidence untouched; active directive -> flagged only, stale unchanged;
pending directive proposal -> staled normally; invalid role -> 'unknown' in
note; unknown id error.

Done criteria: tool registered; all effects and the directive exception
proven by tests; description carries the never-deletes/never-demotes wording.

### T3.2 -- F8 docs: feedback one-liners in doer/reviewer templates

Model: claude-haiku-4-5

Files: skills/pm/tpl-doer.md, skills/pm/tpl-reviewer.md, and the doer +
reviewer dispatch blocks inside skills/pm/doer-reviewer-loop.md.

One line each (D7): "if a KB entry you retrieved proves wrong in practice,
call kb_feedback with the entry id and what was wrong." /pm kb-review already
picks up flagged entries -- no change there.

Done criteria: all four locations carry the line; ASCII only; no other
template edits.

### T3.3 -- F9a: kb_export global scope (D8)

Model: claude-sonnet-4-6

File: src/tools/kb-export.ts (AFTER T1.6 -- shared file).

- Input gains scope: 'project' (default, behavior unchanged) | 'global'.
- Global export reads the GLOBAL KB (scope='global' provider / the global
  kb.sqlite at ~/.apra-fleet/data/knowledge/global/) and writes
  .fleet/kb-canonical-global.json in the given repo path (in practice the
  apra-fleet platform repo, committed there). Same stable field set
  {id, type, title, summary, symbols, source_files, confidence, updated_at}
  and the same asciiSafeStringify + deterministic id-sorted output as the
  project export (KB b9df569a).
- Repo path follows T1.6 precedence.

Tests: global export shape (fixture global KB), default scope untouched,
empty global KB -> valid empty array file, ASCII-safe output byte check.

Done criteria: scope param works; project default byte-identical behavior;
global file lands at .fleet/kb-canonical-global.json with the stable shape.

### T3.4 -- F9b: installer copies the committed global bible (D8)

Model: claude-sonnet-4-6

File: src/cli/install.ts.

- New install step: when the repo being installed from contains a committed
  .fleet/kb-canonical-global.json, copy it to
  ~/.apra-fleet/data/knowledge/global/kb-canonical-global.json so EVERY
  project on the machine can see it without carrying it in-repo (D8).
- NON-FATAL: absent file -> skip silently; unreadable/copy failure -> warn
  and continue; the installer must never fail because of the bible. Create
  the target directory if missing.
- Follow the existing install-step logging/ordering conventions in
  runInstall (src/cli/install.ts:434-851).

Tests: file present -> copied (content equality); absent -> install path
unaffected; target dir auto-created; copy failure does not throw out of the
step.

Done criteria: the D8 installer-copy step exists, is non-fatal on every
failure path, and is covered by tests.

### T3.5 -- F9c: cold-seed merges the installed global bible (D8)

Model: claude-sonnet-4-6

File: src/tools/kb-session-prime.ts, cold-seed block (AFTER T1.6 -- shared
file; F9 APPENDS AFTER the existing cold-seed block per the design Phasing
note).

- After the project-bible merge inside the cold path (top_entries <
  COLD_KB_MAX=3), also merge entries from the INSTALLED global bible at
  ~/.apra-fleet/data/knowledge/global/kb-canonical-global.json (homedir, NOT
  the repo), marked via:'canonical-bible-global', ordered BELOW
  project-bible entries, same dedupe-by-id, same ADDED_ENTRY_CAP, same
  shared COLD_KB_MAX threshold, and the same hard-skip non-fatal contract
  (missing/unreadable/malformed JSON/non-array -> exactly today's output;
  KB b9df569a documents that contract in detail).
- Warm KB (>= 3 live hits) still skips both bible merges entirely.

Tests: prime seeds from a global fixture when cold; ordering live >
project-bible > global-bible; absent/malformed global file degrades to
current behavior; warm session unaffected; dedupe across project and global
bibles. Use the module-singleton vitest pattern where needed.

Done criteria: global seed works below project seed with the via marker;
every degrade path proven; no change to warm-session output.

### T3.6 -- F10: quantitative model assignment in planner templates (D9)

Model: claude-haiku-4-5

Files: skills/pm/doer-reviewer-loop.md (planner dispatch block),
skills/pm/tpl-planner.md. TEMPLATE TEXT ONLY (D9: no code changes).

- After kb_session_prime, the planner calls kb_stats with the plan's key
  symbols and uses coverage: >= 0.8 -> lean cheap/standard models for tasks
  on those symbols; < 0.3 -> premium + front-load the risk; between ->
  judgment. PLAN.md's model rationale MUST cite the coverage number.
- Mention the fallback this very plan exercised: if kb_stats is unavailable,
  record coverage qualitatively in a Planning context section.

Done criteria: both templates carry the numbered thresholds and the citation
requirement; ASCII only.

### T3.7 -- F11: flagged-pipeline e2e proof

Model: claude-sonnet-4-6

Files: new e2e test (e.g. tests/kb-flagged-pipeline.test.ts), possible
documentation pass on skills/pm/kb-review.md. Depends on T3.1 (kb_feedback).

End-to-end against a real temp sqlite KB, exercising the kb-review flow that
has never met a real flagged pair:
1. Capture entry A, then capture contradicting entry B (symbol overlap +
   polarity/keyword signal, e.g. 'X is broken' vs 'X is fixed' -- word
   boundaries now per T1.5) -> assert flagged decision, contradiction_of
   link, flagged_for_review on the right entry.
2. kb_feedback a third entry -> flagged via the downvote path.
3. kb_query({flagged_only:true}) sees BOTH flagged items with full content.
4. Resolve one via kb_promote + supersede (promote the correct entry of the
   contradiction pair; the loser gets superseded_at + stale per kb-integrity
   promote-then-supersede semantics).
5. Verify the flags clear appropriately: assert the ACTUAL post-resolution
   flag state (resolution 7) -- superseded/stale entries drop from
   flagged_only surfacing or their flags are cleared, whichever the code
   really does -- and fix skills/pm/kb-review.md if its described flow does
   not match the asserted reality.

Done criteria: the e2e test covers all five stages and is green; kb-review.md
matches observed behavior; any code-vs-docs mismatch is resolved in favor of
documented-reality (doc change), never silent.

### T3.8 -- VERIFY Phase 3 (final)

Type: verify (no model)

1. npm run build -- clean.
2. npm test -- green except the 2 timezone failures (tests/time-utils.test.ts,
   yashr-302).
3. npx gitnexus analyze (non-fatal), then IMMEDIATELY
   `git checkout -- AGENTS.md CLAUDE.md` (mandatory).
4. ASCII sweep over the sprint's OWN added lines: check every added line in
   `git diff main...HEAD` for non-ASCII bytes (e.g. added-lines filter piped
   through an ASCII check); any hit is a failure to fix before push.
5. Confirm F1's fail-then-pass test exists and passes: the test asserting an
   agent-captured type='user-directive' entry is NOT an active directive
   until CLI activation (T1.3). Name/locate it explicitly in the VERIFY
   notes.
6. Push the branch. NEVER push main. NO PR.

---

## Task summary

| Task | Feature | Model | Files (primary) |
|------|---------|-------|-----------------|
| T1.1 | F1/D1 core | claude-opus-4-8 | kb-capture.ts, audn.ts, sqlite-provider.ts |
| T1.2 | F1/D1 CLI | claude-sonnet-4-6 | src/cli/kb-directives.ts, src/index.ts |
| T1.3 | F1/D1 tests | claude-opus-4-8 | tests/kb-user-directive.test.ts, tests/kb-directive-gate.test.ts |
| T1.4 | F2/D2 docs | claude-haiku-4-5 | SKILL.md, tpl-kb-agent.md, kb-review.md |
| T1.5 | F3/D3 | claude-sonnet-4-6 | audn.ts (after T1.1) |
| T1.6 | F4 | claude-sonnet-4-6 | kb-export.ts, kb-session-prime.ts |
| T1.7 | VERIFY | -- | -- |
| T2.1 | F5/D4+D5 | claude-sonnet-4-6 | kb-stats.ts, sqlite-provider.ts, index.ts |
| T2.2 | F5+F6 surface | claude-sonnet-4-6 | check-status.ts (before T2.4) |
| T2.3 | F6 docs | claude-haiku-4-5 | tpl-kb-agent.md, SKILL.md |
| T2.4 | F7/D6 | claude-sonnet-4-6 | check-status.ts (after T2.2), version.ts read |
| T2.5 | VERIFY | -- | -- |
| T3.1 | F8/D7 | claude-sonnet-4-6 | kb-feedback.ts, sqlite-provider.ts, index.ts |
| T3.2 | F8 docs | claude-haiku-4-5 | tpl-doer.md, tpl-reviewer.md, doer-reviewer-loop.md |
| T3.3 | F9a/D8 | claude-sonnet-4-6 | kb-export.ts (after T1.6) |
| T3.4 | F9b/D8 | claude-sonnet-4-6 | src/cli/install.ts |
| T3.5 | F9c/D8 | claude-sonnet-4-6 | kb-session-prime.ts (after T1.6) |
| T3.6 | F10/D9 | claude-haiku-4-5 | doer-reviewer-loop.md, tpl-planner.md |
| T3.7 | F11 | claude-sonnet-4-6 | tests/kb-flagged-pipeline.test.ts, kb-review.md |
| T3.8 | VERIFY (final) | -- | -- |

17 work tasks (2 opus, 11 sonnet, 4 haiku) + 3 VERIFY checkpoints.
