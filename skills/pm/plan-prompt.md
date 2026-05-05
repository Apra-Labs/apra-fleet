# Plan Generation Prompt

Send this to the member via `execute_prompt` before writing a plan:

---

You are generating an implementation plan. Read `requirements.md` for build specifications.

### PHASE 0 — EXPLORE (before writing plan)

1. Read relevant source files for this task.
2. Read existing tests to understand conventions and framework.
3. `git log --oneline -20` — review recent changes in the area.
4. List assumptions regarding code functionality.
5. For every assumption, answer: "How do I know this is currently true?" Then verify it.
   Check two categories:
   - **Existence:** Does the component you are building on actually exist? (e.g., entity, interface, resource, or path).
   - **Accessibility:** Can the system part that needs it actually reach it? (e.g., exposed, connected, permitted).
   Unverified assumptions become risk register entries, not task preconditions.
6. Report findings, patterns, and constraints.

### PHASE 1 — DRAFT

For each task include:
- Files to create or change.
- Description of the change (specific, e.g., "add X method to Y class").
- Definition of "done" (test passes, output appears, API returns expected response).
- Potential blockers (missing dependency, unclear API, native code issue).

Rules:
- **Phase boundaries by cohesion:** A phase is a coherent unit of work producing a reviewable, testable increment. Group tasks sharing a data model, code path, or design decision. Place a VERIFY at the natural completion boundary. Phases may have 1-5 tasks.
- Each task must be completable in one session and result in one commit.
- Order tasks to satisfy dependencies.
- **Model tier assignment:** Assign a tier (`cheap`, `standard`, or `premium`) to every work task based on complexity:
  - `cheap`: mechanical changes without ambiguity (rename, move, simple config edit).
  - `standard`: typical implementation work (new function, test suite, moderate refactor).
  - `premium`: high-ambiguity design tasks, architectural decisions, or deep multi-file reasoning.
  - Record the tier in the task entry in `PLAN.md` (e.g., `- **Tier:** standard`).
  - The PM copies each task's tier into `progress.json`.
  - During dispatch, the PM passes `model: <tier>` to `execute_prompt`.
  - **Constraint:** Reviewer dispatches always use `model: premium`.
- **The plan is the elaboration:** `requirements.md` uses terse language with intentional ambiguity. `PLAN.md` must resolve that ambiguity — specify every edge case and behavior. Precise acceptance criteria are required.
- **Monotonically non-decreasing tiers within a phase:** Order tasks `cheap` → `standard` → `premium` within a phase. The PM resumes the session across tasks in a phase. Tier transitions trigger a new dispatch. Split the phase if a dependency forces a higher-tier task before a lower-tier task.

### PHASE 2 — FRONT-LOAD FOUNDATIONS

1. Key abstractions and shared interfaces: later tasks build on these.
2. Riskiest assumption: validate first to avoid invalidating subsequent work.

Follow DRY: reuse abstractions from early tasks. Avoid duplicating logic across tasks.

### PHASE 3 — SELF-CRITIQUE

Rule: high cohesion within tasks, low coupling between tasks.

Check draft for these failure modes:
- Low cohesion: task touches unrelated areas? Split by component boundary.
- High coupling: task N depends heavily on task M internals? Decouple via interfaces.
- Vague task: could two developers interpret this differently?
- Too large: more than ~50 tool calls? Split it.
- Hidden dependency: task N assumes something from task M that is not explicit?
- Late verification: 5+ tasks before checking approach?
- Wrong ordering: validate riskiest assumption earlier?
- Missing "done" criteria: how is completeness verified?
- Phase boundary at wrong place: does phase mix unrelated subsystems or split a cohesive unit?
- Untracked work: ensure every change mentioned in descriptions has a corresponding task.
- Missing blocker: list dependencies in Blockers, even if phase order implies them.
- Tier downgrade: split phase or reorder tasks if tier decreases within a phase.

### PHASE 4 — REFINE

Rewrite incorporating critique:
- Move risky tasks earlier.
- Split vague tasks.
- VERIFY checkpoint at natural completion boundaries.
- Clear "done" criteria for every task.

### PHASE 5 — BRANCH & COMMIT

1. Read `requirements.md` for base branch.
2. `git fetch origin && git checkout -b <feature-branch> origin/<base-branch>`
3. Commit plan files to feature branch — do not commit to base branch.
4. `git push -u origin <feature-branch>`

Output final plan in `tpl-plan.md` format.

---
