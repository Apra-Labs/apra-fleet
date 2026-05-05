# Requirements — #204 Compress Skill Files (Lite Mode / Low-Compression Branch)

## Base Branch
`plan/issue-204/low-compression` — already checked out on fleet-dev2

## Context

This is a continuation of work done on `plan/issue-204/high-compression`. That branch applied full caveman compression to all 28 skill files (`skills/fleet/*.md` + `skills/pm/*.md`), achieving ~40-60% token reduction. The result is correct but the files look aggressively compressed — readability has suffered to the point where it's unclear the files will work correctly as LLM context.

This branch (`plan/issue-204/low-compression`) applies **caveman lite mode** instead — a lighter compression level that preserves more structure and readability while still reducing token count. The goal is to find a better balance.

## What's already done on this branch

Two files have already been modified (not yet committed):
- `skills/fleet/auth-azdevops.md` — already lite-compressed, needs to be staged + committed
- `skills/fleet/auth-bitbucket.md` — already lite-compressed, needs to be staged + committed

No PLAN.md or progress.json exist yet on this branch. The plan must be created from scratch.

## High-compression branch reference

The `plan/issue-204/high-compression` branch has completed compression of all 28 files. Use its committed word counts (from commit messages on that branch) as the **baseline comparison** for lite mode. The final numbers comparison task must produce a side-by-side report: `original → high-compression → lite-compression` for every file.

## File inventory

### Fleet skill files (8 total)
- `skills/fleet/SKILL.md`
- `skills/fleet/onboarding.md`
- `skills/fleet/permissions.md`
- `skills/fleet/skill-matrix.md`
- `skills/fleet/troubleshooting.md`
- `skills/fleet/auth-github.md`
- `skills/fleet/auth-azdevops.md` ← ALREADY TOUCHED (uncommitted)
- `skills/fleet/auth-bitbucket.md` ← ALREADY TOUCHED (uncommitted)

### PM skill files (20 total)
Operational (9): `SKILL.md`, `single-pair-sprint.md`, `multi-pair-sprint.md`, `simple-sprint.md`, `doer-reviewer.md`, `cleanup.md`, `init.md`, `context-file.md`, `plan-prompt.md`
Templates (11): `tpl-doer.md`, `tpl-reviewer.md`, `tpl-reviewer-plan.md`, `tpl-plan.md`, `tpl-deploy.md`, `tpl-design.md`, `tpl-requirements.md`, `tpl-status.md`, `tpl-backlog.md`, `tpl-projects.md`, `tpl-pm.md`
Skip: `tpl-progress.json` (JSON, not LLM text)
Skip: `skills/fleet/profiles/*.json` (JSON config)

## Task granularity requirement (CRITICAL)

**Tasks must be broken into small batches of 2-4 files each** so progress is visible continuously rather than in hours-long blocks. No task should take more than ~15-20 minutes. Each task results in one git commit. A task that says "compress all 9 PM operational files" is WRONG — split it into 3 tasks of 3 files each.

## Scope

1. **Commit already-touched files** — stage and commit auth-azdevops.md + auth-bitbucket.md with pre/post word counts in the commit message
2. **Compress all remaining 26 files** using caveman lite mode — in small batches, one commit per batch
3. **Collect baseline numbers from high-compression branch** — use `git show origin/plan/issue-204/high-compression:<file>` to get the compressed versions, measure their word counts for comparison
4. **Risk review** — same process as the high-compression branch: read every compressed file, flag ambiguities / dropped constraints / weakened NEVER rules, write `skills/COMPRESSION_LITE_REVIEW.md`, fix all HIGH findings before proceeding
5. **Numbers comparison report** — produce `skills/COMPRESSION_COMPARISON.md` with a table: `file | original_words | high_compress_words | lite_compress_words | lite_vs_original_%` for all 28 files
6. **Regression test** — same 4 representative commands as high-compression branch

## Out of Scope
- Modifying any TypeScript source files
- Modifying `tpl-progress.json` or any JSON profile files
- Changing caveman installation (already installed)

## Acceptance Criteria
- [ ] All 28 skill files (.md only) compressed in lite mode and committed
- [ ] Every task commits include pre/post word counts in commit message
- [ ] `COMPRESSION_LITE_REVIEW.md` committed, zero unresolved HIGH findings
- [ ] `COMPRESSION_COMPARISON.md` committed with full 3-column table
- [ ] `npm run build` passes after all changes
- [ ] 4 representative regression commands pass
- [ ] All commits on `plan/issue-204/low-compression`, pushed to origin
