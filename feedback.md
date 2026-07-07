# Plan Re-Review -- KB Trust-Ops Sprint (epic yashr-bp2)

Reviewer: pm-plan-reviewer. Target: PLAN.md at commit c54143b (second
revision), checked against design.md at 9c3072b (D1 "PLAN-REVIEW HARDENING"
section, binding) and current source. Prior review: 3f63f97 (CHANGES NEEDED:
2 HIGH, 1 MEDIUM, 2 LOW). Every prior finding was re-verified against the
revised task text, and the D1 attack-check was re-run against the live
kb_promote, kb_query, kb_harvest, kb_session_prime, and kb-server code.

## VERDICT: APPROVED

0 HIGH, 1 MEDIUM (advisory, non-blocking), 0 LOW. All five prior findings are
resolved with precise, testable task text; the two coherence items check out.
The advisory concerns a pre-existing non-MCP surface outside this sprint's
threat enumeration and can be folded into T1.1 with a one-line amendment
without re-review.

## Prior findings -- resolution verification

### H1 (promote ladder) -- RESOLVED

- T1.1 step 3 "PROMOTE-LADDER GATE" requires promote() to REFUSE any
  type='user-directive' entry ENTIRELY (pending state stays binary, per the
  recommendation), with an error naming `apra-fleet kb approve-directive
  <id>`.
- approveDirective is specified as a DEDICATED method that "must NOT delegate
  to promote()" -- stated in both the task body and done criteria.
- kb-query.ts flagged_only note carve-out (directive-pending entries are
  CLI-only resolution) is in T1.1, its done criteria, and the shared-file
  table (kb-query.ts touched ONLY by T1.1).
- T1.3 step 1 now mandates the promote-ladder attack: two kb_promote calls on
  a pending proposal -> refused with the CLI-naming error, entry still
  UNVERIFIED and still excluded from defaults; the fail-then-pass test proves
  yashr-9ha closed "through BOTH doors (capture exemption and promote
  ladder)".
- The strongest formulation is in T1.1's done criteria: "no sequence of
  agent-callable MCP calls (capture, promote, or both) can produce
  type='user-directive' + confidence='CONFIRMED'".

### H2 (retrieval defaults) -- RESOLVED

- T1.1 step 5 replaces the false "assert, do not filter" premise with the
  surgical default exclusion: query()/prime() defaults exclude rows WHERE
  type='user-directive' AND confidence != 'CONFIRMED' (covers pending AND
  rejected proposals). Active (CONFIRMED) directives keep surfacing.
- Both sides are tested: excluded from query/prime defaults, still visible in
  kb_list and flagged_only (T1.1 test list AND T1.3 step 1(b), plus both
  done-criteria blocks).
- Ambiguity resolution 1 is rewritten honestly with the correct source cites
  (sqlite-provider.ts:478-490, 657-662) and records that D1's original
  wording is superseded by the binding hardening section, with the
  progress.json deviation note required. Consistent with the revised
  design.md.

### M1 (global-scope escape) -- RESOLVED

T1.1 step 1 forces scope='project' for type='user-directive' (with the
kb-capture.ts:61-63 routing cite), documents it in the tool description, and
tests it ("scope forced to 'project' even when scope='global' is
requested"). T1.2 now states why project-KB-only CLI coverage is complete
and marks `add-directive --global` explicitly out of scope.

### L1 (stale tool description) -- RESOLVED

T1.1 step 1 updates kb-capture.ts:24 and the role param text to describe
proposal-only semantics and the CLI activation path; done criterion added.

### L2 (decay wording) -- RESOLVED

T1.1 step 4 states decay only demotes INFERRED -> UNVERIFIED and pending
proposals have no observable decay; tests assert the correct pair (an
INFERRED user-directive row decays; a CONFIRMED one never does). T1.3(d)
reworded to match.

## Coherence checks (as requested)

- T3.7 pin: step 4 now uses NON-directive entries for the kb_promote +
  supersede resolution, explicitly because the H1 gate refuses user-directive
  rows and the flagged_only note carves directives out -- the e2e exercises
  the agent-resolvable flagged flow only. Coherent with T1.1; no task
  contradicts the gate.
- Expanded shared-file sequencing is coherent: sqlite-provider.ts T1.1
  (guards + promote gate + activation primitives) -> T2.1 (stats()) -> T3.1
  (feedback support), enforced by phase order with no parallel edits;
  kb-query.ts and kb-capture.ts each touched only by T1.1; all previously
  verified orderings (audn, kb-session-prime, kb-export, check-status,
  index.ts) unchanged.

## Re-run attack-check: can an agent reach an ACTIVE directive?

Via any MCP path: NO.
- kb_capture: clamp applies to user-directive; stores UNVERIFIED + flagged +
  'directive:pending', scope forced to project. Closed.
- kb_promote: refuses type='user-directive' entirely (both pending and
  active). The two-call ladder is dead. Closed.
- kb_feedback (T3.1): touches stale/flagged only, never confidence. Closed.
- kb_harvest: hardcodes type='learning', confidence='UNVERIFIED'
  (kb-harvest.ts:118,130) -- cannot set type or confidence. Closed.
- kb_invalidate / kb_setup: staleness/config only. Closed.
- Export/seed round-trip: cold-seed merges bible entries into prime OUTPUT
  only (kb-session-prime.ts:248-287), never the DB; no directive semantics
  attach. Closed.
- Activation primitives (approveDirective/addDirective): CLI-only, not
  registered as MCP tools, and the kb-server HTTP layer uses explicit routes
  (no generic provider dispatch), so they are not remotely exposed. Closed.

Residual non-MCP door (advisory M-A1 below): the kb-server HTTP capture
route.

## Advisory finding

### M-A1 (MEDIUM, advisory -- non-blocking): kb-server /api/kb/capture bypasses the tool-layer gate

POST /api/kb/capture (src/commands/kb-server.ts:133-141) parses the body as
KBEntryInput and calls provider.capture() DIRECTLY -- no confidence clamp, no
directive gate, only bearer-token auth and file-path validation. A caller
holding the kb-server token (which agents in shared-KB deployments can read
from local provider config) could POST type='user-directive',
confidence='CONFIRMED' and mint an ACTIVE directive in one call, bypassing
everything T1.1 builds at the tool layer.

Why non-blocking here: this is NOT an MCP path (the sprint's F1/D1 threat
enumeration and the hardening section are MCP-scoped); it is pre-existing --
the same route already bypasses the kb-integrity D1 confidence clamp and that
sprint was APPROVED with it; it only exists in remote-KB (kb-server)
deployments; and exploiting it requires deliberate raw HTTP outside the tool
surface.

Recommended one-line amendment to T1.1 (can be applied without re-review):
place the directive proposal-transformation (user-directive -> UNVERIFIED +
flagged + 'directive:pending' + project scope) inside SqliteProvider.capture()
rather than (or in addition to) the kb-capture tool handler.
sqlite-provider.ts:439-441 already documents capture() as "the single choke
point every caller (kb_capture, kb_harvest, future paths) goes through" --
putting the gate there closes the HTTP route for free and is where the
kb-integrity architecture says such invariants belong. Alternatively, record
the HTTP route as an accepted residual risk in progress.json notes and file a
bead for a follow-up sprint (the route needs the same treatment for the
plain confidence clamp anyway).

## Standing observations (unchanged from first review, no action)

- Bible-file injection can poison cold-session prime OUTPUT only (never the
  DB, no directive semantics); the committed-and-reviewed bible is the
  control.
- All first-review checklist passes remain valid: F1-F11 coverage, factual
  anchors, D5/D6/D8 compliance, model assignments (F1 core + test rewrite on
  opus), VERIFY tasks with the analyze-then-checkout gotcha, ASCII /
  never-main / no-PR constraints, and ambiguity resolutions 2-7 (promoted_at
  readers re-checked: kb-export updated_at intended, decay guard irrelevant
  at CONFIRMED, promote() now refuses directives outright -- resolution 3
  remains coherent).

The plan is approved for execution as written; M-A1 is recommended but not
required for the sprint to proceed.
