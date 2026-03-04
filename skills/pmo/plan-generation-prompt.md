# Plan Generation Prompt Template

Use this prompt when generating implementation plans for fleet agents. The goal is to produce high-quality PLAN.md + progress.json files that an agent can execute autonomously.

## The Prompt

Send this to the agent (via `execute_prompt`) before writing any plan:

---

You are generating an implementation plan for: {{REQUIREMENT}}

### PHASE 0 — EXPLORE (do this before writing any plan)

1. Read the relevant source files for this task
2. Read existing tests to understand conventions and test framework
3. Check `git log --oneline -20` for recent changes in the area
4. List your assumptions about how the code works
5. Verify each assumption by reading the actual code
6. Report back: what you found, what patterns exist, what constraints matter

### PHASE 1 — DRAFT PLAN

Write tasks organized by phases. For each task include:
- **What file(s)** to create or change
- **What the change does** (specific, not vague — "add X method to Y class" not "implement feature")
- **What "done" means** (test passes, output appears, API returns expected response)
- **What could block** this task (missing dependency, unclear API, native code issue)

Rules:
- 2-3 work tasks per phase, followed by a VERIFY checkpoint
- Each task should be completable in one agent session
- Each task results in one git commit
- Tasks must be ordered so dependencies are satisfied

### PHASE 2 — SELF-CRITIQUE

Review your draft plan against these failure modes:

| Failure Mode | Check |
|---|---|
| **Vague task** | Could two developers interpret this differently? If yes, be more specific. |
| **Too large** | Will this take more than ~50 tool calls? If yes, split it. |
| **Hidden dependency** | Does task N assume something from task M that isn't explicit? |
| **Late verification** | Are we building 5+ tasks before checking if the approach works? |
| **Wrong ordering** | Could we validate the riskiest assumption earlier? |
| **Missing "done" criteria** | How does the agent know the task is complete? |
| **Checkpoint too far apart** | More than 3 work tasks without a VERIFY? |

### PHASE 3 — FRONT-LOAD RISK

Answer: **What is the single thing that, if it doesn't work, invalidates everything else?**

That should be Task 1 (or as early as possible). Examples from past plans:
- "Does the native addon actually run a pipeline?" → should be Task 1, not Task 15
- "Can we connect to the Slack API with this token?" → should be Task 1, not Task 5
- "Does the GitHub App key work?" → should be Task 1

### PHASE 4 — REFINE

Rewrite the plan incorporating your critique:
- Move risky/uncertain tasks earlier
- Split vague tasks into specific ones
- Add verify checkpoints every 2-3 work tasks
- Ensure each task has clear "done" criteria

Output the final plan in the PLAN.md format (see template).

---

## After Receiving the Plan

The PMO should:
1. Review the plan for quality (use the critique checklist above)
2. Generate progress.json from the task list
3. Save a local copy as **planned.json** (immutable original — "what I asked you to do")
4. Generate CLAUDE.md from the template
5. Push all 3 files to the agent's work_folder (agent's copy stays **progress.json** — the living state it updates)
6. Add CLAUDE.md, PLAN.md, progress.json to agent's .gitignore
7. Kick off execution with `execute_prompt`

## Examples of Good Plans

### Example 1: ApraPipes E2E Tests (12 tasks, 4 phases)
- Phase 1: Test infrastructure (Playwright install, config, helpers) → VERIFY
- Phase 2: Pipeline load & run (API test, status transitions) → VERIFY
- Phase 3: Logs verification (log entries, filtering) → VERIFY
- Phase 4: Error cases & polish (bad pipeline, reconnection) → VERIFY
- **Risk front-loaded**: Phase 1 verified the test infrastructure works before writing real tests

### Example 2: Git Auth Tools (tasks from brainstorm to deployment)
- Phase 1: Core services (git-config.ts, github-app.ts) → tests
- Phase 2: setup_git_app tool → tests → VERIFY
- Phase 3: provision_vcs_auth tool → tests → VERIFY
- Phase 4: Security audit fixes → docs → deploy
- **Risk front-loaded**: JWT creation and API verification tested before building the full tool

### Example 3: Pipeline Debug & Logs View (17 tasks, 4 phases)
- Phase 1: Server log infrastructure (EventEmitter, MetricsStream)
- Phase 2: Client log panel (React components, WebSocket)
- Phase 3: Integration (connect server→client, status bar)
- Phase 4: Polish (filtering, persistence, error handling)
- **Lesson learned**: Risk was NOT front-loaded. The native addon `play()` bug wasn't discovered until task 15. Should have tested "does the pipeline actually run?" as Task 1.
