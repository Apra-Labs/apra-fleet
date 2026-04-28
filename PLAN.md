# apra-fleet #182 — Tier-Aware Dispatch

> Replace count-based phase sizing with cohesion-driven boundaries, add monotonic tier ordering within phases, implement per-task dispatch with data-driven resume logic, and ensure cross-file consistency across all 5 PM skill files.

---

## Exploration Summary

### "2-3" count rule locations (to remove/replace)
| File | Line | Text |
|------|------|------|
| `plan-prompt.md` | 27 | "2-3 work tasks per phase, then a VERIFY checkpoint" |
| `plan-prompt.md` | 62 | "Checkpoints too far apart — more than 3 work tasks without a VERIFY?" |
| `plan-prompt.md` | 69 | "VERIFY checkpoint every 2-3 work tasks" |
| `tpl-reviewer-plan.md` | 12 | "2-3 work tasks per phase, then a VERIFY checkpoint?" |

Note: `single-pair-sprint.md:19` has "2-3 line descriptions" — this is about requirements quality, not phase sizing. Leave it.

### Resume logic locations (to update)
| File | Lines | Current behavior |
|------|-------|-----------------|
| `single-pair-sprint.md` | 53–71 | Phase-level dispatch, session rules table |
| `doer-reviewer.md` | 14 | Hardcodes `model=standard` for doers |
| `doer-reviewer.md` | 35–36 | Phase-level doer session rules |
| `doer-reviewer.md` | 56–68 | Resume rule table — manually derived, no phase-number logic |

### What's missing (to add)
- No per-task dispatch algorithm — `single-pair-sprint.md` dispatches per-phase
- No `lastDispatchedPhase` tracking concept in `status.md`
- No monotonic tier constraint anywhere
- No data-driven resume derivation from `planned.json` phase numbers
- `tpl-reviewer-plan.md` has no checklist for cohesion boundaries or tier ordering

---

## Tasks

### Phase 1: Cohesion Rule & Tier Constraint (plan templates)

**Rationale:** These 3 files define how plans are structured and reviewed. They share the phase-sizing data model — changing one without the others creates contradictions.

#### Task 1: Replace count rule with cohesion rule in plan-prompt.md
- **Change:** Remove all 3 instances of the count-based "2-3 tasks per phase" rule. Replace with the cohesion-driven phase boundary definition from requirements.md §1. Update PHASE 1 DRAFT rules (line 27), PHASE 3 SELF-CRITIQUE failure mode (line 62), and PHASE 4 REFINE bullet (line 69).
- **Files:** `skills/pm/plan-prompt.md`
- **Tier:** cheap
- **Done when:** No instance of "2-3 work tasks" or "more than 3 work tasks" remains in the file. The cohesion rule text matches requirements.md §1.
- **Blockers:** None

#### Task 2: Add monotonic tier constraint to plan-prompt.md
- **Change:** Add the monotonically non-decreasing tier ordering rule from requirements.md §2 to the PHASE 1 DRAFT rules section (after the tier assignment block). Include the ✅/❌ examples. Also add a corresponding self-critique check in PHASE 3 ("Tier downgrade mid-phase — does any phase have a cheaper task after a more expensive one?").
- **Files:** `skills/pm/plan-prompt.md`
- **Tier:** cheap
- **Done when:** The monotonic tier constraint with examples appears in DRAFT rules. A tier-ordering failure mode appears in SELF-CRITIQUE.
- **Blockers:** Depends on Task 1 being complete (shared section context)

#### Task 3: Add cohesion rule and monotonic tier constraint to tpl-plan.md
- **Change:** Add a "Phase Sizing Rules" section to the Notes area at the bottom of the template. Include: (a) the cohesion-driven phase boundary definition, (b) the monotonic tier ordering constraint with examples. This ensures doers generating plans from this template see both rules.
- **Files:** `skills/pm/tpl-plan.md`
- **Tier:** cheap
- **Done when:** The Notes section contains both the cohesion rule and the monotonic tier constraint. The wording is consistent with plan-prompt.md (Task 1 & 2).
- **Blockers:** None

#### Task 4: Update tpl-reviewer-plan.md checklist
- **Change:** Replace checklist item 6 ("2-3 work tasks per phase, then a VERIFY checkpoint?") with two new checklist items: (a) "Are phase boundaries drawn at cohesion boundaries — each phase is a coherent unit producing a reviewable, testable increment?" (b) "Are tiers monotonically non-decreasing within each phase (cheap → standard → premium, never downgrading)?"
- **Files:** `skills/pm/tpl-reviewer-plan.md`
- **Tier:** cheap
- **Done when:** Item 6 is replaced. Both new checklist items are present. No reference to "2-3" task count remains.
- **Blockers:** None

#### VERIFY: Phase 1 — Plan Templates
- Confirm: no "2-3 work tasks" count rule survives in any of the 3 files
- Confirm: cohesion rule appears in both `plan-prompt.md` and `tpl-plan.md`
- Confirm: monotonic tier constraint appears in both `plan-prompt.md` and `tpl-plan.md`
- Confirm: `tpl-reviewer-plan.md` has both new checklist items (cohesion + tier)
- Report: any inconsistencies between the 3 files

---

### Phase 2: Per-Task Dispatch & Data-Driven Resume

**Rationale:** These 2 files define the dispatch and resume model. Changing dispatch granularity in one without updating resume logic in the other would create unsafe cross-tier resume scenarios.

#### Task 5: Per-task dispatch algorithm in single-pair-sprint.md
- **Change:** In the Phase 3 Execution section:
  1. Replace the phase-level execution loop (lines 52–59) with the per-task dispatch algorithm from requirements.md §3: read `planned.json` + `progress.json`, find next pending task, extract tier, determine resume from phase comparison with `lastDispatchedPhase`.
  2. Update the Session Rules table (lines 64–71) to reflect per-task dispatch: "Within a phase" row should reference the data-driven rule (`nextTask.phase === lastDispatchedPhase`).
  3. Add `lastDispatchedPhase` tracking to `status.md` — document that PM records it after each dispatch.
  4. Add the data-driven resume rule table from requirements.md §4 (the 4-condition table).
- **Files:** `skills/pm/single-pair-sprint.md`
- **Tier:** standard
- **Done when:** The execution loop shows per-task dispatch (not per-phase). The session rules table uses phase-number comparison. `lastDispatchedPhase` is documented. The 4-condition resume table is present.
- **Blockers:** None

#### Task 6: Data-driven resume and tier-based dispatch in doer-reviewer.md
- **Change:**
  1. Replace the "Model tier check" paragraph (line 14) — remove "Doers use `model=standard` by default unless the task tier specifies otherwise." Replace with: PM reads `tasks[i].tier` from `planned.json` and passes `model: <tier>` to `execute_prompt`. Reviewer dispatches remain `model: premium`.
  2. Update doer session rules (lines 35–36) to reference data-driven resume: replace "Within a phase: resume is allowed" with the phase-number comparison rule (`nextTask.phase === lastDispatchedPhase` → `resume=true`).
  3. Update the Resume Rule table (lines 58–67) to add the data-driven derivation. Add a note explaining that resume is derived from `planned.json` phase numbers, not manually reasoned. Reference `lastDispatchedPhase` from `status.md`.
- **Files:** `skills/pm/doer-reviewer.md`
- **Tier:** standard
- **Done when:** No hardcoded `model=standard` for doers. Resume rule references phase-number comparison. The table includes `lastDispatchedPhase` derivation. Consistent with single-pair-sprint.md (Task 5).
- **Blockers:** Task 5 should be complete first (shared data model for `lastDispatchedPhase`)

#### Task 7: Cross-file consistency sweep
- **Change:** Read all 5 files end-to-end. Check for:
  1. Any surviving "2-3 tasks per phase" count rule (must be zero across all 5 files)
  2. Cohesion rule wording consistency between `plan-prompt.md` and `tpl-plan.md`
  3. Monotonic tier constraint wording consistency between `plan-prompt.md` and `tpl-plan.md`
  4. Resume rule consistency between `single-pair-sprint.md` and `doer-reviewer.md`
  5. `lastDispatchedPhase` referenced consistently wherever dispatch/resume logic appears
  6. No contradictions between any pair of files
  Fix any inconsistencies found.
- **Files:** all 5 — `skills/pm/plan-prompt.md`, `skills/pm/tpl-plan.md`, `skills/pm/tpl-reviewer-plan.md`, `skills/pm/single-pair-sprint.md`, `skills/pm/doer-reviewer.md`
- **Tier:** premium
- **Done when:** All 7 acceptance criteria from requirements.md are met. No contradictions between any pair of files.
- **Blockers:** All prior tasks must be complete

#### VERIFY: Phase 2 — Dispatch & Resume
- Confirm all 7 acceptance criteria from requirements.md
- Confirm no contradictions between any pair of the 5 files
- Report: final state of each file's key changes

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Cohesion rule wording diverges between plan-prompt.md and tpl-plan.md | med | Task 7 consistency sweep catches divergence; reviewer checklist in tpl-reviewer-plan.md enforces it going forward |
| Resume rule table in doer-reviewer.md contradicts single-pair-sprint.md session rules | high | Task 6 explicitly cross-references Task 5's data model; Task 7 validates consistency |
| "2-3" count rule survives in a location not identified during exploration | med | Task 7 does a full grep across all 5 files as final check |
| Monotonic tier constraint is too rigid for edge cases | low | The constraint allows splitting into a new phase — this is documented in the examples |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: main
- Feature branch: feat/tier-aware-dispatch
- Phase 1 tasks are all `cheap` (mechanical text changes in markdown)
- Phase 2 tasks escalate: `standard` for the algorithm changes, `premium` for the cross-file consistency sweep
- Tier ordering within each phase is monotonically non-decreasing (cheap→cheap→cheap→cheap, standard→standard→premium)
