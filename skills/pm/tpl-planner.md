# {{PROJECT_NAME}} - Plan Generation

## Context Recovery
Before planning: `git log --oneline -5`

## Knowledge Bank (read BEFORE writing any plan)

Call `kb_session_prime` with `hint_symbols` and `hint_modules` derived from
requirements.md (skim it first to extract key symbol names and module areas).

Read every entry in `top_entries`. Let prior sprint knowledge inform your planning:

- **CONFIRMED coverage** on a symbol -> well-understood code, may use a lighter model.
  Include a note in the task description so the doer knows to retrieve from KB first.
- **No KB entries** for a symbol -> unexplored territory, front-load as Task 1,
  assign a stronger model.
- **Non-obvious constraints** in KB entries (e.g. "init() must be called before query",
  "jitter applied after maxDelayMs cap") -> copy them verbatim into the relevant task
  description so the doer does not rediscover them.

If the KB is empty (first sprint on this repo), skip and proceed normally.

## Code Intelligence (use while planning)

For symbol lookups, call chain tracing, and impact analysis while planning,
use the fleet code intelligence tools (code_graph, code_impact, code_query,
code_context) -- e.g. code_query to locate an implementation you are about
to write tasks against, code_context to see its callers and flows. Never
use Glob/Grep or file reads for structural questions -- the answer is
pre-indexed.

## Planning Model

You are producing PLAN.md for a sprint. Read requirements.md and design.md (if present).

### Task structure

For each task:
- `id`: T1, T2, ... in execution order
- `title`: one short line
- `description`: full detail -- what to build, exact behaviours, edge cases to handle.
  Include any relevant KB facts here.
- `done criteria`: precise, testable conditions
- `model`: exact model ID to run this task on

One VERIFY task at the end of each phase (type: verify). The VERIFY task runs
lint + full test suite and pushes the branch -- it has no model assignment.

### Model assignment rules

| Task complexity | Model tier |
|---|---|
| Mechanical (rename, config, 2-line barrel) | cheap (claude-haiku-4-5) |
| Typical implementation (new function, test suite) | standard (claude-sonnet-4-6) |
| High-ambiguity design, multi-file reasoning | premium (claude-opus-4-8) |

Symbols with CONFIRMED KB coverage -> lean toward standard or cheap (well-understood).
Symbols with no KB entries -> lean toward premium (unknown territory).

### Front-loading

The riskiest, most ambiguous task must be Task 1. Do not defer risk to later phases.

### Self-critique before committing

Re-read PLAN.md. Check:
- Every task has an assigned model
- A VERIFY checkpoint exists at the end
- Task 1 is the riskiest
- KB-derived facts appear in task descriptions where relevant
- No task spans more than one concern

## Output

Write PLAN.md and commit:
```
git -c user.name='pm-planner' -c user.email='planner@pm.local' commit -m "chore(pm): add sprint plan"
```

Push: `git push origin {{branch}}`

## Rules
- NEVER commit this context file (CLAUDE.md)
- NEVER push to the base branch ({{base_branch}})
- The worktree and branch already exist -- do not create branches
