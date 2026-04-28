# {{PROJECT_NAME}} — Implementation Plan

> {{PLAN_SUMMARY}}

---

## Tasks

### Phase 1: {{PHASE_1_NAME}}

#### Task 1: {{TASK_TITLE}}
- **Change:** {{what to do}}
- **Files:** {{which files}}
- **Tier:** cheap | standard | premium
- **Done when:** {{acceptance criteria}}
- **Blockers:** {{potential blockers}}

#### Task 2: {{TASK_TITLE}}
- **Change:** {{what to do}}
- **Files:** {{which files}}
- **Tier:** cheap | standard | premium
- **Done when:** {{acceptance criteria}}
- **Blockers:** {{potential blockers}}

#### Task 3: {{TASK_TITLE}}
- **Change:** {{what to do}}
- **Files:** {{which files}}
- **Tier:** cheap | standard | premium
- **Done when:** {{acceptance criteria}}
- **Blockers:** {{potential blockers}}

#### VERIFY: {{PHASE_1_NAME}}
- Run full test suite
- Confirm all Phase 1 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 2: {{PHASE_2_NAME}}

#### Task 4: {{TASK_TITLE}}
{{TASK_DETAILS}}

...

#### VERIFY: {{PHASE_2_NAME}}

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| {{risk}} | {{high/med/low}} | {{mitigation}} |

## Phase Sizing Rules

**Phase boundaries by cohesion, not count.** A phase is a coherent unit of work that produces a reviewable, testable increment. Group tasks into a phase when they share a data model, code path, or design decision — splitting them would produce an incoherent intermediate state or require touching the same code twice. Place a VERIFY at the natural completion boundary of that unit, not at an arbitrary task count. Phases may have 4-5 tasks (a coherent subsystem) or just 1-2 (a genuinely isolated change).

**Monotonically non-decreasing tiers within a phase.** Within a phase, order tasks from cheapest to most expensive tier (cheap → standard → premium). Never downgrade mid-phase. If a cheap task logically follows a premium task, place it in a new phase.
```
cheap → cheap → standard → standard → premium → VERIFY  ✅
cheap → standard → cheap → VERIFY  ❌  (downgrade — split into two phases)
```

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: {{base_branch}}
