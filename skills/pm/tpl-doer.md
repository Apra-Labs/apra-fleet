# {{PROJECT_NAME}} - Plan Execution

## Context Recovery
Before starting any work: `git log --oneline -10`

## Execution Model
You are executing a plan defined in PLAN.md. Progress tracked in progress.json.

On each invocation:
1. Read progress.json -- find next task with status "pending"
2. Read PLAN.md -- get full details for that task
3. Execute -- write code, run tests, fix issues
4. Commit with descriptive message referencing the task ID
5. Update progress.json -- set task to "completed", add notes
6. Continue to next pending task

## Verify Checkpoints
Tasks with type "verify" are checkpoints. When you reach one:
1. Run the project build step (e.g. `npm run build`, `tsc`, `cargo build`) and linter check (e.g. `npm run lint`, `eslint`, `cargo clippy` if configured) first, then run the full test suite (unit, integration, e2e). All of them must pass.
2. Confirm all prior tasks in the group work correctly
3. Update progress.json with test results and issues found
4. `git push origin {{branch}}` - code must be on origin before PM reviews
5. STOP - do not continue. Report status so the PM can review.

## Branch Hygiene
- Before creating a branch: `git fetch origin && git checkout origin/{{base_branch}}`
- Before pushing a PR or at PM's request: `git fetch origin && git rebase origin/{{base_branch}}`, rerun tests after rebase

## Secrets & API Keys

If this task requires secrets, API keys, or tokens (e.g., external API calls, private registry pushes, third-party service authentication), check whether the PM has pre-loaded them via the credential store before you start. Use `{{secure.NAME}}` tokens only in `execute_command` -- never in prompts or log messages. Fleet resolves and redacts them automatically in commands. Do not ask for raw secret values in conversation; if a required `sec://NAME` handle is missing, report it as a blocker so the PM can store it OOB.

## Rules
- ONE task at a time, then commit, then continue
- After every commit: run fast/unit tests and linter checks. If they fail, fix before moving to the next task.
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks - execute in order
- Read PLAN.md before starting each task
- Commit and push PLAN.md, progress.json, and all project docs (design.md, feedback-*.md) at every turn - reviewers depend on them
- NEVER commit this agent context file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT.md / AGY.md) - it is role-specific and not shared
- NEVER push to the base branch (main, master, or integration branch) - always work on feature branches
- NEVER stage or commit `.fleet-task.md` - these are ephemeral prompt delivery files managed by the fleet server

## Knowledge Bank

- Start of session: run `kb_session_prime` with the files and symbols from your first task.
  Read every entry in `top_entries` -- these are prior learnings about this codebase from
  previous sprints. Read stale files it returns. Dispatch all `recommended_code_calls`.

- Retrieve first, then read source: before reading an unfamiliar file or function,
  run `kb_query({ query: "<name>" })` first. If the KB returns a CONFIRMED or INFERRED
  entry, trust it and work from it -- skip the full source read. Only read source if KB
  is cold (no entry), stale, or the entry says "see source for details."
  This avoids re-reading files that prior agents have already summarized.

- During work: use fleet code intelligence tools (code_graph, code_impact, code_query,
  code_context) for structural questions -- never plain-read files for call graph or
  symbol lookup. Do NOT call kb_capture yourself -- the KB Agent handles all capturing
  after your session ends. Your KB role is retrieval only.

- You do not need to call `kb_harvest` yourself -- it has no session transcript to work
  from and is a no-op when called without one. The fleet auto-dispatches it with your
  full transcript after your session ends (a separate, low-trust path that produces
  UNVERIFIED entries). The KB Agent runs after the reviewer and captures directly from
  your session output and the reviewer's verdict -- that is the primary path.

- If a KB entry you retrieved proves wrong in practice, call kb_feedback with the entry
  id and what was wrong.
