# Plan Review — Issue #204: Compress skill files using caveman mode

**Reviewer:** fleet-rev (automated)
**Date:** 2026-05-01
**Verdict:** **CHANGES NEEDED**

---

## 13-Point Checklist

| # | Item | Result |
|---|------|--------|
| 1 | Plan addresses everything in requirements.md | PASS — all four requirement phases (tooling, compress, risk review, regression) are covered |
| 2 | Phases clearly separated with VERIFY checkpoints | PASS — four phases, each with a VERIFY block |
| 3 | Tiers monotonically non-decreasing | PASS — cheap -> standard -> standard -> standard -> premium -> standard |
| 4 | Each task has a concrete "Done when" criterion | PASS — all six tasks have measurable done-when criteria |
| 5 | Blockers correctly stated | PASS — dependency chain is correct (Task 1 unblocks 2-4; 2-4 unblock 5; 2-5 unblock 6) |
| 6 | Base branch correct | PASS — `main`, matches requirements |
| 7 | File paths accurate / referenced files exist | **FAIL** — see Finding 1 and 2 below |
| 8 | Scope complete — any files missed? | PASS — all 28 .md files accounted for; JSON profiles correctly excluded |
| 9 | Risks identified and mitigated | PASS — five risks with reasonable mitigations |
| 10 | Regression test approach realistic and sufficient | PASS — four representative commands covering key skill files |
| 11 | Implementation details sufficient for a developer | PASS — instructions are clear enough to execute |
| 12 | Commit/branch conventions followed | PASS — one commit per task, branch naming matches conventions |
| 13 | Security concerns | PASS — no security surface; compression of LLM-consumed Markdown only |

---

## Required Changes

### Finding 1: Task 3 — file count is wrong (swapped with Task 4)

**Location:** PLAN.md, Task 3

Task 3 states "Compress `skills/pm/` operational files **(11 files)**" but the actual non-`tpl-` `.md` files in `skills/pm/` are **9**:
`SKILL.md`, `single-pair-sprint.md`, `multi-pair-sprint.md`, `simple-sprint.md`, `doer-reviewer.md`, `cleanup.md`, `init.md`, `context-file.md`, `plan-prompt.md`

This matches the requirements.md listing of 9 operational files. The count "11" appears to have been swapped with Task 4's count.

Additionally, Task 3 mentions `onboarding.md (if present)` — this file does not exist in `skills/pm/` (there is an `onboarding.md` in `skills/fleet/`, already covered by Task 2). Remove the mention to avoid confusion.

**Fix:** Change the count from 11 to 9. Remove the `onboarding.md (if present)` mention. List exactly the 9 files.

### Finding 2: Task 4 — file count is wrong (swapped with Task 3)

**Location:** PLAN.md, Task 4

Task 4 states "Compress all **9** template files" but then lists **11** file names, and there are indeed **11** `tpl-*.md` files on disk:
`tpl-doer.md`, `tpl-reviewer.md`, `tpl-reviewer-plan.md`, `tpl-plan.md`, `tpl-deploy.md`, `tpl-design.md`, `tpl-requirements.md`, `tpl-status.md`, `tpl-backlog.md`, `tpl-projects.md`, `tpl-pm.md`

This matches the requirements.md listing of 11 template files (which the requirements labels as "Templates" under pm/).

**Fix:** Change the count from 9 to 11.

---

## Summary

Two file-count errors in Tasks 3 and 4 — the counts are swapped (11/9 should be 9/11), and Task 3 references a phantom `onboarding.md` in `skills/pm/`. The plan is otherwise well-structured with clear phases, correct blockers, good risk coverage, and a realistic regression test approach. Fix the three items above and this is ready to approve.
