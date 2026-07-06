# Phase 3 + Sprint-Final Review -- KB Integrity Sprint (F6, F7, F8)

Reviewer: pm-reviewer. Scope: Phase 3 commits 3638932 (T3.1 user-directive),
9aaf027 (T3.2 harvest honest+low-trust), 412e6b7 (T3.3 kb_list), 72271be (T3.4
kb_export), f26ec1d (T3.5 cold-seed), plus a sprint-wide done-criteria check
(F1-F8, all three phases). Binding: design.md D6/D7/D8 (revised in b97ee58),
requirements F6/F7/F8, PLAN.md T3.1-T3.6 + sprint done-criteria. Phases 1 and 2
were APPROVED (d399bce, 42dac48). Verified against source, a clean tsc build,
and a full test run (1848 passed; only the 2 allowed yashr-302 timezone
failures).

## Verdict: APPROVED

All five Phase 3 work tasks implement their revised binding decisions correctly
and at the right altitude, and every sprint-wide done criterion is met. Build
clean (tsc). Full suite: 1848 passed, 14 skipped, ONLY the 2 pre-existing
yashr-302 timezone failures in tests/time-utils.test.ts (explicitly allowed) --
no regressions. ASCII sweep of the sprint's own added lines
(c30a7e9~1..HEAD) is byte-clean. No PR was opened by this sprint; main is
untouched (main == origin/main == 5526fe7).

Findings: 0 HIGH, 1 MEDIUM, 1 LOW (carry-forward) + 1 INFO. The MEDIUM is the
F6 trust question (below) -- it is a DESIGN-LEVEL gap that the T3.1
implementation faithfully inherits from D6/F6 as written, not an implementation
defect, so it does not block the sprint. It is flagged for a follow-up design
decision.

## Checklist confirmation

### 1. T3.1 user-directive (D6) -- CONFORMS (with MEDIUM 1, the F6 trust gap)

- 'user-directive' added to the ContentType union (types.ts) with a doc comment
  covering all four D6 semantics.
- Clamp exemption is TIGHT and correct (kb-capture.ts:84-95). The branch is
  `if (isUserDirective) { confidence = 'CONFIRMED'; } else if
  (requestedConfidence === 'CONFIRMED') { confidence = 'INFERRED';
  confidence_clamped = true; ... }`. ONLY type==='user-directive' bypasses the
  clamp; a normal knowledge/learning capture with confidence:'CONFIRMED' still
  downgrades to INFERRED, sets confidence_clamped, and appends the bracketed
  note. Verified the mutual exclusivity: the CONFIRMED branch is in the `else
  if`, so it cannot fire for a user-directive. The T1.1 raw-string TODO guard
  is now replaced by the typed-union check as PLAN specified.
- Provenance stamped server-side: a user-directive is stamped author='user',
  source='user-directive' (kb-capture.ts:103-108); the caller's role hint is
  ignored for directives. Non-directives keep the T2.3 validated-role behavior.
- decayConceptEntries guarded (sqlite-provider.ts:391-401): `AND type !=
  'user-directive'` added to the UPDATE WHERE, with a comment stating it is
  defensive belt-and-braces (decay only touches INFERRED; a directive is
  CONFIRMED, so it never matched anyway). Correct.
- makeAudnDecision supersede guard (audn.ts:140-150): `if (candidate.type ===
  'user-directive' && input.type !== 'user-directive') continue;` is placed
  AFTER the contradiction path and BEFORE the DEDUP/UPDATE same-type gate. So a
  differently-typed agent capture that contradicts a user-directive still gets
  'flagged' (contradiction path above), and otherwise falls through to 'add' --
  it can NEVER 'update'/supersede the directive. When both sides are
  user-directives the guard does not trip and normal same-type supersede
  applies. Correct per D6 semantic 3.
- Relies on T1.4 cross-type findAudnCandidates: confirmed. Because
  findAudnCandidates no longer filters by type (T1.4 HALF B), a user-directive
  candidate is actually discovered for a differently-typed agent capture, so the
  guard is reachable end-to-end. Without T1.4 the guard would be dead code; with
  it, the flag/add degradation is real.
- Retrieval: no extra ranking code; storing confidence='CONFIRMED' gives
  CONFIRMED-equivalent ranking (D6 semantic 4), documented in the type comment.
- Tests: kb-user-directive.test.ts (13 tests) proves clamp exemption stores
  CONFIRMED (contrasted against a normal knowledge CONFIRMED clamping to
  INFERRED), top-rank retrieval, decay survival + the defensive type-guard, the
  pure supersede guard (add/flagged/both-directive), and the e2e agent-cannot-
  supersede + second-directive-does-supersede. Full knowledge suite green.

### 2. T3.2 harvest honest + low-trust (revised D7) -- CONFORMS

- Autowire UNCHANGED and still fires: src/tools/execute-prompt.ts was NOT
  touched in Phase 3 (git log 42dac48..HEAD -- src/tools/execute-prompt.ts is
  empty). The fire-and-forget dispatch is intact at lines 323-329
  (`void import('./kb-harvest.js').then(... kbHarvest({ session_transcript:
  parsed.result, session_id: parsed.sessionId })) ... .catch(...)`). Nothing
  silently disabled it.
- kb-harvest-autowire.test.ts stays green (the wiring strings it greps are
  untouched).
- Harvested entries are UNVERIFIED + author='harvest' + source='harvest'
  (kb-harvest.ts:114,128-130). confidence:'UNVERIFIED' is hardcoded, so harvest
  can never mint CONFIRMED (it does not even route through the kb-capture
  handler clamp -- it calls provider.capture() directly with UNVERIFIED, which
  is strictly below CONFIRMED). Behavioral test added asserting all three.
- Only the redundant manual "call kb_harvest yourself at session end"
  instruction was removed (tpl-doer.md + the same anti-pattern in
  tpl-reviewer.md, doer-reviewer-loop.md, knowledge-agent.md). The autowire
  description is preserved; tpl-kb-agent.md keeps direct-capture as primary and
  adds one line clarifying the autowire is a separate low-trust transcript-fed
  path. docs/kb-trust-model.md already described harvest accurately. Docs are
  accurate (autowired, UNVERIFIED, regex-extracted -- not "dead").

### 3. T3.3 kb_list (D8) -- CONFORMS

- Read-only: SqliteProvider.list() (sqlite-provider.ts:720-760) is a pure
  SELECT. It does NOT bump use_count/last_accessed -- the doer chose a dedicated
  provider read method over a query() opt-out flag (stated in kb-list.ts and
  progress.json), precisely so the query() telemetry bump is not perturbed.
  Confirmed there is no UPDATE in the method.
- Filters: confidence/type/module are exact column filters; symbol uses
  `EXISTS (SELECT 1 FROM json_each(e.symbols) WHERE value = ?)` -- the same
  json_each technique context() uses. limit is optional (unbounded when
  omitted).
- Excludes superseded/stale by default with NO override: the WHERE always seeds
  `['e.superseded_at IS NULL', 'e.stale = 0']`. Deterministic ORDER BY e.id ASC.
- The tool returns the exact stable reduced field set {id, type, confidence,
  title, summary, symbols, source_files} + total. Registered in index.ts:364
  with the audit-oriented description. Filter/exclusion/no-bump behavior proven
  by kb-list.test.ts.

### 4. T3.4 kb_export (D8) -- CONFORMS

- Writes only live CONFIRMED via list({confidence:'CONFIRMED'}) -- which already
  excludes superseded + stale -- to <repo>/.fleet/kb-canonical.json. Stable
  field set {id, type, title, summary, symbols, source_files, confidence,
  updated_at}; updated_at = promoted_at || created_at (covers user-directive
  CONFIRMED-on-capture rows that have no promoted_at).
- Deterministic id order (list() orders by id ASC, and export re-sorts by id).
- ASCII-safe OUTPUT verified: asciiSafeStringify (kb-export.ts:41-57) walks each
  code unit and re-escapes anything > 127 as \uXXXX via charCodeAt/toString(16),
  building the "\u" prefix at runtime from String.fromCharCode(92) -- it avoids
  writing any literal unicode-escape or template literal into the source, per
  the doer's note that an earlier unicode-range regex got corrupted. The source
  file itself is ASCII (confirmed by the sprint sweep), and the escape logic
  guarantees the OUTPUT file is ASCII regardless of entry text. kb-export.test.ts
  proves byte-for-byte ASCII output with non-ASCII entry text.
- Validated repo path: repo_path optional, defaults to cwd, checked for
  existence + isDirectory() before writing; .fleet created if missing.
- No .fleet/kb-canonical.json exists in this repo -- correct; kb_export is a
  tool the KB Agent runs after promotion in a future sprint, not something this
  sprint's code auto-runs. Nothing to sweep there.

### 5. T3.5 cold-seed (D8) -- CONFORMS

- Appended as the LAST block in kb-session-prime.ts (after direct hits +
  global-append + graph-neighbor); the T2.1 global-append and neighbor blocks
  are untouched (diff shows only additions after line 236).
- COLD_KB_MAX=3 named const; triggers only when top_entries.length < 3 after all
  merges. Warm KB (>= 3 live hits) -> the block is skipped entirely, no merge.
- Entries merged marked via:'canonical-bible', appended BELOW all live hits
  (spread as `[...top_entries, ...additions]`), deduped by id against existing
  ids, capped at ADDED_ENTRY_CAP. hint_symbols/hint_modules matches ordered
  first.
- Non-fatal: entire block in try/catch; missing file, unreadable/malformed JSON,
  or a non-array top level all degrade to exactly today's output (same hard-skip
  contract as neighbor expansion). Individual malformed entries are dropped via
  isCanonicalBibleEntry, not the whole merge. All degrade paths + dedup + cap +
  hint reordering proven by the +10 tests (module-singleton pattern).
- Repo root derived from process.cwd() -- consistent with T3.4 kb_export's cwd
  basis. See LOW 2.

### 6. Sprint-wide done criteria -- PASS

- `npm run build` (tsc): clean, no errors (ran it myself).
- `npm test` (ran it myself): 1848 passed, 14 skipped, 2 failed -- and the 2
  failures are EXACTLY the pre-existing yashr-302 timezone tests in
  tests/time-utils.test.ts (toLocalISOString minutes/seconds), which are
  explicitly allowed. No other failure; no regression from any Phase 3 change.
- F1/F2/F4 fail-then-pass tests exist and are green: kb-capture-gate.test.ts
  (F1 clamp), kb-supersede.test.ts + audn.test.ts (F2 supersede + contradiction
  flag), kb-fts-orjoin.test.ts (F4 OR-join + F2 cross-type e2e at capture()).
- ASCII sweep of the SPRINT's own added lines (git diff c30a7e9~1..HEAD, added
  lines only): ZERO non-ASCII bytes. The ~10 pre-existing findings a full
  main..HEAD diff surfaces (console.warn glyphs in src/cli/install.ts, arrow
  fixtures in code-intelligence tests) are from the earlier code-intelligence
  sprint already on this branch, are not touched by any kb-integrity task, and
  are correctly out of scope -- not faulted.

### 7. No PR opened by the sprint; main untouched -- CONFIRMED (with INFO 1)

- main == origin/main == 5526fe7 -- main is untouched; the 182 commits ahead are
  all on feat/code-intelligence-abstraction.
- The kb-integrity sprint opened NO PR (it honored the "user raises PRs"
  constraint). See INFO 1 re: the pre-existing PR #305.

## Findings

### MEDIUM 1 -- F6 TRUST GAP: any caller of kb_capture can forge a user-directive (self-elevate)

THIS IS THE ANSWER TO THE KEY F6 TRUST QUESTION.

YES -- an agent CAN forge a user-directive. `type: 'user-directive'` is a plain
member of the kbCaptureSchema zod enum (kb-capture.ts:23), assertable by ANY
caller of kb_capture. There is NO caller-identity / privileged-role gate. When a
caller passes type='user-directive', the handler unconditionally: (a) forces
confidence='CONFIRMED', bypassing the D1 clamp; (b) stamps author='user',
source='user-directive'; (c) the entry is then never auto-decayed and can never
be superseded by any agent capture. The role hint is ignored -- author is
hard-set to 'user' regardless of who called. So any doer/reviewer/kb-agent (or a
prompt-injected agent) can self-elevate to the HIGHEST trust tier -- effectively
above CONFIRMED -- simply by labeling a capture type='user-directive'.

This directly reopens a variant of the exact hole F1 was created to close ("the
gate is decorative -- kb_capture accepts CONFIRMED from any caller"). F1 now
blocks the front door (confidence=CONFIRMED clamps); F6 opens a side door that
is strictly more powerful (CONFIRMED + never-decayed + never-agent-supersedable),
with no gate at all.

IMPORTANT -- this is a DESIGN-level gap, not a T3.1 implementation defect. D6 and
F6 as written specify exactly this capture path ("kb_capture with
type='user-directive' ... author='user', source='user-directive'") with no
mention of a caller-identity check, and the fleet's MCP tool layer has no
per-call user-vs-agent identity signal to gate on. The implementation faithfully
matches the binding design, so it does not block the sprint. But the trust
implication is real and should be a follow-up design decision for the sprint
owner: e.g. gate type='user-directive' behind a validated privileged role
(role==='pm'/'user' hint required and stamped, else clamp like any other type),
or require the PM (not an arbitrary agent) to be the only caller that may set it,
or capture directives through a distinct PM-only path. Recommend a bead.

### LOW 1 -- hasOppositePolarity substring matching (carried forward from Phase 1/2)

Unchanged since Phase 2's LOW 1. audn.ts polarity matching uses String.includes
on short tokens ('fixed','resolved') that collide with superstrings
('prefixed','unresolved'). T3.1 did not touch polarity logic. Impact bounded: it
still requires symbol overlap AND opposite-polarity text, and the consequence is
a review flag, not data loss. Recommend word-boundary matching in a follow-up.
Non-blocking.

### LOW 2 -- cold-seed and kb_export both key repo root off process.cwd()

kb-session-prime.ts cold-seed and kb-export.ts (default) both derive the repo
root from process.cwd(). In the MCP server process, cwd may not be the project
repo, so the cold-seed could read the wrong .fleet/kb-canonical.json or none.
This is consistent between the two tools (kb_export writes where cold-seed
reads) and both are non-fatal (cold-seed hard-skips, kb_export takes an explicit
repo_path), so it does not break anything today. But a future multi-repo/daemon
deployment should thread an explicit validated repo path into the prime input
the way other prime paths validate session_files. Non-blocking.

### INFO 1 -- pre-existing open PR #305 now carries the kb-integrity commits

The sprint opened no PR. However a pre-existing PR #305
(feat/code-intelligence-abstraction -> main, created 2026-06-16, BEFORE this
sprint) tracks this branch, so the kb-integrity commits now ride inside that
open PR by virtue of sharing the branch. main is still untouched, and the sprint
itself did not raise a PR, so the "NO PR -- the user raises PRs" constraint was
honored. Flagging only so the user is aware that merging #305 would land
kb-integrity into main; the merge decision is the user's.

## Summary

APPROVED. Findings: 0 HIGH, 1 MEDIUM (F6 trust gap -- conforms to D6 as written,
recommended follow-up), 2 LOW (1 carry-forward, 1 cwd repo-root), 1 INFO. All
five Phase 3 tasks conform to their revised binding decisions; build clean; full
suite green modulo the 2 allowed timezone failures; sprint ASCII-clean on its
own added lines; main untouched; no PR opened by the sprint.

F6 TRUST ANSWER (verbatim for the caller): YES, an agent can forge a
user-directive. type='user-directive' is assertable by any caller of kb_capture
with no identity/role gate; doing so forces confidence=CONFIRMED (bypassing the
D1 clamp), stamps author='user'/source='user-directive', and yields an entry
that is never auto-decayed and never agent-supersedable. An agent can therefore
self-elevate to the highest trust tier. The implementation matches D6/F6 as
written (which specify no gate), so this is a design-level trust gap for
follow-up, not a T3.1 defect -- recorded as MEDIUM 1.
