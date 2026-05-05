# {{PROJECT_NAME}} — Implementation Plan

> {{PLAN_SUMMARY}}

---

## Tasks

### Phase 1: {{PHASE_1_NAME}}

#### Task 1: {{TASK_TITLE}}
- **Change:** {{description}}
- **Files:** {{files}}
- **Tier:** cheap | standard | premium
- **Done when:** {{acceptance criteria}}
- **Blockers:** {{blockers}}

...

#### VERIFY: {{PHASE_1_NAME}}
- Run full test suite.
- Confirm changes work together.
- Report tests/regressions/issues.

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|

Cover: backward compat, security, external constraints, partial failure.

## Rules

**Boundaries by cohesion**: Group tasks sharing data model/code path. VERIFY at natural completion. Reviewable/testable increment. 1-5 tasks.

**Non-decreasing tiers in phase**: `cheap → standard → premium → VERIFY`. Downgrade? split phase. Cross-phase order irrelevant.
```
cheap → standard → premium → VERIFY  ✅
cheap → standard → cheap → VERIFY  ❌ (split phase)
```

## Notes
- Task = 1 git commit.
- VERIFY = checkpoint. Stop/report.
- Base branch: {{base_branch}}
- Impl branch: {{impl_branch}}
