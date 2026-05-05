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
- Run the full test suite
- Confirm Phase 1 changes work together
- Report: tests passing, regressions, or issues found

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

Cover at minimum: backward compatibility (changed interfaces, renamed items), security (trust boundaries, input validation), external constraints (no new dependencies, minimum runtime version), and partial failure (one path works, another doesn't).

## Phase Sizing Rules

**Phase boundaries by cohesion, not count.** A phase is a coherent unit of work that produces a reviewable, testable increment. Group tasks into a phase when they share a data model, code path, or design decision — splitting them would produce an incoherent intermediate state or require touching the same code twice. Place a VERIFY at the natural completion boundary of that unit, not at an arbitrary task count. Phases may have 4-5 tasks (a coherent subsystem) or 1-2 (a genuinely isolated change).

**Monotonically non-decreasing tiers within a phase.** Within a phase, order tasks cheap → standard → premium. The PM resumes the same session across tasks in a phase — a premium task can build a large context that a cheap model cannot load. The PM may group consecutive same-tier tasks into a single dispatch streak; tier transitions trigger a new dispatch. If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary rather than violating the ordering rule. Cross-phase tier order does not matter — each phase always starts a fresh session.
```
cheap → cheap → standard → standard → premium → VERIFY  ✅
cheap → standard → cheap → VERIFY  ❌  (downgrade within phase — split into two phases)
```

## Notes
- Each task results in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: {{base_branch}}
- Implementation branch: {{impl_branch}}
