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

### Capture at discovery time

Planning involves exploring the codebase before a single task exists to attribute a
discovery to -- do not let that exploration evaporate. When you discover something
durable and non-obvious while reading requirements.md/design.md or exploring code for
model assignment -- a coding convention, a structural pattern, an architectural
constraint, a gotcha -- call `kb_capture` on it IMMEDIATELY (type `knowledge` or
`learning`, role hint `planner`). The trust clamp caps in-flight captures at INFERRED;
the KB Agent promotes to CONFIRMED whatever the reviewer later validates. Do not wait
for harvest -- a discovery not captured in-flight is lost. Before each capture, run
`kb_query` to dedupe -- skip if an equivalent entry already exists. Only durable,
non-obvious findings qualify (no task logs, no obvious facts); one concern per entry;
cite real symbols and source_files. Tag every in-flight capture with
`['sprint:<sprint-name>', 'phase:<n>']` (phase is the phase the finding is relevant to,
typically the first phase that touches the symbol) so the KB Agent can find and curate
these captures once that phase is reviewed.

### Quantitative model assignment (F10, D9)

After `kb_session_prime`, call `kb_stats` with the plan's key symbols (the
symbols the sprint's tasks will actually touch) and use the returned
`coverage.fraction` to sharpen the qualitative judgment above into a number:

- coverage >= 0.8 -> lean cheap/standard for tasks on those symbols
  (well-understood, low reasoning risk).
- coverage < 0.3 -> lean premium and front-load the risk (Task 1) --
  unexplored territory.
- between 0.3 and 0.8 -> judgment call; weigh the qualitative KB signals above
  (non-obvious constraints, contradiction flags) alongside the number.

**PLAN.md's model rationale MUST cite the coverage number** (e.g. "coverage
0.85 across {symbols} -> claude-sonnet-4-6"), not just a qualitative
impression.

**Fallback:** if `kb_stats` is unavailable (tool error, not yet built in this
sprint, or the KB has no symbols yet), record coverage qualitatively instead
in a "Planning context" section of PLAN.md -- state explicitly that the
quantitative trial was skipped and why, so the citation requirement is still
honestly satisfied.

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

Quantify this with `kb_stats` coverage per the numbered thresholds above
(>= 0.8 cheap/standard, < 0.3 premium + front-load, between is judgment) --
cite the coverage number in the rationale, don't just eyeball `top_entries`.

### Front-loading

The riskiest, most ambiguous task must be Task 1. Do not defer risk to later phases.

### Self-critique before committing

Re-read PLAN.md. Check:
- Every task has an assigned model
- A VERIFY checkpoint exists at the end
- Task 1 is the riskiest
- KB-derived facts appear in task descriptions where relevant
- No task spans more than one concern
- The model rationale cites the `kb_stats` coverage number (or, if `kb_stats`
  was unavailable, a qualitative "Planning context" section explains why)

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
