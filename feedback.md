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
| 3 | Tiers monotonically non-decreasing | **FAIL** — Phase 3 (Task 5) is premium, Phase 4 (Task 6) drops to standard |
| 4 | Each task has a concrete "Done when" criterion | PASS — all six tasks have measurable done-when criteria |
| 5 | Blockers correctly stated | PASS — dependency chain is correct (Task 1 unblocks 2-4; 2-4 unblock 5; 2-5 unblock 6) |
| 6 | Base branch correct | PASS — `main`, matches requirements |
| 7 | File paths accurate / referenced files exist | **FAIL** — see Findings 1 and 2 below |
| 8 | Scope complete — any files missed? | PASS — all 28 .md files accounted for; JSON profiles correctly excluded |
| 9 | Risks identified and mitigated | PASS — five risks with reasonable mitigations |
| 10 | Regression test approach realistic and sufficient | PASS — four representative commands covering key skill files |
| 11 | Implementation details sufficient for a developer | PASS — instructions are clear enough to execute |
| 12 | Commit/branch conventions followed | **FAIL** — no implementation branch name specified (repo convention requires `feat/<topic>` or `fix/<topic>`) |
| 13 | Security concerns | PASS — no security surface; compression of LLM-consumed Markdown only |

---

## Required Changes

### 1. Fix tier monotonicity (checklist #3)

**Location:** PLAN.md, Phase 4 / Task 6

Task 5 (risk review) is tier `premium` but Task 6 (regression test) drops back to `standard`. Tiers must be non-decreasing within the plan. Either promote Task 6 to `premium`, or demote Task 5 to `standard`.

### 2. Fix file count in Task 3 (checklist #7)

**Location:** PLAN.md, Task 3

Task 3 states "11 non-template operational files" but there are only **9** non-`tpl-` `.md` files in `skills/pm/`:
`SKILL.md`, `single-pair-sprint.md`, `multi-pair-sprint.md`, `simple-sprint.md`, `doer-reviewer.md`, `cleanup.md`, `init.md`, `context-file.md`, `plan-prompt.md`

Additionally, Task 3 mentions `onboarding.md (if present)` — this file does not exist in `skills/pm/`. Remove the mention.

**Fix:** Change the count from 11 to 9. Remove the phantom `onboarding.md` reference. List exactly the 9 files.

### 3. Fix file count in Task 4 (checklist #7)

**Location:** PLAN.md, Task 4

Task 4 states "9 template files" but then lists **11** names, and there are 11 `tpl-*.md` files on disk. The count and the listing are inconsistent.

**Fix:** Change the count from 9 to 11.

### 4. Specify implementation branch name (checklist #12)

**Location:** PLAN.md, Notes section

The plan says "Base branch: `main`" but does not specify the working branch name. Per repo conventions (`feat/<topic>`, `fix/<topic>`, `chore/<topic>`), add the implementation branch name — e.g. `feat/compress-skills`.

---

## Summary

Four issues found: a tier monotonicity violation, two swapped file counts (9/11), and a missing branch name. The plan is otherwise well-structured with clear phases, correct blockers, good risk coverage, and a realistic regression test. Fix the items above and this is ready to approve.
