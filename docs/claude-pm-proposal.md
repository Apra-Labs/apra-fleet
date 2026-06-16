# claude-pm: Claude-native Sprint Workflow

> A proposed replacement for the pm-lite orchestrator model with a deterministic
> Workflow-driven execution engine. Orchestration tokens drop to near zero; beads
> becomes the DAG store and progress tracker; VERIFY becomes an automated
> reviewer checkpoint injected into the live task graph.

## Motivation

pm-lite today uses a reasoning model as the sprint orchestrator. It reads PLAN.md,
decides which tasks to run next, tracks what is done, and decides when to VERIFY.
This costs 40-80K output tokens per sprint just for coordination reasoning -- not
for actual work.

Claude Code's Workflow primitive changes the economics: control flow (while-loops,
parallel fan-out, conditional VERIFY) is free JavaScript executed by the harness.
Only the agents doing real work (planner, doers, reviewers) spend tokens.

Beads already stores a dependency graph natively (`bd dep add`, `bd ready`). Using
it as the DAG store means `bd ready` replaces all orchestrator reasoning about
"what runs next" -- a shell command, zero tokens, correct by construction.

---

## Architecture

```
args: { requirements, base_branch, verify_every }
         |
    PLAN phase (loop until APPROVED)
    - opus planner -> bd create + bd dep add (DAG in beads)
    - haiku executes the bd_commands shell script
    - sonnet plan-reviewer reads bd list/show, approves or rejects
    - haiku wipes issues on rejection, planner retries
         |
    EXECUTE phase (wave loop -- zero orchestration tokens)
    - haiku: bd ready -> ready task list
    - parallel() doers per wave, each isolation:worktree
      - doer claims task (bd update --claim)
      - implements, tests, commits
      - closes task (bd close)
      - outputs BRANCH:<name>
    - every N waves: sonnet VERIFY reviewer
      - reads bd state + git diff summary
      - if issues: bd create fix-tasks (auto-appear in next bd ready)
      - if approved: next wave proceeds
    - haiku: bd list --status=open | wc -l -> repeat until 0
         |
    REVIEW phase
    - opus final review (git diff + bd closed list)
    - if issues: bd create fix-tasks -> re-enter execute loop
         |
    HARVEST phase
    - sonnet: PR creation
    - haiku: bd dolt push + git worktree cleanup
```

---

## Phase Details

### Plan phase

The planner (opus) reads the sprint requirements from `args.requirements` and
produces a beads issue set representing the full task graph. It outputs a shell
script (`bd_commands`) that a haiku agent runs to create all issues and wire
dependencies.

**Planner structured output schema** (sprint metadata only -- task list lives in beads):

```javascript
const SPRINT_SCHEMA = {
  type: 'object',
  required: ['sprint_label', 'task_count', 'rationale', 'bd_commands'],
  properties: {
    sprint_label:  { type: 'string' },   // e.g. "feat/opencode-model-validation"
    task_count:    { type: 'number' },
    rationale:     { type: 'string' },   // why this task split was chosen
    bd_commands:   { type: 'string' },   // shell script: bd create + bd dep add calls
  }
};
```

The task list itself is NOT in the schema -- it lives in beads after the shell
script runs. This is the clean boundary: planner writes the graph, beads stores it.

**Model tier encoding:** The planner encodes the model tier inside the beads task
description as a tag: `[tier:standard]`. A `resolveModel()` helper in the Workflow
script reads it:

```javascript
function resolveModel(description) {
  const match = description.match(/\[tier:(cheap|standard|premium)\]/);
  const tier = match ? match[1] : 'standard';
  return { cheap: 'haiku', standard: 'sonnet', premium: 'opus' }[tier];
}
```

No separate data structure needed. The tier travels with the task through beads.

**Plan-review loop:** A sonnet reviewer reads all beads issues (`bd list`, `bd show`)
and approves or requests changes. On rejection, haiku closes all open sprint issues
and the planner retries with the reviewer's feedback. Capped at 3 rounds.

---

### Execute phase

The execute phase is a while-loop in the Workflow script. Zero orchestration tokens.

```javascript
let waveNum = 0;
while (true) {
  // Read unblocked tasks from beads
  const readyOutput = await agent(
    'Run: bd ready --format=text. Return the raw output exactly.',
    { model: 'haiku', label: 'bd-ready', phase: 'Execute' }
  );
  const readyTasks = parseBeadsTasks(readyOutput);
  if (readyTasks.length === 0) break;  // all done

  // Run wave in parallel, one doer per task, each in an isolated worktree
  await parallel(readyTasks.map(task => () =>
    agent(
      `Task: ${task.title}\n\n${task.description}\n\n` +
      `Claim this task first: bd update ${task.id} --claim\n` +
      `After committing all changes, close it: bd close ${task.id}\n` +
      `Output your branch name on the last line as: BRANCH:<name>`,
      { model: resolveModel(task.description), isolation: 'worktree',
        label: `doer:${task.id}`, phase: 'Execute' }
    )
  ));

  waveNum++;

  // VERIFY checkpoint every N waves
  if (waveNum % args.verify_every === 0) {
    const verify = await agent(
      `VERIFY checkpoint after wave ${waveNum}.\n` +
      `Requirements: ${args.requirements}\n` +
      `Run bd list --status=closed and bd list --status=open to see sprint state.\n` +
      `Review completed work. If issues found, create fix tasks:\n` +
      `  bd create --title="Fix: <issue>" --description="[tier:standard] <detail>"\n` +
      `  bd dep add <fix-task> <affected-closed-task>\n` +
      `Output APPROVED or CHANGES NEEDED with rationale.`,
      { model: 'sonnet', label: `verify-w${waveNum}`, phase: 'Execute' }
    );
    log(`VERIFY wave ${waveNum}: ${verify.includes('APPROVED') ? 'APPROVED' : 'fix tasks injected'}`);
    // No special handling needed -- fix tasks appear in next bd ready automatically
  }
}
```

**Key properties of this loop:**

- `bd ready` is the only source of truth for what runs next. It respects all
  dependencies including fix tasks injected mid-sprint by VERIFY.
- Each doer runs in an isolated worktree (`isolation: 'worktree'`). No file conflicts.
- The VERIFY reviewer injects fix tasks directly into beads. They appear in the next
  `bd ready` call with no special-case code in the execute loop.
- Abandoned in-progress tasks (from a crash) can be reset: `bd update <id> --status=open`.

---

### VERIFY checkpoint

VERIFY is an automated reviewer checkpoint, not a human gate. It fires every N waves
(configurable via `args.verify_every`, default 1). Purpose: course-correct the doer
before it goes too far in the wrong direction.

The VERIFY agent:
1. Reads `bd list --status=closed` (completed tasks this sprint)
2. Reads `bd list --status=open` (remaining tasks)
3. Reviews the actual code changes (git diff or summary from doer output)
4. If issues found: creates fix tasks with `bd create + bd dep add` pointing to
   the affected task as a dependency
5. Outputs APPROVED or CHANGES NEEDED

Fix tasks appear naturally in the next `bd ready` wave. The execute loop does not
need to know VERIFY happened.

---

### Review phase

After all tasks are closed, a full opus review runs against the complete diff.

```javascript
phase('Review');
const review = await agent(
  `Final review of sprint.\nRequirements: ${args.requirements}\n` +
  `Run bd list --status=closed to see all completed tasks.\n` +
  `Review the implementation. If issues: create fix tasks in beads.\n` +
  `Output APPROVED or CHANGES NEEDED.`,
  { model: 'opus', label: 'final-review', phase: 'Review' }
);
if (review.includes('CHANGES NEEDED')) {
  // Re-enter execute loop -- fix tasks are already in beads
  // (same loop as execute phase, just run it again)
}
```

---

### Harvest phase

```javascript
phase('Harvest');
// Collect branch names from doer outputs (stored in completedTasks map)
const branches = [...completedTasks.values()]
  .map(r => (r.match(/BRANCH:(\S+)/) || [])[1]).filter(Boolean);

await agent(
  `Create a PR merging branches [${branches.join(', ')}] into ${args.base_branch}.\n` +
  `Title and body from: ${args.requirements}`,
  { model: 'sonnet', label: 'harvest-pr', phase: 'Harvest' }
);
await agent(
  `Cleanup: bd dolt push. Remove any stale git worktrees from this sprint.\n` +
  `Sprint label: ${plan.sprint_label}`,
  { model: 'haiku', label: 'harvest-cleanup', phase: 'Harvest' }
);
```

---

## Token Economics

| Role | Model | pm-lite cost | claude-pm cost |
|---|---|---|---|
| Planner | opus | same | same |
| Plan-reviewer | sonnet | same | same |
| Doers (8 tasks) | per-tier | same | same |
| VERIFY reviewers | sonnet | same | same |
| Final reviewer | opus | same | same |
| **Orchestrator** | **opus/sonnet** | **40-80K tokens** | **0 (JS)** |
| bd-ready per wave | haiku | 0 | ~500 tokens x waves |
| **Total savings** | | | **~30-40%** |

The small haiku cost to parse `bd ready` output is negligible compared to
eliminating the orchestrator reasoning model.

---

## Resume Behavior

Beads state persists across Workflow crashes. On resume:

1. Any in-progress tasks (doer crashed mid-task): `bd update <id> --status=open`
   -- haiku agent runs this at the start of the execute phase.
2. Closed tasks stay closed. `bd ready` returns only remaining unblocked work.
3. Worktrees from crashed doers: harvest agent prunes them.
4. Workflow `resumeFromRunId` also applies -- completed agent() calls return
   cached results instantly. Together with beads state, re-runs are cheap.

---

## Honest Gaps

**1. `bd ready` output is human-readable text, not JSON.**
Parsing it requires a haiku agent turn per wave, or a reliable regex in the
Workflow script body. Best fix: add `--format=json` to beads. Until then, one
extra haiku turn per wave (negligible cost).

**2. Doer branch names must be extracted from text output.**
Doers are instructed to output `BRANCH:<name>` as the last line. This is fragile
if the model forgets. Mitigation: use a structured output schema for doer responses,
or have the harvest agent read worktree list directly from git.

**3. No per-task timeout control.**
The Workflow `agent()` call has a global timeout but no per-task budget. A runaway
doer on a hard task stalls the whole wave. Mitigation: beads task descriptions
should include explicit scope constraints.

**4. Worktree merge conflicts.**
Independent tasks that touch the same files create merge conflicts at harvest. The
harvest agent must handle these. Mitigation: planner assigns non-overlapping files
per task (use beads task `files` field as a convention).

---

## Positioning and Rollout

**pm-lite skill** stays as the user-facing entry point. It handles conversational
setup, clarifying questions, and calls into `claude-pm` for execution:

```javascript
// Inside pm-lite skill
Workflow({ name: 'claude-pm', args: { requirements, base_branch, verify_every: 1 } })
```

**claude-pm** is the execution engine. Power users can invoke it directly.

**Rollout order:**

1. Build `sprint-execute` sub-workflow first (wave loop + VERIFY). Biggest token
   savings, most self-contained. pm-lite provides the pre-created beads issues.
2. Add `sprint-plan` sub-workflow (planner + plan-reviewer loop with bd_commands).
3. Combine into `claude-pm` full workflow.
4. Update pm-lite to delegate to `claude-pm` instead of running its own loop.

---

## Beads Enhancement Needed

Add `bd ready --format=json` to emit structured task data:

```json
[
  { "id": "apra-fleet-012", "title": "Add model validation", "description": "...", "priority": 2 },
  { "id": "apra-fleet-013", "title": "Write tests", "description": "...", "priority": 2 }
]
```

This eliminates the haiku parsing turn per wave and makes the execute loop
fully deterministic without any text parsing.
