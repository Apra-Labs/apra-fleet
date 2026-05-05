# Apra Fleet — Implementation Plan

> Compress skill files using caveman LITE mode.

---

## Tasks

### Phase 1: Bootstrap & already-touched files

#### Task 1: Verify caveman lite mode
- **Change:** Verify caveman lite mode is available and document how to invoke it. Run a quick test on a throwaway file to confirm the output quality. Record the exact command to use.
- **Files:** none
- **Tier:** standard
- **Done when:** Lite mode command documented and verified
- **Blockers:** none

#### Task 2: Commit already-touched files
- **Change:** Commit the 2 already-modified files with pre/post word counts in commit message.
- **Files:** skills/fleet/auth-azdevops.md, skills/fleet/auth-bitbucket.md
- **Tier:** standard
- **Done when:** Both files are committed with word count comparison in message
- **Blockers:** none

#### Task 3: Collect baseline word counts
- **Change:** Collect and record the baseline word count table (original vs high-compress for all 28 files).
- **Files:** skills/WORD_COUNT_BASELINE.md
- **Tier:** standard
- **Done when:** Baseline table committed
- **Blockers:** none

#### VERIFY: Bootstrap & already-touched files
- Run full test suite
- Confirm all Phase 1 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 2: Compress remaining fleet files (6 files)

#### Task 4: Compress batch 1 of fleet files
- **Change:** Compress fleet files in lite mode, commit with pre/post counts.
- **Files:** skills/fleet/auth-github.md, skills/fleet/SKILL.md, skills/fleet/onboarding.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### Task 5: Compress batch 2 of fleet files
- **Change:** Compress fleet files in lite mode, commit with pre/post counts.
- **Files:** skills/fleet/permissions.md, skills/fleet/skill-matrix.md, skills/fleet/troubleshooting.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### VERIFY: Compress remaining fleet files
- Run full test suite
- Confirm all Phase 2 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 3: Compress PM operational files (9 files)

#### Task 6: Compress batch 1 of PM operational files
- **Change:** Compress PM files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/SKILL.md, skills/pm/single-pair-sprint.md, skills/pm/multi-pair-sprint.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### Task 7: Compress batch 2 of PM operational files
- **Change:** Compress PM files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/simple-sprint.md, skills/pm/doer-reviewer.md, skills/pm/cleanup.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### Task 8: Compress batch 3 of PM operational files
- **Change:** Compress PM files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/init.md, skills/pm/context-file.md, skills/pm/plan-prompt.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### VERIFY: Compress PM operational files
- Run full test suite
- Confirm all Phase 3 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 4: Compress PM template files (11 files)

#### Task 9: Compress batch 1 of PM template files
- **Change:** Compress PM template files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/tpl-doer.md, skills/pm/tpl-reviewer.md, skills/pm/tpl-reviewer-plan.md, skills/pm/tpl-plan.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### Task 10: Compress batch 2 of PM template files
- **Change:** Compress PM template files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/tpl-deploy.md, skills/pm/tpl-design.md, skills/pm/tpl-requirements.md, skills/pm/tpl-status.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### Task 11: Compress batch 3 of PM template files
- **Change:** Compress PM template files in lite mode, commit with pre/post counts.
- **Files:** skills/pm/tpl-backlog.md, skills/pm/tpl-projects.md, skills/pm/tpl-pm.md
- **Tier:** standard
- **Done when:** Files lite-compressed and committed
- **Blockers:** none

#### VERIFY: Compress PM template files
- Run full test suite
- Confirm all Phase 4 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 5: Risk review

#### Task 12: Review all compressed files
- **Change:** Read every compressed file. Flag passages where instructions became ambiguous, required step dropped, or NEVER constraint weakened. Write COMPRESSION_LITE_REVIEW.md. Fix all HIGH findings before committing.
- **Files:** skills/COMPRESSION_LITE_REVIEW.md, all compressed files
- **Tier:** standard
- **Done when:** COMPRESSION_LITE_REVIEW.md committed, zero unresolved HIGH findings
- **Blockers:** none

#### VERIFY: Risk review
- Run full test suite
- Confirm all Phase 5 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 6: Comparison report

#### Task 13: Comparison report
- **Change:** Collect final word counts for all 28 lite-compressed files. Write COMPRESSION_COMPARISON.md table with original vs high-compress vs lite-compress percentages.
- **Files:** skills/COMPRESSION_COMPARISON.md
- **Tier:** standard
- **Done when:** COMPRESSION_COMPARISON.md committed with full table
- **Blockers:** none

#### Task 14: Regression test
- **Change:** Run 
pm run build and 4 representative regression commands.
- **Files:** none
- **Tier:** standard
- **Done when:** Build and tests pass
- **Blockers:** none

#### VERIFY: Comparison report
- Run full test suite
- Confirm all Phase 6 changes work together
- Report: tests passing, any regressions, any issues found

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Loss of constraints | High | Perform risk review and fix HIGH findings |
| Unreadable contexts | Med | Validate output of lite compression |

## Phase Sizing Rules

**Phase boundaries by cohesion, not count.** A phase is a coherent unit of work that produces a reviewable, testable increment. Group tasks into a phase when they share a data model, code path, or design decision — splitting them would produce an incoherent intermediate state or require touching the same code twice. Place a VERIFY at the natural completion boundary of that unit, not at an arbitrary task count. Phases may have 4-5 tasks (a coherent subsystem) or just 1-2 (a genuinely isolated change).

**Monotonically non-decreasing tiers within a phase.** Within a phase, order tasks cheap → standard → premium. The PM resumes the same session across tasks in a phase — a premium task can build a large context that a cheap model cannot load. The PM may group consecutive same-tier tasks into a single dispatch streak; tier transitions trigger a new dispatch. If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary rather than violating the ordering rule. Cross-phase tier order does not matter — each phase always starts a fresh session.

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: plan/issue-204/high-compression
- Implementation branch: plan/issue-204/low-compression