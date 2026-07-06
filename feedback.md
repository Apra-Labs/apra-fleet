# Plan Re-Review -- KB Integrity Sprint (PLAN.md @ b8013d4, design.md @ b97ee58)

Reviewer: pm-plan-reviewer. Second pass. Scope: verify each of the prior 1
HIGH / 4 MEDIUM / 1 LOW findings is resolved by the revised PLAN.md and the
revised design.md (D2 candidate-discovery, D3 content-hash scope, D4 fourth
FTS site, D7 harvest-is-autowired), re-checked against unchanged source.

## Verdict: APPROVED

All six findings from the first pass are resolved, correctly and at the right
altitude. The revised design.md now carries the fixes as binding decisions
(not just plan text), so the tasks and the decisions agree. The planner's one
flagged deviation (adding 'harvest' to the Author enum) is reasonable and
required by revised D7. The expanded shared-file sequencing on
sqlite-provider.ts is coherent. One LOW documentation nit remains (below); it
does not block execution because task order is unambiguous.

## Finding-by-finding resolution

### 1. HIGH (harvest autowired) -- RESOLVED

Revised D7 and T3.2 correct the false premise. T3.2 ("Keep kb_harvest
autowired; make it honest and low-trust") explicitly: leaves
src/tools/execute-prompt.ts lines ~323-330 untouched (VERIFY, do NOT remove),
keeps tests/knowledge/kb-harvest-autowire.test.ts green (the plan names the
exact wiring strings the test greps for and forbids touching them), removes
ONLY the redundant "call kb_harvest yourself at session end" manual
instruction from tpl-doer.md, and adds a behavioral test asserting harvested
entries are UNVERIFIED + source='harvest'. The autowire is preserved and the
autowire test cannot break. Confirmed against source: execute-prompt.ts still
fire-and-forgets kbHarvest with session_transcript; kb-harvest.ts line 114
already captures UNVERIFIED, so the D1 clamp trivially holds. Resolved.

### 2. MEDIUM (type filter blocks cross-type contradiction) -- RESOLVED

T1.4 is now two coupled halves. HALF B removes `AND e.type = ?` from
findAudnCandidates (sqlite-provider.ts ~line 242) so symbol-overlap candidates
of ANY type are discovered; HALF A re-imposes `candidate.type === input.type`
inside makeAudnDecision for the dedup ('none') and update paths, leaving ONLY
the contradiction path cross-type. This is coherent against source:
makeAudnDecision today has no type check, so adding the same-type gate to
dedup/update exactly preserves T1.3's same-type supersede behavior while the
widened discovery makes the cross-type contradiction reachable. A cross-type
candidate with symbol overlap but no contradiction signal correctly falls
through to `continue` (fails the dedup/update type gate, fails the
contradiction-signal gate) -- no false update across types. Resolved.

### 3. MEDIUM (fourth implicit-AND site) -- RESOLVED

Revised D4 and T2.1 enumerate all four sites: (1) makeFtsQuery (audn.ts:20),
(2) prime() searchTerms.join(' ') (sqlite-provider.ts:536), (3) neighbor
batch .join(' ') (kb-session-prime.ts:141), (4) the global-append query
(kb-session-prime.ts:83, `session_files?.join(' ') ?? hint_symbols?.join(' ')`
-- confirmed at source, and its raw-file-path FTS hostility is called out). One
exported helper orJoinFtsTerms fixes all four. The choice to also OR-join
makeFtsQuery (D4 left this optional) is stated with rationale (it is what makes
the F2 e2e candidate discoverable) and is safe: dedup/update stay gated on
symbol overlap + same type, so broader FTS candidates do not create false
merges. Resolved.

### 4. MEDIUM (F3 near-no-op) -- RESOLVED

Revised D3 and T2.2 abandon the content_hash approach (correctly -- confirmed
at source: content_hash is set only for context-cache at kb-capture.ts:37-43,
and prime() excludes context-cache at sqlite-provider.ts:542, so it would
no-op). The rewrite adds an additive `source_file_hashes` column (JSON
file->hash map) populated in SqliteProvider.capture() for ALL types via
computeFileHashBatch (the single choke point every capture path hits), then a
prime-time checkFreshness keyed off source_files + the stored basis. This makes
staleness fire on learning/knowledge entries -- which DO carry source_files and
appear in top_entries -- so the audit finding ("0 entries stale") is genuinely
addressed. No migration (existing rows default '{}' -> treated fresh), bounded
to the primed set, non-fatal try/catch. Resolved.

### 5. MEDIUM (e2e contradiction proof) -- RESOLVED

The capture()-level proof is moved to T2.1 and correctly sequenced AFTER both
prerequisites: T1.4's cross-type findAudnCandidates (HALF B) and T2.1's own
OR-join of makeFtsQuery. Traced against source: for entry B ("code_graph now
works / fixed via cypher CALLS", type 'learning'), findAudnCandidates builds
makeFtsQuery(B.title) OR-joined, so entry A ("code_graph is broken", type
'knowledge') matches on the shared 'code_graph' token and is returned (type
filter now gone); makeAudnDecision sees symbol overlap + a contradiction
keyword ('now works'/'fixed', which T1.4 adds) and returns 'flagged' with
contradiction_of = A.id, regardless of type or file overlap. The pair is
deliberately CROSS-TYPE (knowledge vs learning) to prove HALF B. Passable as
sequenced. Resolved.

### 6. LOW (harvest free-string author) -- RESOLVED

Folded into T2.3: 'harvest' added to the Author union; kb-harvest.ts literals
changed author 'kb-harvest' -> 'harvest' and source 'kb_agent_harvest' ->
'harvest' (correctly done in T2.3 rather than T3.2 because the CaptureSource
union change would otherwise break kb-harvest.ts compilation). A test asserts
author='harvest' + source='harvest'. Resolved.

## Deviation sanity-check (Author enum += 'harvest')

Acceptable. D5's literal list omits 'harvest', but revised D7 explicitly
requires a distinct harvest author to distinguish the autowire path from real
KB-Agent captures ("Harvested entries get source='harvest' and a distinct
author (e.g. 'harvest')"). The two revised decisions are now internally
consistent, and T2.3 records the deviation in progress.json notes as required.
Reasonable.

## Shared-file sequencing coherence

sqlite-provider.ts (T1.3 -> T1.4 -> T2.1 -> T2.2 -> T3.1): coherent. Each task
edits a distinct method -- T1.3 evaluateAudn ('update' branch), T1.4
findAudnCandidates, T2.1 prime() searchTerms line, T2.2 capture() + insertEntry
+ init() ALTER + a new checkFreshness call in prime(), T3.1 decayConceptEntries.
The only intra-file overlap is prime(), touched by T2.1 (searchTerms ~536) and
T2.2 (checkFreshness call after top_entries is built, ~547) in different
regions; the plan flags this and forbids restructuring T2.1's join. capture()
itself is edited only by T2.2 (T1.3/T1.4 edit the helper methods capture()
calls, not its body). Sequencing is clean.

Other shared files verified coherent: audn.ts (T1.4 then T2.1, disjoint
functions), kb-capture.ts (T1.1 -> T2.3 -> T3.1), types.ts (T2.3 -> T3.1),
kb-session-prime.ts (T2.1 -> T3.5), kb-harvest.ts (T2.3 literals -> T3.2
comments/docs, disjoint).

## Remaining nit

### LOW -- audn.ts sequencing bullet omits T3.1's makeAudnDecision edit

The shared-file sequencing bullet (PLAN.md line 49) lists audn.ts as edited by
T1.4 (makeAudnDecision) and T2.1 (makeFtsQuery) only, but T3.1 (line 406) also
edits makeAudnDecision for the user-directive supersede guard. So
makeAudnDecision is touched by both T1.4 and T3.1. This is NOT a hazard: T3.1
is Phase 3 (strictly after T1.4 and T2.1), executes last, and its own file
list correctly names audn.ts. It is a documentation-completeness nit only --
the binding order is unambiguous. Optional to note in the sequencing bullet;
does not require a re-plan.

## Checklist confirmation

- Coverage F1-F8: intact; fail-then-pass mandated for T1.1 (gate), T1.3
  (supersede stale), T1.4 (contradiction, pure), T2.1 (OR-join + F2 cross-type
  contradiction at capture()) [OK].
- Design compliance D1-D8: all satisfied, including the three revised decisions
  (D2 candidate discovery, D3 source_file_hashes basis, D4 four sites, D7
  autowired harvest) [OK].
- Models: 12 work tasks (3 opus, 8 sonnet, 1 haiku) each carry an exact model;
  3 VERIFY tasks modelless with build + test (2-timezone-failure allowance,
  yashr-302) + gitnexus analyze + mandatory `git checkout -- AGENTS.md
  CLAUDE.md` (runbook 3fa771af) + ASCII sweep + feature-branch push [OK].
- Repo rules: ASCII-only, NEVER push main, NO PR -- stated sprint-wide and in
  every VERIFY [OK].

## Summary

APPROVED. All 1 HIGH + 4 MEDIUM + 1 LOW findings resolved; the fixes are now
binding in design.md; the Author-enum deviation is justified and recorded; the
five-task sqlite-provider.ts sequence is coherent. One LOW documentation nit
(audn.ts bullet) is optional and non-blocking. Ready to execute.
