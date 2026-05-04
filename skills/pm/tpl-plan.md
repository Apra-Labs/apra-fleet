# {{PROJECT_NAME}} — Plan

> {{PLAN_SUMMARY}}

---

## Tasks

### Phase 1: {{PHASE_1_NAME}}

#### Task 1: {{TASK_TITLE}}
- **Change:** {{what}}
- **Files:** {{files}}
- **Tier:** cheap | standard | premium
- **Done when:** {{criteria}}
- **Blockers:** {{blockers}}

...

#### VERIFY: {{PHASE_1_NAME}}
- Run tests.
- Confirm changes work.
- Report results.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| {{risk}} | {{level}} | {{mitigation}} |

Cover: backward compat, security, constraints, partial failure.

## Rules

**Cohesion:** Phases are testable units. Group tasks sharing data/logic. VERIFY at natural boundaries.

**Tiers:** Order `cheap` → `standard` → `premium` within phase. Split phase if tier drops.
```
cheap → standard → premium → VERIFY  ✅
cheap → standard → cheap → VERIFY  ❌ (split phase)
```

- 1 task = 1 commit.
- VERIFY = STOP + Report.
- Base: {{base_branch}}.
- Branch: {{impl_branch}}.