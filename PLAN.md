# Issue #204 ? Compress Skill Files (Lite Mode)

> Generate a granular implementation plan for compressing skill files using caveman LITE mode.

---

## Tasks

### Phase 1: Bootstrap & already-touched files

#### Task 1: Verify caveman lite mode
- **Change:** Verify caveman lite mode is available and document how to invoke it. Run a quick test on a throwaway file to confirm the output quality. Record the exact command to use.
- **Files:** throwaway test file
- **Tier:** cheap
- **Done when:** Exact command to use lite mode is documented and output quality is confirmed.
- **Blockers:** Caveman skill is not available or lite mode is unsupported.

#### Task 2: Commit already-modified files
- **Change:** Commit the 2 already-modified files with pre/post word counts in commit message.
- **Files:** `skills/fleet/auth-azdevops.md`, `skills/fleet/auth-bitbucket.md`
- **Tier:** cheap
- **Done when:** Both files are committed with their word counts.
- **Blockers:** Files are not present or word counts cannot be gathered.

#### Task 3: Collect baseline word counts
- **Change:** Collect and record the baseline word count table (original vs high-compress for all 28 files). Commit a `skills/WORD_COUNT_BASELINE.md` file to the branch.
- **Files:** `skills/WORD_COUNT_BASELINE.md`, 28 target markdown files
- **Tier:** standard
- **Done when:** Baseline table committed with original and high-compress columns.
- **Blockers:** Git history on high-compression branch is inaccessible.

#### VERIFY: Phase 1
- Verify both files are committed
- Verify baseline table is committed

---

### Phase 2: Compress remaining fleet files (6 files)

#### Task 4: Compress batch 1
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/fleet/auth-github.md`, `skills/fleet/SKILL.md`, `skills/fleet/onboarding.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### Task 5: Compress batch 2
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/fleet/permissions.md`, `skills/fleet/skill-matrix.md`, `skills/fleet/troubleshooting.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### VERIFY: Phase 2
- Verify all 8 fleet files are now lite-compressed and committed.

---

### Phase 3: Compress PM operational files (9 files)

#### Task 6: Compress batch 3
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/SKILL.md`, `skills/pm/single-pair-sprint.md`, `skills/pm/multi-pair-sprint.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### Task 7: Compress batch 4
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/simple-sprint.md`, `skills/pm/doer-reviewer.md`, `skills/pm/cleanup.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### Task 8: Compress batch 5
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/init.md`, `skills/pm/context-file.md`, `skills/pm/plan-prompt.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### VERIFY: Phase 3
- Verify all 9 PM operational files are lite-compressed and committed.

---

### Phase 4: Compress PM template files (11 files)

#### Task 9: Compress batch 6
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md`, `skills/pm/tpl-reviewer-plan.md`, `skills/pm/tpl-plan.md`
- **Tier:** standard
- **Done when:** 4 files compressed and committed with word counts.
- **Blockers:** None.

#### Task 10: Compress batch 7
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/tpl-deploy.md`, `skills/pm/tpl-design.md`, `skills/pm/tpl-requirements.md`, `skills/pm/tpl-status.md`
- **Tier:** standard
- **Done when:** 4 files compressed and committed with word counts.
- **Blockers:** None.

#### Task 11: Compress batch 8
- **Change:** Compress files using lite mode and commit with pre/post word counts.
- **Files:** `skills/pm/tpl-backlog.md`, `skills/pm/tpl-projects.md`, `skills/pm/tpl-pm.md`
- **Tier:** standard
- **Done when:** 3 files compressed and committed with word counts.
- **Blockers:** None.

#### VERIFY: Phase 4
- Verify all 11 template files are lite-compressed and committed.

---

### Phase 5: Risk review

#### Task 12: Review and fix risks
- **Change:** Read every compressed file. Flag passages where instruction became ambiguous, required step dropped, or NEVER/CRITICAL constraint weakened. Write `skills/COMPRESSION_LITE_REVIEW.md` (one line per finding: file, original phrase, lite phrase, risk level, resolution). Fix all HIGH findings before committing.
- **Files:** `skills/COMPRESSION_LITE_REVIEW.md`, all 28 target files
- **Tier:** premium
- **Done when:** Review file committed and zero unresolved HIGH findings exist.
- **Blockers:** Significant meaning loss during compression requiring extensive rewrites.

#### VERIFY: Phase 5
- Verify `COMPRESSION_LITE_REVIEW.md` is committed and contains 0 unresolved HIGH findings.

---

### Phase 6: Comparison report

#### Task 13: Generate comparison report
- **Change:** Collect final word counts for all 28 lite-compressed files. Write `skills/COMPRESSION_COMPARISON.md` table with columns: `file | original_words | high_compress_words | lite_compress_words | lite_vs_orig_% | high_vs_orig_%`. Commit it.
- **Files:** `skills/COMPRESSION_COMPARISON.md`
- **Tier:** standard
- **Done when:** Comparison table generated and committed.
- **Blockers:** Missing word count data.

#### Task 14: Run regression tests
- **Change:** `npm run build` passes. Run the 4 representative regression commands from the high-compression plan.
- **Files:** None
- **Tier:** standard
- **Done when:** Build and tests pass.
- **Blockers:** Regressions caused by compression.

#### VERIFY: Phase 6
- Verify comparison report is committed
- Verify build passes and regression tests pass

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Loss of meaning in complex instructions | high | Use lite mode, perform rigorous manual review (Phase 5) comparing lite output against original text. |
| Missing word count data | med | Explicitly fetch baseline counts from high-compression branch first in Phase 1 before modifying more files. |
| Build failures due to formatting | low | Run `npm run build` and regression tests at the end of the process to ensure file integrity. |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints ? stop and report after each one
- Base branch: `plan/issue-204/low-compression`
- Implementation branch: `plan/issue-204/low-compression`