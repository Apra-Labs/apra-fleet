# Requirements -- KB Trust-Ops

Sprint epic: yashr-bp2. Branch: feat/code-intelligence-abstraction (base: main).
Binding architecture decisions in design.md (D1-D9) -- read before planning.

## Background

The kb-integrity sprint (yashr-oaf, APPROVED) made the KB trust model real. Its
final review surfaced one MEDIUM trust gap plus a set of operational and reach
improvements the user has approved. This sprint closes the gap and ships the
ops/measurement/reach layer.

Beads sources: yashr-9ha (forgeable directive), yashr-hzd (polarity substring),
yashr-u2h (cwd fragility), yashr-u2x (kb_stats), yashr-b4h (bible freshness),
yashr-doq (server version handshake), yashr-2s5 (retrieval feedback),
yashr-dpr (global bible), yashr-g4h (auto-capture directives).

## Phase P1 -- Trust closure (riskiest first)

**F1 Gate the user-directive type (yashr-9ha).** Today type='user-directive' is
assertable by any kb_capture caller and lands CONFIRMED-equivalent, un-decayable,
un-agent-supersedable -- any agent can self-elevate. The MCP layer has no
user-vs-agent identity, so the gate is a two-tier redesign (design D1):
- MCP path becomes PROPOSAL-ONLY: kb_capture(type='user-directive') no longer
  stores an active directive; it stores a directive PROPOSAL (flagged, inactive
  for retrieval-as-directive; see D1 for exact representation).
- ACTIVATION is human-gated: a CLI command (runs in the human's terminal, not
  via MCP) lists pending proposals and activates one; activation sets the
  directive live (CONFIRMED tier semantics from kb-integrity apply unchanged
  once active). /pm kb-review also surfaces pending proposals and instructs the
  human to run the CLI.
- All four D6 semantics from kb-integrity (never decayed, only user supersedes,
  top-tier retrieval, CONFIRMED-equivalent rank) apply to ACTIVE directives
  only. Existing tests must be updated to go through activation.
- Fail-then-pass test: an agent capture of type user-directive is NOT
  retrievable as an active directive until CLI activation.

**F2 Auto-capture user directives (yashr-g4h; depends on F1).** PM-skill
behavior, documentation + template work (no new server code beyond F1):
- skills/pm/SKILL.md + sprint docs: when the user issues a standing instruction
  ("always do X", "never do Y", "we decided Z"), the PM immediately proposes a
  directive via kb_capture(type='user-directive') -- now safe because it is
  proposal-only -- tells the user it is pending, and surfaces the activation
  command to run.
- tpl-kb-agent.md: the KB Agent may also propose directives it detects in the
  session record, same pending flow.

**F3 Polarity word-boundary fix (yashr-hzd).** hasOppositePolarity currently
uses String.includes on bare tokens ('fixed' matches 'prefixed'); switch to
word-boundary matching. Tests: 'prefixed'/'unresolved'/'suffixed' no longer
signal; genuine 'fixed'/'broken' pairs still do.

**F4 Repo-path robustness (yashr-u2h).** kb_export and the kb_session_prime
cold-seed derive repo root from process.cwd() fallbacks; make the repo path an
explicit validated input everywhere feasible and document the precedence
(explicit input > validated session context > skip). No behavior change when a
valid path is provided.

## Phase P2 -- Ops and measurement

**F5 kb_stats tool (yashr-u2x).** New read-only tool (design D4):
input { repo?, symbols?: string[] } -> {
  totals by confidence and type, stale count, flagged count,
  retrieval: { entries_retrieved, total_uses, hit_rate },
  promote_ratio (promoted_at set / CONFIRMED),
  bible: { present, entries, drift (see F6) },
  coverage: when symbols[] given, fraction with a live CONFIRMED entry whose
  symbols contain it (exact match), plus per-symbol breakdown }.
No use_count bumps (dedicated reads like kb_list). Surface a compact code-KB
health line in fleet_status (degraded-safe pattern). Tests for every section.

**F6 Bible freshness: AUTO-COMMIT at harvest (yashr-b4h; USER DIRECTIVE
2026-07-07: "at time of harvesting we should commit our learning -- we should
not run this manually").** Two parts:
- F6a AUTO-COMMIT (code, not docs -- design D5): kb_export, after writing the
  bible file, automatically git-commits it (pathspec-only, dedicated identity,
  only when content changed, non-fatal on any git failure, config off-switch).
  Since the KB Agent already runs kb_export after every promotion, the chain
  reviewer verdict -> KB Agent -> promote -> export -> COMMIT becomes fully
  automatic -- zero manual steps. Push is NOT automatic (rides the existing
  per-turn sprint pushes).
- F6b drift VISIBILITY (design D5): kb_stats.bible.drift reports how many live
  CONFIRMED entries are newer than the bible's newest updated_at; fleet_status
  shows it. With F6a in place, nonzero drift becomes an ANOMALY signal (a
  failed auto-commit), not a reminder. tpl-kb-agent.md wording updated to
  reflect the automatic flow.
CI cannot see the local KB, so there is no CI gate -- drift is visibility.

**F7 Server version handshake (yashr-doq).** The running MCP server can lag the
rebuilt dist until restarted (bit us twice). The server knows its own version
(serverVersion); add a check comparing it to the on-disk installed/built
version (design D6) and surface a mismatch warning in fleet_status compact +
json ("server running vX, disk has vY -- restart your MCP client"). Degraded-
safe; never fails fleet_status.

## Phase P3 -- Reach

**F8 Retrieval feedback / downvote (yashr-2s5).** New small tool kb_feedback
(design D7): input { id, reason, role? } -> marks the entry stale=1 +
flagged_for_review=1, appends an ASCII feedback note (who/when/reason via the
provenance enums), never deletes. Doer + reviewer templates gain one line: if a
retrieved entry proves wrong in practice, kb_feedback it. /pm kb-review picks
flagged entries up (existing).

**F9 Global bible inheritance (yashr-dpr).** Platform-level learnings (global
KB scope) become a distributable bible (design D8):
- kb_export gains scope handling: exporting the GLOBAL scope writes
  .fleet/kb-canonical-global.json (same stable field set) -- committed in the
  apra-fleet repo (the platform repo).
- The installer copies the committed global bible into
  ~/.apra-fleet/data/knowledge/global/ so EVERY project on the machine can see
  it without having it in their own repo.
- kb_session_prime cold-seed also merges from the installed global bible
  (after project bible, below live hits, same via marker pattern:
  'canonical-bible-global'), same non-fatal contract.
- Tests: global export shape; installer copy step; prime seeds from global
  fixture; absent/malformed degrade.

**F10 Quantitative model assignment.** Planner template (doer-reviewer-loop.md
planner block + tpl-planner.md): call kb_stats with the plan's key symbols;
coverage >= 0.8 -> lean cheap/standard; < 0.3 -> premium + front-load; cite the
number in PLAN.md's model rationale. Template text only.

**F11 Flagged-pipeline e2e proof.** The kb-review flow has never been exercised
against a real flagged pair. Add an e2e test that: captures a contradiction
(flagged), captures a kb_feedback downvote (flagged), queries
flagged_only:true and sees both, resolves one via kb_promote + supersede, and
verifies the flags clear appropriately. Documentation pass on kb-review.md if
the flow description does not match reality.

## Done criteria (sprint-wide)

- npm run build clean; npm test green (only the 2 pre-existing timezone
  failures, yashr-302, may fail).
- F1 has a fail-then-pass test (agent-asserted directive inactive until CLI
  activation). Every new tool/behavior has tests.
- ASCII only. Never push main. NO PR (user raises PRs). No mass migration of
  existing rows; forward-only enforcement, documented.
