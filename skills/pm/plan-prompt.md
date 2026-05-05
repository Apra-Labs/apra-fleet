# Plan Generation Prompt

Send to member via `execute_prompt`.

---

Generating implementation plan. Read `requirements.md`.

### PHASE 0 — EXPLORE

1. Read source files.
2. Read tests (conventions/framework).
3. `git log --oneline -20`.
4. List assumptions.
5. Verify assumptions:
   - **Existence**: does dependency exist?
   - **Accessibility**: can it be reached?
   Unverified assumptions → risk register.
6. Report findings, patterns, constraints.

### PHASE 1 — DRAFT

For each task:
- Files to create/change.
- Specific change ("add X to Y" not "implement").
- Definition of "done" (test pass, API response).
- Blockers.

Rules:
- **Phase boundaries by cohesion**: group tasks sharing data model/code path. VERIFY at natural completion. Phases: 1-5 tasks.
- Task = 1 session, 1 commit.
- Order by dependency.
- **Model tiers**: assign `cheap` (mechanical), `standard` (typical), or `premium` (complex/design) to every task.
  - PM reads `tasks[i].tier` for dispatch.
  - Reviewer dispatches always `premium`.
- **Plan = elaboration**: resolve all ambiguity. Be precise.
- **Monotonically non-decreasing tiers in phase**: `cheap → standard → premium → VERIFY`. Downgrade? split phase. Cross-phase order doesn't matter.

### PHASE 2 — FRONT-LOAD FOUNDATIONS

1. Key abstractions/interfaces.
2. Riskiest assumption.
DRY: reuse abstractions.

### PHASE 3 — SELF-CRITIQUE

Goal: high cohesion, low coupling.
Check failure modes:
- Low cohesion (touches unrelated areas).
- High coupling (depends on internals).
- Vague tasks.
- Too large (>50 tool calls).
- Hidden dependencies.
- Late verification.
- Missing "done" criteria.
- Wrong phase boundary.
- Untracked work (hidden prerequisites).
- Missing blockers.
- Tier downgrade in phase.

### PHASE 4 — REFINE

- Move risk/uncertainty earlier.
- Split vague tasks.
- VERIFY at cohesive completion boundaries.

### PHASE 5 — BRANCH & COMMIT

1. Get base branch from `requirements.md` (default `main`).
2. `git fetch origin && git checkout -b <branch> origin/<base>`.
3. Commit plan files to branch. **Never commit to base**.
4. `git push -u origin <branch>`.

Output in `tpl-plan.md` format.
