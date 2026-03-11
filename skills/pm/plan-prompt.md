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
- 2-3 work tasks per phase, then a VERIFY checkpoint
- Each task completable in one session, results in one commit
- Tasks ordered so dependencies are satisfied

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
- Checkpoints too far apart — more than 3 work tasks without a VERIFY?

### PHASE 4 — REFINE

Rewrite incorporating critique:
- Move risky/uncertain tasks earlier
- Split vague tasks into specific ones
- VERIFY checkpoint every 2-3 work tasks
- Every task has clear "done" criteria

Output the final plan in tpl-plan.md format.

---
