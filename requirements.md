# Requirements -- KB Integrity

Sprint epic: yashr-oaf. Branch: feat/code-intelligence-abstraction (base: main).
Binding architecture decisions are in design.md (D1-D8) -- read it before planning.

## Background

A data-grounded audit (2026-07-06) of the Agent Learning knowledge bank found the
capture engine and retrieval work, but the TRUST model is unenforced. Evidence
from two live KBs (apra-fleet 46 entries, streamsurv 46 entries):

- 44/44 CONFIRMED entries were captured directly as CONFIRMED; 0 went through
  kb_promote (the gate is decorative -- kb-capture.ts accepts confidence:CONFIRMED
  from any caller at lines 19, 64).
- The apra-fleet KB holds BOTH "code_graph is broken" and "code_graph is fixed"
  as live CONFIRMED entries -- corrections accumulate as contradictions instead
  of superseding. The KB Agent reported superseding the old one; superseded_at is
  null. AUDN never flagged the pair (0 flagged across 92 entries).
- 0 entries stale in either project despite streamsurv spanning 2+ weeks of code
  change -- file-hash staleness (sqlite-provider.ts sync path) runs only on an
  explicit kb_invalidate, never at prime.
- Retrieval is bimodal: 76% hit rate (apra-fleet) vs 11% (streamsurv). FTS MATCH
  treats space-separated hint terms as implicit AND, so kb_session_prime silently
  returns nothing when hints do not co-occur (tracked yashr-5n2, yashr-17i).
- Provenance is inconsistent: author in {"", claude, kb-agent, Knowledge Agent,
  pm, pm-planner}; source in {doer, reviewer, kb_agent_harvest} used loosely.
- kb_harvest is vestigial (regex over a transcript the agent cannot access).
- User instructions never enter the KB -- the most authoritative signal is
  discarded.

This sprint makes the trust model real: enforced in code, not in templates.

## Features (grouped by phase; planner finalizes tasks)

### P0 -- Trust core (riskiest, first)

**F1 Enforce the CONFIRMED gate in code.** kb_capture must cap confidence at
INFERRED regardless of the caller's value (see design D1). CONFIRMED is reachable
ONLY via kb_promote, which already exists and is registered. Existing directly-
CONFIRMED entries are left as historical data (the gate applies going forward);
document this in the tool and a short docs note. user-directive entries are the
sole exception (see F6/D6). Update tpl-kb-agent.md so the KB Agent uses
kb_promote for CONFIRMED, and reconfirm the confidence decision table matches the
enforced behavior.

**F2 Corrections supersede; contradictions get flagged.** (design D2)
- When kb_capture's AUDN path decides an entry corrects/updates an existing one,
  the old entry MUST actually be marked superseded_at + stale=1 (verify the
  current 'update' path does this; the code_graph pair proves it did not).
- Loosen AUDN contradiction detection so a genuine contradiction on shared
  symbols is flagged even without file overlap (current AND-logic is too strict).
  Add tests using the real code_graph broken-vs-fixed pair shape.
- Provide a one-time reconciliation for the existing code_graph contradiction in
  the apra-fleet KB is OUT of scope (that is live data, not code) -- but the new
  logic must flag such a pair going forward; add a test that proves it.

### P1 -- Freshness and retrieval

**F3 Auto-staleness at prime.** (design D3) kb_session_prime runs the existing
file-hash staleness check for the entries/files it is about to surface BEFORE
returning, so entries whose source files changed are marked stale and excluded
(or flagged). Must be fast and non-fatal -- any error degrades to today's
behavior.

**F4 Fix retrieval FTS (OR-join).** (design D4) The FTS query builder joins
multiple terms with OR semantics instead of implicit AND, so multi-term primes
and the P4b neighbor batch actually return relevant entries. Single-term behavior
unchanged. Closes yashr-5n2 and yashr-17i. Add tests with multi-term queries that
return nothing today and hits after the fix.

**F5 Canonicalize provenance.** (design D5) author and source become fixed enums
stamped by the tool layer, not free strings from the caller. Migrate the schema/
types; existing rows keep their values (historical), new writes use the enums.

### P2 -- Reach and sharing

**F6 Capture user instructions.** (design D6) A user-directive entry type at the
highest trust tier: authoritative, never auto-decayed, only superseded by another
user directive. Provide the capture path (a kb_capture with type=user-directive,
exempt from the F1 gate) and document when the PM/agent records one.

**F7 Retire kb_harvest.** (design D7) Deprecate the tool (keep registered as a
documented no-op/deprecated for backward compat) and remove it from every
template (tpl-doer.md, tpl-kb-agent.md, doer-reviewer-loop.md) and docs. KB-Agent
direct capture is the sole documented capture path.

**F8 kb_list + canonical git bible.** (design D8) New kb_list tool (filter by
confidence/type/module/symbol) so the CONFIRMED set is visible. The KB Agent,
after promoting, exports CONFIRMED entries to <repo>/.fleet/kb-canonical.json and
the PM commits it; kb_session_prime seeds from that file when the local KB is
cold. This is the shareable, diffable team bible discussed with the user.

## Done criteria (sprint-wide)

- npm run build clean; npm test green (only the 2 pre-existing timezone failures
  in tests/time-utils.test.ts, beads yashr-302, may fail).
- Every behavior change has tests. F1/F2/F4 especially need tests that FAIL on
  today's code and PASS after (the gate, the supersede, the OR-join, the
  contradiction flag).
- ASCII only. Never push to main. NO PR (the user raises PRs).
- No silent data migration: existing rows are preserved; enforcement is forward-
  looking and documented.
