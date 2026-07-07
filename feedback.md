# Review -- In-Flight KB Capture (epic yashr-auh, lightweight sprint)

Reviewer: pm-reviewer. Branch feat/code-intelligence-abstraction (base main).
Commits reviewed: 2133888 (T1 tag filter), 8f3bb66 (T2 template policy flip),
3b1c9b1 (T3 KB Agent curator). Prior sprint's verdict (KB Trust-Ops, epic
yashr-bp2 -- APPROVED) is preserved in this file's git history, per the same
convention that sprint used for its own earlier phases.

## VERDICT: CHANGES NEEDED

1 HIGH, 1 MEDIUM, 2 LOW. The requirement (capture learnings at discovery time,
KB Agent becomes curator) is well-designed and the trust clamp keeps it safe --
but the sprint's centerpiece step, the KB Agent gathering the phase's in-flight
captures by tag, cannot execute as documented: it issues a `kb_query` call the
tool layer rejects at runtime. T1 wired the `tag` param through the schema,
provider, and the flagged_only branch, but did not relax the main-path guard
that the T3 curation step depends on. Everything else conforms. Build clean;
full suite 1987 passed / 6 failed with the 6 EXACTLY the allowed set (2
time-utils yashr-302 + 4 kb-session-prime graph-neighbor yashr-bwc, confirmed by
isolated re-run); ASCII sweep of all added lines clean; main untouched.

## TRUST RE-CHECK -- does in-flight capture open a hole? Answer: NO to the gate; YES to bounded noise growth.

The CONFIRMED trust gate is NOT breached by letting planner/doer/reviewer
capture freely:

- CLAMP HOLDS. `kb_capture` caps every capture at INFERRED server-side
  (confidence_clamped:true); CONFIRMED is minted ONLY by `kb_promote`. No agent
  role template calls kb_promote -- tpl-doer/tpl-reviewer/tpl-planner instruct
  kb_capture only, and tpl-reviewer's closing line was narrowed to "You do not
  call kb_promote". So no in-flight capture can self-mint CONFIRMED.
- PROMOTION STILL GATED. Only the KB Agent promotes, and Step 3 promotes an
  in-flight entry ONLY when the reviewer verdict is APPROVED and the entry
  describes behavior the approved code has -- capture-then-promote exactly as
  before, the only change being who captured first. Unvalidated entries are left
  at INFERRED; verdict-invalidated entries are kb_feedback-flagged (stale +
  flagged), never deleted. All confirmed against the preserved Confidence
  Decision table (tpl-kb-agent.md:103-119).
- DIRECTIVES STILL CLI-ONLY. No new template invites type='user-directive'
  capture; the new instructions all say type knowledge/learning. Even if an
  agent captured a directive, kb_capture clamps it to UNVERIFIED + directive:pending
  (proposal only), default retrieval excludes it (sqlite-provider.ts:535), and
  kb_promote refuses user-directive entries. Activation remains human-CLI-only.
- FLOOD MITIGATED. Dedupe-first (kb_query before every capture), the
  durable+non-obvious/no-task-logs quality bar, and the curator's flag/leave/promote
  triage all bound low-quality growth.

HONEST RESIDUAL RISK (MEDIUM-1 below): valid-but-unvalidated in-flight captures
persist at INFERRED (Step 3's "left Z" bucket), and the retrieval-first rule
tells future agents to TRUST INFERRED entries and skip the source read. So the
population of retrieval-trusted INFERRED entries now grows with un-curated,
agent-authored content -- an unvalidated INFERRED capture can later be trusted
by another agent without source verification. This does not elevate anything to
CONFIRMED (the gate holds), but it is a real knowledge-quality/noise
amplification the pre-change flow did not have. Mitigated, not eliminated.

## T1 -- tag filter (2133888) -- CONFORMS (code), but see HIGH-1 for the tool guard gap

- WHERE clause, exact match via json_each, ANDed with existing filters: CONFIRMED.
  SqliteProvider.query() pushes `EXISTS (SELECT 1 FROM json_each(e.tags) WHERE
  value = ?)` into `conditions` (sqlite-provider.ts:515-523), the same array
  consumed by BOTH the FTS branch (`ftsWhere`, line 544) and the plain-listing
  branch (`where`, line 538/556). Same pattern as list()'s symbol filter
  (line 791-794). FTS MATCH string and the OR-join are untouched -- tag is not
  an FTS term.
- Applied in BOTH branches of query(): CONFIRMED (see above). Notably the plain
  branch (line 553 `else`) runs when there is NO query, so the PROVIDER supports
  a queryless tag-only filter -- it is the TOOL that blocks it (HIGH-1).
- No-tag behavior unchanged: CONFIRMED, proven by the "no tag -> unchanged" tests
  in both kb-list.test.ts and kb-query.test.ts (provider + tool layers).
- No use_count regression in list(): CONFIRMED. list() has no use_count/last_accessed
  UPDATE (kb-list.ts's audit-view choice is preserved); only query() bumps telemetry,
  unchanged by this diff.
- zod schemas + descriptions: CONFIRMED. kb-list.ts:16 and kb-query.ts:10 add the
  `tag` param with accurate descriptions; index.ts tool descriptions updated for
  both kb_query and kb_list.
- Tests meaningful: CONFIRMED. tag-only match, no-tag-unchanged, and composition
  (module AND tag; type AND tag) at both provider and tool layers, plus a tool
  test asserting the untagged entry is NOT returned. All pass.

## T2 -- capture-at-discovery-time policy flip (8f3bb66) -- CONFORMS

- All three role templates flipped: CONFIRMED. tpl-planner.md gains a "Capture at
  discovery time" section, tpl-doer.md and tpl-reviewer.md replace the retrieval-only
  wording with immediate-kb_capture instructions.
- All three dispatch blocks flipped consistently: CONFIRMED. doer-reviewer-loop.md
  planner block (role hint planner, line ~143), doer block (line ~189, role hint
  doer), and reviewer block (line ~220, role hint reviewer) all carry the flip.
- Quality rules retained: CONFIRMED. dedupe-with-kb_query-first, durable+non-obvious
  only, no task logs, one concern per entry, real symbols + source_files -- present
  in every flipped surface.
- Tagging convention ['sprint:<name>','phase:<n>'] with placeholders in dispatch
  blocks: CONFIRMED (doer-reviewer-loop.md:146,198,229; tpl-* use
  ['sprint:<sprint-name>','phase:<n>']). See LOW-2 on concrete substitution.
- Retrieval-first rules untouched: CONFIRMED (kb_query-before-unfamiliar-read,
  trust CONFIRMED/INFERRED, code-intelligence-over-Grep all intact).
- "Do NOT call kb_capture" fully gone: CONFIRMED -- zero matches across skills/.
- kb_harvest still autowire-only: CONFIRMED ("Do NOT call kb_harvest yourself ...
  auto-dispatched ... backstop" in every surface).
- No template invites type='user-directive' capture beyond the existing proposal
  flow: CONFIRMED (new instructions specify type knowledge/learning only; the
  directive proposal flow in tpl-kb-agent.md is unchanged).

## T3 -- KB Agent curator (3b1c9b1) -- CONFORMS except HIGH-1

- Curator process ordered correctly: CONFIRMED. Step 1 scope -> Step 2 gather by
  tag -> Step 3 curate (dedupe / promote-on-APPROVED / flag-if-invalidated /
  leave) -> Steps 4-7 residual gap capture -> Step 8/8b promote + export -> Step 9
  contradictions -> Step 10 report. Ordering rule at line ~349 makes "curate
  before residual capture" explicit.
- kb_query-vs-kb_list tags-field rationale is SOUND: VERIFIED. kb-list.ts:34-42
  maps output to {id,type,confidence,title,summary,symbols,source_files} --
  `tags` is genuinely omitted. kb_query returns full entries (l1_results, tags
  present), and list() takes only a single `tag`, so kb_list cannot intersect
  sprint:+phase:. Using kb_query and post-filtering on the returned tags is the
  correct choice. (The call itself is still broken -- HIGH-1.)
- Report template updated: CONFIRMED. Step 10 gains the "In-flight (phase P): N
  reviewed, promoted X, flagged Y, left Z" line; kb-agent.md status line updated
  to match.
- kb-agent.md fill-list gained {{phase}}: CONFIRMED (kb-agent.md:41-43), with the
  tag-derivation note.
- ALL trust rules preserved: CONFIRMED. Clamp respected (Confidence Decision
  table intact, capture caps at INFERRED); promote only on APPROVED + entry-matches-approved-code
  (Step 3 bullet 2); never promote a directive (Step 3 uses kb_promote only on
  behavioral entries; the user-directive section still routes activation to the
  human CLI and states kb_promote refuses directives); kb_feedback(role="kb-agent")
  for invalidated entries -- and "kb-agent" is a valid Author enum value
  (types.ts:19), so the flag is attributed correctly, not stamped "unknown".

## FINDINGS

HIGH-1 (blocks the sprint's headline feature). tpl-kb-agent.md Step 2
(line 167) instructs:
`kb_query({ tag: "phase:{{phase}}", include_stale: true, limit: 100 })`.
This call has neither `query` nor `flagged_only`, so the kb_query TOOL rejects
it at runtime: kb-query.ts:20-22 throws
`Provide either query (free-text search) or flagged_only: true`. The KB Agent
calls kb_query via MCP (index.ts registers `kb_query` -> kbQuery), so the guard
applies. Consequences: the curator cannot gather the in-flight capture set that
is the entire input to Step 3, so the sprint's headline mechanism does not run
as documented. There is no clean workaround through kb_query -- supplying a
free-text query (e.g. "phase:1") filters by FTS relevance on title+summary (tags
are not in the FTS index), which is exactly what the design avoids; and the
flagged_only branch (which now accepts tag, kb-query.ts:29) only returns
flagged/contradiction entries, not all captures. The provider already supports
the queryless+tag path (sqlite-provider.ts:553 plain branch), so the fix is a
one-line guard relaxation:
`if (!input.query && !input.flagged_only && !input.tag) { throw ... }`.
T1 half-plumbed this (schema + provider + flagged branch accept `tag`) but left
the main-path guard unrelaxed, and T3 built on the assumption it was reachable.
Without the fix the KB Agent silently degrades to its old residual-only behavior
(safe, but the requirement is unmet).

MEDIUM-1 (residual trust/noise risk -- non-blocking, honest note per checklist 4).
Valid-but-unvalidated in-flight captures stay at INFERRED (Step 3 "left Z"), and
the retrieval-first rule instructs agents to trust INFERRED entries and skip the
source read. The retrieval-trusted INFERRED population therefore grows with
un-curated, agent-authored content that no verdict ever validated. The CONFIRMED
gate is NOT breached (see TRUST RE-CHECK), so this is a knowledge-quality risk,
not a trust-elevation hole. Mitigations in place (dedupe-first, curator
flagging). Suggested hardening (future, non-blocking): have the curator's report
surface the "left Z" count for periodic review, or let unvalidated in-flight
INFERRED entries decay faster than KB-Agent-vetted ones.

LOW-1 (minor). Step 2's `include_stale: true` also flips `include_superseded`
true (kb-query.ts:61-62 tie the two together), so a superseded in-flight capture
would be pulled into the curation set. Low impact -- captures are fresh within
the phase and Step 3's dedupe would handle any superseded straggler -- but the
curator may briefly consider an already-superseded entry. Cosmetic.

LOW-2 (verify substitution end-to-end). The doer/reviewer dispatch blocks in
doer-reviewer-loop.md carry literal `['sprint:<sprint>', 'phase:<phase>']`
placeholders and tell the agent the "exact values are in your dispatch prompt".
For the tag mechanism to work once HIGH-1 is fixed, the PM's dispatch MUST
substitute concrete sprint name and phase number on BOTH the capture side
(doer/reviewer) and the query side (KB Agent's {{sprint_name}}/{{phase}}). If a
literal `phase:<phase>` is ever emitted, captures and the curator query will not
match. Confirm the PM assembly injects concrete values; add a one-line note in
the dispatch block if not already guaranteed.

## EVIDENCE

- npm run build: CLEAN (tsc, exit 0, no output).
- npm test (full suite): 1987 passed, 6 failed, 14 skipped. The 6 are EXACTLY
  the allowed set, confirmed by isolated re-run of the two files: time-utils.test.ts
  -> 2 (toLocalISOString offset + minute-preservation, yashr-302);
  kb-session-prime.test.ts -> 4, ALL in the "graph-neighbor expansion" describe
  (graceful-skip x2, isError-context, FTS-hostile-neighbor, yashr-bwc). No new
  failures; the T1 tag tests pass.
- ASCII sweep of all added lines across 2133888..3b1c9b1 (src, skills, tests):
  CLEAN, zero non-ASCII hits.
- Main untouched; only untracked orchestrator scratch dirs (.claude/skills/,
  .claude/worktrees/) present; no PR raised.
