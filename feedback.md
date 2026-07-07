# Phase 1 Security Review -- KB Trust-Ops Sprint (epic yashr-bp2)

Reviewer: pm-reviewer (security-critical, yashr-9ha). Target: Phase 1 (T1.1-T1.6
+ VERIFY T1.7) on branch feat/code-intelligence-abstraction. Commits reviewed:
9b81b42 (T1.1 gate core), f6b46c9 (T1.2 CLI), ebff004 (T1.3 proof), 10e0211
(T1.4 docs), f38bcdf (T1.5 polarity), 13a528c (T1.6 repo paths). Checked against
requirements.md (F1-F4), design.md D1 (incl PLAN-REVIEW HARDENING H1/H2/M1/L1/L2),
D2, D3, and the plan re-review advisory M-A1. The gate was attacked directly
(live scripts against the compiled dist), not merely read.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 1 LOW (informational, pre-existing, out of scope, already
tracked). The directive trust gate (yashr-9ha) is closed through every
MCP-reachable door. Build clean; tests green except the exact allowed failures.

## Attack results per door (executed live, not just from tests)

DOOR 1 (capture) -- CLOSED. The proposal transform lives in the single choke
point SqliteProvider.capture() (sqlite-provider.ts:449-461): any input with
type='user-directive' is forced to confidence='UNVERIFIED', flagged_for_review=1,
tag 'directive:pending', scope='project' BEFORE any AUDN evaluation or insert.
Because every capture route funnels through this method, all of them are closed:
- kb_capture handler: the general clamp (CONFIRMED->INFERRED) plus the choke
  point -> pending proposal. Verified.
- HTTP /api/kb/capture (kb-server.ts:133-141) calls provider.capture(input)
  directly on a real SqliteProvider (kb-server.ts:96-101) -- the advisory M-A1
  route. My live attack posted type='user-directive', confidence='CONFIRMED',
  scope='global' straight into provider.capture(): result was UNVERIFIED +
  flagged + directive:pending + scope='project'. M-A1 is resolved by
  construction (the recommended amendment was applied).
- kb_harvest hardcodes type='learning', confidence='UNVERIFIED'
  (kb-harvest.ts:118,130) -- cannot assert the type. Closed.
- scope='global': forced back to 'project' (M1). Closed.
Live result: no route produced type='user-directive' AND confidence='CONFIRMED'.

DOOR 2 (promote) -- CLOSED. SqliteProvider.promote() (sqlite-provider.ts:814-818)
refuses ANY type='user-directive' entry ENTIRELY, before the ladder, with an
error naming `apra-fleet kb approve-directive <id>`. My live promote-ladder
attack (two consecutive promote() calls on the pending proposal) was refused on
both rungs; the entry stayed UNVERIFIED and stayed excluded from defaults. The
refusal is binary (also refuses an ACTIVE directive), verified live.

DOOR 3 (any other write) -- CLOSED. approveDirective / rejectDirective /
addDirective / listDirectives are provider methods reachable ONLY through the
`apra-fleet kb ...` CLI dispatch in the argv parser (index.ts:120-127); they are
NOT among the server.tool(...) registrations (index.ts:371-380 register
kb_capture/query/list/harvest/promote/setup/export/invalidate/context/session_prime
only) and the kb-server HTTP layer exposes no directive route. approveDirective
is dedicated and does NOT delegate to promote() (it does a direct UPDATE).
addDirective bypasses capture() to mint an active directive, but only the CLI
can call it. No MCP-exposed surface reaches directive activation.

## Item-by-item findings

1. Retrieval exclusion (H2) -- CORRECT. query() pushes
   `NOT (e.type='user-directive' AND e.confidence != 'CONFIRMED')` into the
   shared `conditions` (sqlite-provider.ts:525), applied to BOTH the FTS branch
   (via ftsWhere) and the non-FTS branch (via where). prime() retrieves through
   this.query() (sqlite-provider.ts:693), so it inherits the exclusion. The
   condition sits in the non-flagged_only else-branch, so flagged_only still
   surfaces pending proposals; kb_list uses a separate list() method and is
   unaffected. Live-verified: pending proposal absent from query/prime defaults,
   present in kb_list + flagged_only, active directive surfaces, and a
   NON-directive flagged learning is NOT accidentally excluded from defaults.

2. Guard rekeys -- MATCH D1 hardening. Supersede guard (audn.ts:175):
   `candidate.type==='user-directive' && candidate.confidence==='CONFIRMED'` ->
   continue, protecting ONLY active directives; a proposal (now always
   UNVERIFIED) can neither supersede nor update an active directive, and the
   contradiction path stays ahead of the guard (audn.ts:147) so a colliding
   agent capture only flags. Decay guard (sqlite-provider.ts:402):
   `AND NOT (type='user-directive' AND confidence='CONFIRMED')` -- an active
   directive never decays; a hypothetical INFERRED user-directive would. L2
   wording honored.

3. T1.5 polarity -- CORRECT. hasOppositePolarity uses precompiled `\b`-anchored
   regexes (audn.ts:39-44), case-insensitive via the 'i' flag. Live-verified:
   'prefixed' / 'unresolved' / 'suffixed' no longer signal; genuine
   broken-vs-fixed still does; "doesn't work" vs "now works" still matches
   (apostrophe sits inside the phrase, not at a boundary); case-insensitive
   holds. makeAudnDecision decision structure untouched.

4. T1.6 repo paths -- CORRECT. resolveRepoPath(explicit) in kb-export.ts:72-78
   (`explicit || process.cwd()` then existsSync + isDirectory, throws on
   failure) and kb-session-prime.ts:89-93 (same validation, returns null to
   preserve the non-fatal cold-seed hard-skip). Precedence explicit > validated
   cwd > refuse/skip; no blind cwd fallback remains; no behavior change on a
   valid path. Documented in both tool descriptions and site comments.

5. T1.4 docs -- ACCURATE. SKILL.md "Standing instructions", tpl-kb-agent.md
   "User directives (D1)", and kb-review.md all state the proposal -> pending ->
   CLI-approve flow with the exact command `apra-fleet kb approve-directive <id>`
   and the CLI-only / never-kb_promote resolution rule.

6. T1.3 proof -- STRONG. kb-directive-gate.test.ts encodes the yashr-9ha attack
   through the real tool handlers across both doors plus the four D6 semantics
   after CLI activation; the promote-ladder attack (two kb_promote -> refused,
   still inactive) is present.

7. Out-of-order execution (T1.6 before T1.4/T1.5) -- NO IMPACT. The files are
   disjoint (kb-export.ts / kb-session-prime.ts vs SKILL.md / tpl-kb-agent.md /
   kb-review.md / audn.ts) and T1.5 only required T1.1 to precede it in audn.ts,
   which held. Deviations recorded in progress.json.

8. Build + tests -- PASS. `npm run build` (tsc) clean, no output. Full suite:
   1892 passed, 6 failed, 14 skipped. The 6 failures are exactly the allowlist,
   confirmed by name: 2 timezone (tests/time-utils.test.ts toLocalISOString,
   yashr-302) + 4 kb-session-prime.test.ts "graph-neighbor expansion" real-KB
   leaks (yashr-bwc; the test block reads the real repo's .fleet/kb-canonical.json
   via an unmocked process.cwd(), unchanged by T1.6 since cwd validates on this
   machine). No regression.

9. ASCII -- CLEAN. Non-ASCII byte scan across all branch-changed files (a
   superset of the Phase 1 files) found zero hits, including the
   asciiSafeStringify-generated .fleet/kb-canonical.json.

## LOW-1 (informational, non-blocking, out of scope, already tracked)

The HTTP /api/kb/capture route still bypasses the GENERAL confidence clamp for
NON-directive types: an HTTP caller holding the kb-server bearer token can POST
type='learning', confidence='CONFIRMED' and mint a CONFIRMED (non-directive)
entry, because the general clamp lives in the kb_capture tool handler, not in
capture(). This is NOT the directive forge (the directive gate IS enforced in
capture() and closes on HTTP, verified above), is pre-existing (accepted at
kb-integrity), affects only remote-KB deployments, and the doer recorded it as
tracked bead yashr-f3g in progress.json T1.1 notes. Out of scope for yashr-9ha;
recommend the general clamp be relocated into capture() in a future sprint so
the choke point enforces both invariants uniformly.

Phase 1 is approved. The trust core is sound and the attack surface for
yashr-9ha is closed through every MCP door.
