# Plan Generation Prompt

Send this to the member (via `execute_prompt`) before writing any plan:

---

You are generating an implementation plan. Read requirements.md for what needs to be built.

### PHASE 0 — EXPLORE (before writing any plan)

1. Read relevant source files for this task
2. Read existing tests — understand conventions and framework
3. `git log --oneline -20` — recent changes in the area
4. List assumptions about how the code works
5. Verify each assumption by reading actual code
6. Report: what you found, what patterns exist, what constraints matter

### PHASE 1 — DRAFT

For each task include:
- What file(s) to create or change
- What the change does — specific, not vague ("add X method to Y class" not "implement feature")
- What "done" means — test passes, output appears, API returns expected response
- What could block — missing dependency, unclear API, native code issue

Rules:
- **Phase boundaries by cohesion, not count** — a phase is a coherent unit of work that produces a reviewable, testable increment. Group tasks into a phase when they share a data model, code path, or design decision — splitting them would produce an incoherent intermediate state or require touching the same code twice. Place a VERIFY at the natural completion boundary of that unit, not at an arbitrary task count. Phases may have 4-5 tasks (a coherent subsystem) or just 1-2 (a genuinely isolated change).
- Each task completable in one session, results in one commit
- Tasks ordered so dependencies are satisfied
- **Model tier assignment:** Assign a tier (`cheap`, `standard`, or `premium`) to every work task based on complexity:
  - `cheap` — mechanical changes with no ambiguity (rename, move, simple config edit)
  - `standard` — typical implementation work (new function, test suite, moderate refactor)
  - `premium` — high-ambiguity design tasks, architectural decisions, or tasks requiring deep multi-file reasoning
  - Write the tier into the task entry in PLAN.md (e.g. `- **Tier:** standard`)
  - When the PM creates progress.json from the plan, it copies each task's tier into `tasks[i].tier`
  - During dispatch, the PM reads `tasks[i].tier` and passes `model: <tier>` to `execute_prompt` for doer dispatches
  - **Constraint:** Reviewer dispatches always use `model: premium` regardless of the task tier — this is not configurable by the planner

### PHASE 2 — FRONT-LOAD FOUNDATIONS

Two things go first:
1. Key abstractions and shared interfaces — later tasks build on these. If the foundation is wrong, everything above it is wasted.
2. Riskiest assumption — the thing that, if it doesn't work, invalidates everything else.

Later tasks MUST follow DRY — reuse the abstractions from early tasks, never reinvent. If two tasks duplicate logic, the plan is sliced wrong.

Examples: "Does the native addon run a pipeline?" — Task 1, not Task 15. "Define the shared auth interface" — Task 1, not scattered across 5 tasks.

### PHASE 3 — SELF-CRITIQUE

Golden rule: high cohesion within each task, low coupling between tasks. If a task needs the whole project to make sense, it's sliced wrong.

Check your draft against these failure modes:
- Low cohesion — does this task touch unrelated areas? Split by component boundary.
- High coupling — does task N depend heavily on task M's internals? Decouple via interfaces.
- Vague task — could two developers interpret this differently?
- Too large — more than ~50 tool calls? Split it.
- Hidden dependency — does task N assume something from task M that isn't explicit?
- Late verification — 5+ tasks before checking if the approach works?
- Wrong ordering — could the riskiest assumption be validated earlier?
- Missing "done" criteria — how does the member know the task is complete?
- Phase boundary at wrong place — does this phase mix unrelated subsystems that could be reviewed independently? Or does it split a cohesive unit across two phases?

### PHASE 4 — REFINE

Rewrite incorporating critique:
- Move risky/uncertain tasks earlier
- Split vague tasks into specific ones
- VERIFY checkpoint at the natural completion boundary of each cohesive phase
- Every task has clear "done" criteria

### PHASE 5 — BRANCH & COMMIT

1. Read requirements.md for the base branch (default: `main`)
2. `git fetch origin && git checkout -b <feature-branch> origin/<base-branch>`
3. Commit the plan files to the feature branch — NEVER commit to the base branch
4. `git push -u origin <feature-branch>`

Output the final plan in tpl-plan.md format.

---
