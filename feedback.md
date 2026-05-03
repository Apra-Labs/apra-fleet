# Review: feat/pm-beads-integration

**Verdict: APPROVE with required fixes**

The Beads integration is well-designed — lifecycle hooks are coherent, the cross-sprint recovery story is a clear improvement over file-only tracking, and `beads.md` is thorough. Two issues must be fixed before merge; the rest are minor.

---

## Must Fix

### 1. `init.md` — duplicate step 4
Step 4 ("Add project row to projects.md") appears twice (lines 14 and 16). The second occurrence is a copy-paste artifact from the diff. Delete the duplicate so the numbering reads 1–2–3–4–5.

### 2. `SKILL.md` — encoding artifact on Timeouts row
The last line of the Multi-Provider table has a replacement character (`�`) in both main and this branch. While not introduced by this PR, the diff touches the line — clean it up: replace `slower � use` with `slower — use` (em-dash).

---

## Observations (non-blocking)

### beads.md
- Self-contained and well-structured. All `bd` commands (`init`, `create`, `update`, `dep add`, `show`, `ready`) follow a consistent CLI pattern.
- `bd create ... --parent <epic-id>` and `bd update <id> --note "..."` are used but not listed in the "Essential Commands" quick-reference table. Consider adding them for completeness.
- `bd ready --all` is used in the backlog grooming section but also absent from the quick-reference. Minor — the doc is still clear.

### Lifecycle coherence
The end-to-end flow is coherent:
- **init** → `bd init` + epic create → epic-id recorded in status.md ✓
- **plan** → one `bd create` per task + `bd dep add` for ordering ✓
- **dispatch** → `bd update --claim` ✓
- **verify** → `bd update --done` ✓
- **review findings** → `bd create` per HIGH finding, closed on fix ✓
- **cleanup** → close epic *before* PR raise ✓ (correct ordering)

### SKILL.md ↔ beads.md consistency
- `/pm backlog` and `/pm tasks` commands in SKILL.md match beads.md descriptions. ✓
- Session start rule ("run `bd ready` before opening any `status.md`") is stated in both SKILL.md and beads.md. ✓
- `/pm recover` correctly references `bd ready` first, then member inspection. ✓

### single-pair-sprint.md
- Beads steps are inserted at the right lifecycle points without disrupting the existing flow. ✓
- Phase 2 renumbering (step 6 → Beads push, step 7 → proceed) is correct. ✓
- Recovery section correctly prioritizes `bd ready` over `fleet_status`. ✓
- Deferred items are dual-tracked (backlog.md + Beads low-priority task) — intentional redundancy for the transition period. Fine.

### cleanup.md
- Ordering is correct: close epic → raise PR → link PR → verify CI. ✓
- The `--note` for PR linking is a nice touch for audit trail.

---

## Summary

The integration is solid. `beads.md` is the single source of truth for `bd` usage, the lifecycle hooks are enforced at every phase boundary, and cross-sprint recovery via `bd ready` is a meaningful UX improvement. Fix the duplicate step in `init.md` and the encoding artifact, then this is ready to merge.
