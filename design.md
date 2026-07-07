# Design -- KB Trust-Ops

Binding decisions for the kb-trust-ops sprint (epic yashr-bp2). Planner and
reviewers check code against these; deviations need a recorded reason in
progress.json notes.

Relevant code (state after kb-integrity, verified 2026-07-07):
- src/tools/kb-capture.ts -- clamp to INFERRED; sole exemption
  type==='user-directive' stores CONFIRMED + author='user' +
  source='user-directive'. THIS EXEMPTION IS THE HOLE F1 CLOSES.
- src/services/knowledge/audn.ts -- makeAudnDecision: user-directive supersede
  guard; contradiction path cross-type; orJoinFtsTerms/ftsSafeTerm;
  hasOppositePolarity (substring matching -- F3 target).
- src/services/knowledge/sqlite-provider.ts -- capture/promote/list/prime;
  checkFreshness; decayConceptEntries (type != 'user-directive' guard);
  flagged_for_review + superseded_at + stale columns.
- src/tools/kb-export.ts -- CONFIRMED -> .fleet/kb-canonical.json; repo path
  input validated but callers may default to cwd (F4 target).
- src/tools/kb-session-prime.ts -- prime -> staleness -> global append ->
  graph-neighbor -> cold-seed (COLD_KB_MAX=3, via:'canonical-bible').
- src/tools/kb-list.ts -- dedicated no-bump provider read (pattern for F5).
- src/tools/check-status.ts -- fleetStatus() degraded-safe sections (pattern
  for F5/F6/F7 surfacing). src/version.ts -- serverVersion.
- src/cli/*.ts + src/index.ts -- CLI command dispatch (install etc.); the F1
  activation command lives here.
- KB scope column exists ('project' | 'global'); global KB at
  ~/.apra-fleet/data/knowledge/global/kb.sqlite.

## D1 -- Directive gate: propose via MCP, activate via CLI (human-only)

Identity truth: MCP gives no user-vs-agent signal; env vars and prompt-level
confirmation are forgeable by construction. The only channel agents cannot
quietly use is a command the human runs in their own terminal. Therefore:

- PROPOSAL (MCP, any caller): kb_capture(type='user-directive') stores the
  entry with confidence='UNVERIFIED', flagged_for_review=1, and a
  directive-pending marker (add a tag 'directive:pending' or reuse an existing
  column -- planner picks the cleanest representation and states it; NO new
  trust semantics attach while pending). author='user' is NO LONGER stamped on
  proposals -- stamp the validated role hint (or 'unknown') so provenance is
  honest about who proposed. The kb-capture clamp exemption is REMOVED (a
  pending proposal is UNVERIFIED like anything else).
- ACTIVATION (CLI, human terminal): new command, e.g.
  `apra-fleet kb directives` (list pending + active) and
  `apra-fleet kb approve-directive <id>` / `reject-directive <id>`.
  Approval sets confidence='CONFIRMED', author='user', clears
  flagged_for_review/pending marker -- the entry becomes an ACTIVE directive
  and all kb-integrity D6 semantics apply from here (never decayed, only a
  user-approved directive supersedes it, top-tier retrieval). Rejection marks
  superseded_at + stale (audit trail, never delete).
- makeAudnDecision's user-directive supersede guard and decay guard must key
  off ACTIVE directives (type + CONFIRMED), not pending proposals -- verify
  and adjust the checks.
- Retrieval: pending proposals are flagged+UNVERIFIED so they already do not
  surface in prime/query defaults; assert this in tests rather than adding
  filters.
- Direct human add: `apra-fleet kb add-directive "<text>" [--symbols ...]`
  creates an already-active directive (human terminal = the trust root).
- Existing kb-user-directive tests are rewritten to go through activation.
- Fail-then-pass: agent-asserted directive is NOT an active directive (not
  CONFIRMED, not exempt from decay/supersede rules, not retrievable in
  defaults) until approved via CLI.

PLAN-REVIEW HARDENING (2 HIGH + 1 MEDIUM, binding):
- H1 PROMOTE LADDER: SqliteProvider.promote() has no type guard -- two
  agent-callable kb_promote calls walk a pending proposal UNVERIFIED ->
  INFERRED -> CONFIRMED, which IS the ACTIVE predicate. REQUIRED: promote()
  REFUSES any entry with type='user-directive' (clear error naming the CLI
  path). CLI activation uses a DEDICATED provider method (e.g.
  approveDirective(id)), not promote(). The kb_query flagged_only response
  note (kb-query.ts:49) currently tells agents to resolve flagged entries "by
  calling kb_promote" -- add a carve-out: directive-pending entries are
  resolved only by the human CLI. T1.3's fail-then-pass suite MUST include the
  promote-ladder attack (two promotes on a pending proposal -> refused, still
  inactive).
- H2 RETRIEVAL DEFAULTS: query()/prime() defaults exclude only stale/
  superseded -- flagged UNVERIFIED entries DO surface today, so the pending
  representation alone does NOT keep proposals out of defaults. REQUIRED
  (surgical, no broad behavior change): query() and prime() defaults exclude
  rows WHERE type='user-directive' AND confidence != 'CONFIRMED' (pending or
  rejected proposals). Active (CONFIRMED) directives keep surfacing. kb_list
  (audit tool) and the flagged_only path DO show pending proposals -- that is
  where humans/agents find them. Assert both sides in tests.
- M1 GLOBAL-SCOPE ESCAPE: a directive proposal captured with scope='global'
  would land where the project CLI cannot list/approve it. REQUIRED:
  kb_capture forces scope='project' for type='user-directive' (documented in
  the tool description); global directives, if ever needed, are a future CLI
  add-directive --global concern.
- L1: update kb-capture.ts's tool description (still advertises the removed
  CONFIRMED exemption). L2: pending proposals are not subject to observable
  decay (decay is INFERRED->UNVERIFIED); word tests accordingly.

## D2 -- Auto-capture flow is documentation on top of D1

No new server machinery. PM SKILL.md gains a short "standing instructions"
section: detect "always/never/we decided" style user statements -> immediately
kb_capture(type='user-directive') the proposal -> tell the user: pending, run
`apra-fleet kb approve-directive <id>`. tpl-kb-agent.md gains the same for
directives detected in session records. Keep wording tight; this is behavior
agents follow because dispatch templates carry it (known limitation, fine --
the TRUST boundary is the CLI, not the detection).

## D3 -- Polarity word-boundary

hasOppositePolarity tokenizes with word boundaries (regex \b or split on
non-word chars) instead of String.includes. Keep the antonym pair list; only
the matching tightens. Tests: prefixed/unresolved/suffixed no longer signal;
fixed-vs-broken still does; case-insensitive.

## D4 -- kb_stats: one read-only aggregation tool

- src/tools/kb-stats.ts + SqliteProvider.stats() as a dedicated read (kb_list
  pattern -- never bumps use_count).
- Sections (all cheap single queries): totals (GROUP BY confidence, type);
  stale/flagged/superseded counts; retrieval { entries_retrieved
  (use_count>0), total_uses (SUM), hit_rate (retrieved/total live) };
  promote_ratio (promoted_at IS NOT NULL / CONFIRMED count); bible { present,
  entries, drift } (see D5); coverage (input symbols[] -> per-symbol boolean:
  EXISTS live CONFIRMED entry with symbol exact-in-array, plus the fraction).
- fleet_status: one compact line + json key, degraded-safe try/catch (omit on
  any error), following the code-intel health precedent in check-status.ts.
- HttpKbProvider: implement stats() or return a documented not-supported
  result -- never throw.

## D5 -- Bible drift is visibility, not a CI gate

CI machines have no kb.sqlite, so a CI check cannot compare KB to bible. Drift
lives where the KB lives: kb_stats.bible.drift = count of live CONFIRMED
entries whose updated_at > the newest updated_at inside .fleet/
kb-canonical.json (file absent -> drift = all live CONFIRMED, present flag
false). fleet_status renders "bible: N promotions behind (run kb_export,
commit .fleet/kb-canonical.json)" when N > 0. tpl-kb-agent.md Step: export
after promote is already documented -- add the drift line to the KB Agent
report template so the PM sees it each phase.

## D6 -- Version handshake inside the running server

The running server compares its compiled-in serverVersion (src/version.ts)
against the on-disk version of the code it was launched from (read
version.json / package.json relative to the dist entry actually resolved at
runtime -- findProjectRoot pattern from install.ts). Mismatch -> fleet_status
warning line + json field. Notes: SEA binaries embed assets (read via the
existing manifest path); if the disk read fails, omit silently (degraded-safe).
No auto-restart in this sprint -- surface only.

## D7 -- kb_feedback: downvote without deletion

- src/tools/kb-feedback.ts: input { id, reason, role? }. Effect: stale=1,
  flagged_for_review=1, append ASCII note "[feedback <ISO>] <validated-role>:
  <reason>" to content (CONTENT_CAP respected). Validated role via the
  provenance enums; invalid -> 'unknown'. Never deletes, never touches
  confidence (a downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged --
  the human resolves in kb-review; state this in the tool description).
- Registered in src/index.ts; one line in tpl-doer.md + tpl-reviewer.md + the
  doer/reviewer dispatch templates in doer-reviewer-loop.md: "if a KB entry you
  retrieved proves wrong in practice, call kb_feedback with the entry id and
  what was wrong."
- user-directive entries: feedback flags them for review but must NOT stale
  them (directives outrank agent experience; the human decides) -- flag only.

## D8 -- Global bible: export from global scope, distribute via installer

- kb_export input gains scope: 'project' (default, unchanged) | 'global'.
  Global export reads the GLOBAL KB (scope='global' provider / global
  kb.sqlite), writes .fleet/kb-canonical-global.json in the given repo path
  (in practice: the apra-fleet platform repo, committed there).
- Installer (src/cli/install.ts): a step copies the repo's committed
  .fleet/kb-canonical-global.json (when present) to
  ~/.apra-fleet/data/knowledge/global/kb-canonical-global.json. Non-fatal.
- kb_session_prime cold-seed: after the project-bible merge, also merge from
  the INSTALLED global bible path (homedir, not repo), marked
  via:'canonical-bible-global', below project-bible entries, same caps and
  non-fatal contract. Cold threshold shared (COLD_KB_MAX).
- Do NOT auto-promote project entries to global; moving knowledge to the
  global scope stays a deliberate act (out of scope here beyond what
  kb_capture's scope param already allows).

## D9 -- Quantitative model assignment is template-only

planner template (doer-reviewer-loop.md) + tpl-planner.md: after
kb_session_prime, call kb_stats with the plan's key symbols; use coverage:
>= 0.8 -> cheap/standard for tasks on those symbols; < 0.3 -> premium +
front-load; between -> judgment. Require PLAN.md's model rationale to cite the
coverage number. No code changes.

## Phasing (risk order)

Phase 1: F1 (D1 -- riskiest: touches the trust core + first CLI surface), F2
(D2 docs, after F1), F3 (D3), F4 (repo-path robustness). Phase 2: F5+F6 (D4/D5
share kb-stats), F7 (D6). Phase 3: F8 (D7), F9 (D8), F10 (D9 templates), F11
(flagged-pipeline e2e).

Shared files: kb-capture.ts (F1 removes the exemption) and audn.ts (F1 guard
rekey, F3 polarity) both touched in Phase 1 -- sequence F1 before F3 or state
disjoint functions. kb-session-prime.ts touched by F4 (path) and F9 (global
seed) -- F4 first, F9 appends after the existing cold-seed block.
check-status.ts touched by F5/F6/F7 -- one coherent task or strictly
sequenced. kb-export.ts touched by F4 and F9 -- sequence F4 first.
