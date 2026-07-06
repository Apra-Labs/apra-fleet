# Plan Re-Review -- Code Intelligence Hardening (PLAN.md vs requirements.md)

Reviewer: pm-plan-reviewer
Date: 2026-07-06
Verdict: **APPROVED**

## Re-review scope

First review (commit 91f07aa) returned CHANGES NEEDED with one MEDIUM finding:
T3.3 falsely claimed all three fleet-mode templates carried code intelligence
guidance, and primed the haiku doer with "expected outcome is confirmation with
NO edits", risking a silent F1.3 miss (tpl-planner.md in fact lacks CI tool
guidance entirely).

The planner revised T3.3 in commit 240703b. This re-review verifies that
revision; all other tasks were approved as-is in the first review and are
unchanged (diff 91f07aa..240703b touches only the T3.3 section and its task
summary row).

## Finding 1 resolution -- VERIFIED FIXED

- **Correct verified reality stated:** revised T3.3 now records that
  tpl-doer.md (lines 47, 57) and tpl-reviewer.md (lines 76-79) carry both
  elements, while tpl-planner.md carries ONLY kb_session_prime (line 8) with
  zero CI guidance hits -- matching what this reviewer verified against source.
- **Expected outcome corrected:** the task is now "fill the gap, then confirm",
  not "confirm with no edits". No misleading priming remains.
- **Verbatim insert text present:** a complete "## Code Intelligence (use while
  planning)" section is given inline in the plan, so the doer needs no drafting
  judgment -- keeping claude-haiku-4-5 is appropriate.
- **Insert anchor accurate:** checked against `skills/pm/tpl-planner.md` --
  "If the KB is empty (first sprint on this repo), skip and proceed normally."
  is line 21 and "## Planning Model" is line 23, exactly as the task states.
- **Style consistent with siblings:** the insert's phrasing ("use the fleet
  code intelligence tools (code_graph, code_impact, code_query, code_context)"
  and "Never use Glob/Grep ... for structural questions") mirrors
  tpl-doer.md line 57 and tpl-reviewer.md lines 76-79, and the `##` heading
  matches tpl-planner.md's existing section style ("## Knowledge Bank ...").
- **ASCII only:** the insert uses `--` dashes; no non-ASCII characters in the
  revised section.
- **Done criteria testable:** exact-text presence in tpl-planner.md,
  byte-identical siblings unless a genuine gap is found, per-file confirmation
  in progress.json, commit message specified
  (`docs(pm): fill code intelligence gaps in fleet-mode templates`).

## Carry-over from first review (unchanged, still valid)

- Coverage: F3.1->T1.2, F3.2->T1.1, F3.3->T1.3, F2.1->T2.2, F2.2->T2.1,
  F1.1->T3.1, F1.2->T3.2, F1.3->T3.3 (revised); done criteria precise and
  testable.
- Risk front-loading: F3.2 is Task 1 (T1.1, claude-opus-4-8).
- Every work task has an exact model; T1.4/T2.3/T3.4 VERIFY tasks end each
  phase with build + test + push; no PR; never main.
- Required tests planned: F3.1 missing-index (T1.2), F3.2 connection-promise
  reset (T1.1), F2.2 freshness pure function (T2.1).
- All other factual anchors spot-checked and verified in the first review
  (code-intelligence-gitnexus.ts structure, index.ts registration lines,
  check-status.ts fleetStatus, test mock pattern, no lint script,
  doer-reviewer-loop.md template line ranges).

## Decision

APPROVED -- the sole finding is fully addressed; the plan is ready for
execution starting at T1.1.
