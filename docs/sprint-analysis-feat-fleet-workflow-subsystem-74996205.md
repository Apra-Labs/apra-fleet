# Sprint Analysis: feat/fleet-workflow-subsystem

Scope issue id(s): apra-fleet-7pm.
Base branch: feat/fleet-reorg.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [8].
High-water-mark closed count this sprint: 8.
Final closed count: 8.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (1): C1: Stopping per runbook rules: integ-test-playbook.md is entirely absent from the repo root (only deploy.md exists). Per instructions, this must be reported rather than improvising. Additionally, deploy.md itself does not contain the expected '## Deploy' and '## Smoke test' sections required to execute a deploy operation -- it has a generic '## Steps' section (Identify build / Download binary / Install / Verify) instead, so there is no defined Smoke test command to run for a pass/fail determination. No commands were executed.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FAIL on four grounds; code quality of what landed is actually good, but the sprint's exit conditions are not met.

1. FALSE EVIDENCE -- open goal-priority beads. The dispatch prompt states '0 bead(s) still open at or above goal priority P1/P2'. `bd list --status=open` contradicts this directly: the epic apra-fleet-7pm (P1) is OPEN, and SIX in-scope children are open at or above the P1/P2 goal: apra-fleet-7pm.8 (P1, self-heal extraction in workflow.ts), 7pm.9 (P2, uninstall --skill workflows), 7pm.10 (P2, update flow), 7pm.13 (P2, build-binary smoke tests for the workflow subcommand), 7pm.14 (P2, regression guard), 7pm.15 (P2, auto-sprint-as-built-in-workflow e2e). I do not rubber-stamp PASS against open goal-priority scope; the epic is roughly half delivered (Phases 1-2 partially, Phases 3-4 largely unstarted).

2. UNFINISHED WORK COMMITTED. apra-fleet-7pm.5 (P1, 'install.ts additive workflow-install step') is IN_PROGRESS, not closed -- yet its work is on the branch as two explicit WIP commits: ffa55f1 'wip: checkpoint in-progress apra-fleet-7pm.5/.7 doer work' and 8bf8601 'wip: checkpoint apra-fleet-7pm.5 install-workflows test file'. That is +256 lines in src/cli/install.ts and a 308-line tests/install-workflows.test.ts belonging to a task nobody closed. The branch ships a half-finished P1 installer path; 7pm.13/.15 (the tests that would have exercised it end-to-end) are also open, so nothing verifies the installed-tree contract.

3. DEPLOY/INTEG PHASE FAILED 1/1 CYCLES, with zero commands executed. integ-test-playbook.md is absent from the repo root (confirmed: root .md files are AGENTS, AGY, badges, CHANGELOG, CLAUDE, CODE_OF_CONDUCT, CONTRIBUTING, deploy, GEMINI, README, ROADMAP, SECURITY), and deploy.md carries a generic '## Steps' section instead of the '## Deploy'/'## Smoke test' sections the runbook contract requires -- so no smoke test exists to produce a pass/fail. The deploy agent was right to stop rather than improvise. Net effect: no deploy or integration verification backs this branch. See newTask suggestion below -- this is a repo-infrastructure gap, not a doer error.

4. FILE HYGIENE. docs/features/apra-fleet-workflows.pptx (116 KB) and docs/features/apra-fleet-workflows.pdf (355 KB) landed in 752edc7 'docs: add apra-fleet-workflows developer-meeting slide deck'. A binary developer-meeting deck is not traceable to any apra-fleet-7pm task (7pm.11, the only docs task, scopes exactly authoring-workflows.md + install.md/npm-packaging.md/cli-reference.md deltas). ~470 KB of binaries in git with no owning task -- should be removed from the branch or given its own task.

WHAT IS GOOD (for the record, so rework does not regress it): `git status --porcelain` clean; `npm run build` (tsc) passes; `npm test` passes 2275/2275 (18 skipped, docker/auth-terminal only); there is no `lint` script configured, so Step 4 lint is N/A rather than failing. apra-fleet-7pm.7 is genuinely well done -- src/cli/workflow.ts honors the binding ADR (calls the single shared resolveFleetServerConnection() from @apralabs/apra-fleet-client/server-resolution rather than copying resolveFleetServerCommand(), never merges launcher and MCP server), and the security-critical requirement is met: workflow.ts:238-243 rejects entry escapes via path.relative + '..'/isAbsolute checks, with both the '../../../../etc/passwd' and absolute-path cases covered in tests/workflow.test.ts:168 and :182. Env defaults correctly never clobber caller-set values, and the R9 stale-manifest check gives a 'rebuild/reinstall' error instead of a confusing 'workflow not found'.

TO CLEAR THIS SPRINT: close or explicitly de-scope 7pm.5, .8, .9, .10, .13, .14, .15 and the 7pm epic; drop or re-home the docs/features/ deck; and land the missing integ-test-playbook.md / deploy.md sections so the deploy phase can actually run.
