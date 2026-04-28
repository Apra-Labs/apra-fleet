# apra-fleet #182 — Tier-Aware Dispatch

## Source
GitHub issue: https://github.com/Apra-Labs/apra-fleet/issues/182

## Base branch
`main`

## Feature branch
`feat/tier-aware-dispatch`

## Problem

The PM skill has four interconnected gaps in how it plans and dispatches work:

1. **Task tier is never used** — PM hardcodes `model=standard` for all doer dispatches regardless of per-task `tier` annotations in `planned.json`. Cheap tasks are over-provisioned.
2. **Resume logic is manually derived** — PM reasons about `resume=true/false` from session context rather than reading phase numbers from `planned.json`. Fragile across PM restarts.
3. **Cross-tier resume is unsafe** — resuming at a cheaper model than the previous task risks exceeding the model's context window (e.g. 500K tokens of Opus history resumed with Haiku's 200K limit → CLI rejects or silently truncates).
4. **Phases are defined by task count, not cohesion** — `plan-prompt.md` says "2-3 work tasks per phase, then a VERIFY". This is the wrong signal. Phases should be defined by **high cohesion within, loose coupling between**. VERIFY checkpoints placed too close together waste tokens: every review is cumulative, so an extra unnecessary VERIFY adds a full premium-model review session for marginal safety gain.

## Solution (final spec — incorporates all issue comments)

### 1. Phase boundaries driven by cohesion, not count

Replace the "2-3 tasks per phase" count rule in `plan-prompt.md` and `tpl-plan.md` with:

> **A phase is a coherent unit of work that produces a reviewable, testable increment.** Group tasks into a phase when they share a data model, code path, or design decision — splitting them would produce an incoherent intermediate state or require touching the same code twice. Place a VERIFY at the natural completion boundary of that unit, not at an arbitrary task count.

Practical effect: phases may have 4-5 tasks (a coherent subsystem) or just 1-2 (a genuinely isolated change). Fewer VERIFYs → fewer cumulative review sessions → lower total token cost.

### 2. Monotonically non-decreasing tiers within a phase

Add to `plan-prompt.md` and `tpl-plan.md`:

> **Within a phase, order tasks from cheapest to most expensive tier (cheap → standard → premium). Never downgrade mid-phase.** If a cheap task logically follows a premium task, place it in a new phase.

```
cheap → cheap → standard → standard → premium → VERIFY  ✅
cheap → standard → cheap → VERIFY  ❌  (downgrade — split into two phases)
```

This gives the dispatcher a safe invariant: any `resume=true` within a phase is guaranteed to be at the same or higher tier. Context always fits. No runtime checks needed.

### 3. PM dispatches one task at a time at the correct tier (simplified algorithm)

> No clubbing logic needed. Dispatches within a phase use `resume=true` anyway, so the session is continuous regardless of whether tasks are clubbed or dispatched individually.

Before each doer dispatch, PM reads `planned.json` and `progress.json`:

```
nextTask = planned.json.tasks.find(t => t.status === "pending")
tier     = nextTask.tier
resume   = (nextTask.phase === lastDispatchedPhase)   // from status.md
```

Dispatch ONE task at `tier`. Doer executes it, commits, stops. Repeat.

PM records `lastDispatchedPhase` in `status.md` after each dispatch.

### 4. Data-driven resume rule

| Condition | resume |
|-----------|--------|
| `nextTask.phase === lastDispatchedPhase` | `true` |
| `nextTask.phase !== lastDispatchedPhase` (new phase) | `false` |
| After reviewer CHANGES NEEDED → doer fix | `true` |
| Role switch (doer ↔ reviewer) | `false` |

## Implementation scope — PM skill files only, no fleet server changes

| File | Change |
|------|--------|
| `skills/pm/plan-prompt.md` | Replace "2-3 tasks per phase" count rule with cohesion/coupling rule; add monotonic tier constraint |
| `skills/pm/tpl-plan.md` | Same rules in the template shown to doers |
| `skills/pm/tpl-reviewer-plan.md` | Add reviewer checklist: (a) cohesion check for phase boundaries, (b) monotonic tier check within phases |
| `skills/pm/single-pair-sprint.md` | Replace phase-level dispatch with per-task dispatch algorithm; add `lastDispatchedPhase` tracking in status.md |
| `skills/pm/doer-reviewer.md` | Data-driven resume derivation from `planned.json` phase numbers |

## Acceptance criteria

1. `plan-prompt.md` no longer contains "2-3 work tasks per phase" — replaced with cohesion rule
2. `tpl-plan.md` reflects the same cohesion rule and monotonic tier constraint
3. `tpl-reviewer-plan.md` has checklist items for cohesion boundary check and monotonic tier check
4. `single-pair-sprint.md` documents the per-task dispatch algorithm with `lastDispatchedPhase` tracking
5. `doer-reviewer.md` documents data-driven resume derivation (phase number comparison)
6. All 5 files are internally consistent — no contradictions between them
7. The count-based "2-3 tasks" rule is fully removed from all 5 files — no partial survivals
