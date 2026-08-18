# Sprint Analysis: fix/kb-tm7-repo-blindness

Scope issue id(s): apra-fleet-tm7.
Base branch: feat/code-intelligence-abstraction.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [12, 13].
High-water-mark closed count this sprint: 13.
Final closed count: 13.
Final open-at-goal-priority count: 2.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (2): C1: Stopped at Step 0a before running any tests: the integ-test-playbook.md Permissions section requires a covering grant for the `bd ...` command family, but neither .claude/settings.json nor .claude/settings.local.json contains a permissions.allow entry covering `bd` (the only 'bd' string present is the SessionStart hook's literal `bd prime --hook-json` command, not a permission grant). npm test/npm run/npx vitest are all covered via Bash(npm:*) and Bash(npx:*), so only `bd` is missing. Feature apra-fleet-tm7.9 was not tested and no bd commands (show/dep list/close/create) were run. Escalating: please run compose_permissions to add a grant covering `bd` (e.g. Bash(bd:*)) to .claude/settings.local.json, then re-dispatch this run. (bugs filed: none) | C2: Stopped before running any tests: Step 0a permission check found the `bd` command family (bd show/dep list/close/create/update/search) required by integ-test-playbook.md has no covering entry in either .claude/settings.json or .claude/settings.local.json for this repo checkout, even though npm and npx are covered. Feature apra-fleet-tm7.9 was not tested and no bd commands were run. Escalation needed: request compose_permissions grant a bd-covering entry (e.g. Bash(bd:*)) into .claude/settings.local.json before this role can proceed. (bugs filed: none)

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C2: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "Grant the `bd` command family so the integ-test-runner can actually run"

## Final verdict

FAIL -- SCOPE CHECK. The net diff feat/code-intelligence-abstraction..fix/kb-tm7-repo-blindness is 8 files / 8 commits and contains ONLY the hygiene beads tm7.8, tm7.11, tm7.12, tm7.13, tm7.14, tm7.15. The epic's actual KB fix (tm7.1-.7) is already in the BASE branch -- verified: `git show feat/code-intelligence-abstraction:src/tools/kb-harvest.ts` already has repo_path + getKbProviders(input.repo_path) at line 105, base execute-prompt.ts:1388 already passes repo_path: resolvedWorkFolder, and `git grep getKBService feat/code-intelligence-abstraction -- src` is empty. So none of tm7.1-.7 is creditable to this diff (no reopen -- they landed in a prior round).

WHAT IS CORRECT IN THIS DIFF (each verified against its AC):
- tm7.8 (.claude/settings.json): the 9 permissions.allow entries match deploy.md:6-15 exactly, in order, with no extras; file is valid JSON, ASCII, 2-space indent, and the SessionStart `bd prime --hook-json` hook is intact. AC met (nit: no trailing newline).
- tm7.11 (scripts/check-sandbox-sync-remote.mjs:382 `if (list === null) return []`, tests/check-sandbox-sync-remote.test.ts:327-334): the previously-red file now passes (56 tests, 6 skipped -- the 6 are the win32 describe.skip block at line 95, not the embeddeddolt case at line 418). Hermetic null / ' null\n' / bare-42-throws cases added.
- tm7.12/tm7.13 (.gitignore): verified with `git check-ignore -v --no-index`: sprint-logs/calibration.json, sprint-logs/x.jsonl, sprint-logs/x.analysis.md and packages/apra-fleet-se/sprint-logs/y.jsonl are all NOT ignored; sprint-logs/sprint_abc.json is still ignored by .gitignore:55. sprint-logs/.state/ is not orphaned by removing the blanket rule -- auto-sprint.js:2455-2456 self-appends it to .git/info/exclude. The removed em dash at old line 20 is the only non-ASCII in the diff.
- tm7.15 (auto-sprint.js:1280-1293, 2731): policy (b) applied at the emitter with a comment; sprint-meta.test.mjs passes (11/11), sprint-log-flush.test.mjs passes (9/9).

WHY THIS IS A FAIL:
1. The epic's own P1 intent is unlanded. apra-fleet-tm7 is still OPEN with P1 children tm7.9 (remote-member harvest still collapses into FLEET_DIR/knowledge/default/kb.sqlite), tm7.9.1 (IN_PROGRESS) and tm7.9.2 (OPEN). Remote members are the fleet's primary deployment shape, so the per-repo-isolation defect the epic exists to fix is still live for them.
2. Step-4 clean-tree gate fails and the suite is red. `git status --porcelain` is NOT empty: 8 modified files (src/os/linux.ts, src/os/os-commands.ts, src/os/windows.ts, src/services/knowledge/kb-providers.ts, src/services/knowledge/project-slug.ts, src/tools/execute-prompt.ts, src/tools/kb-harvest.ts, tests/execute-prompt.test.ts) -- unlanded tm7.9.1 work (adds gitRemoteUrl() to OsCommands and slugFromRemoteUrl() to project-slug.ts). `npm test` on this tree: 4 failed / 278 passed / 3 skipped. I isolated the cause rather than assuming it: in a detached worktree at HEAD (930ae125) with the same node_modules, tests/cloud-lifecycle.test.ts, tests/execute-prompt-resume-semantics.test.ts, tests/stop-prompt.test.ts and tests/integration/session-lifecycle.test.ts all PASS (31/31). So the committed branch is green and the 4 failures are caused by the uncommitted tm7.9.1 change: it adds an extra strategy.execCommand round trip on the dispatch path (cloud-lifecycle.test.ts:162 expected 3 calls got 4; execute-prompt-resume-semantics.test.ts:166 expected 4 got 5) and the unmocked extra call returns undefined, throwing TypeError at src/tools/execute-prompt.ts:233 in deletePromptFile. That directly contradicts tm7.9.1's own done criteria (build+targeted tests pass; no added blocking round trip on the hot path).
3. Integration testing never happened, in either cycle. The blocker is real and still present: integ-test-playbook.md:23-36 requires a covering grant for the `bd ...` family; the newly TRACKED .claude/settings.json has only the 9 deploy prefixes and no bd entry, and the checkout's .claude/settings.local.json (dated May 1) has npm/npx/node/gh/git but no Bash(bd:*). tests/integ-playbook-permission-profiles.test.ts passes because skills/fleet/profiles/*.json do grant bd -- but compose_permissions never delivered them into this checkout. tm7.9 was therefore closed-by-no-one and verified by no one; adding bd was correctly OUT of tm7.8's AC ("no prefix is added that deploy.md does not list"), so this needs its own task.

Build: `npm run build` exits 0. No secrets, no injection surface, no unrelated/temp files in the diff (the two sprint-logs/*.jsonl are the durable ledgers tm7.14 asked for).

SECONDARY (filed as newTasks, not blocking the closed beads): the two ledgers committed by eeb8bb5b still carry "transcriptDir":"/home/kashyap/..." (tm7.15 explicitly forbade scrubbing already-committed files, so this is correct-per-AC but leaves 9 tracked files with the runner's username); deploy.md's leading-wildcard prefixes (e.g. `Bash(*apra-fleet* start)`) are now repo-tracked policy and deserve a look; and tests/check-sandbox-sync-remote.test.ts:418 still shells out to the real `bd`, which is exactly why it was environment-red.

KB PROMOTIONS: promoting all three candidates, each independently verified during this review -- 62a26c94 (redaction anchor / workflow-VM constraint), 66075242 (git add failure-mode asymmetry, checked with a standalone two-repo repro), daf6fb22 (unconditional `git add sprint-logs/` in beads-export-cleanup). reopenIds is empty: every bead closed in this diff meets its own acceptance criteria; the failure is epic-level completeness, not defective closed work.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 permissions check before running anything: regression-test-playbook.md's Permissions section requires Bash(bd *) coverage (bd search/bd create for reporting failures, plus bd show/bd dolt in Setup and Test scenario), but no entry granting bd exists in permissions.allow of either .claude/settings.json or .claude/settings.local.json for this repo -- the only bd reference in either file is the SessionStart hook command 'bd prime --hook-json', which is not a permissions.allow grant. All other required prefixes (mkdir, rm -rf ~/temp/.apra-fleet-tests*, node dist/index.js *, git clone *, git -C ~/temp/.apra-fleet-tests* *, node scripts/run-integ-suites.mjs *, npm run test:slow*) are covered via broad Bash(mkdir:*)/Bash(rm:*)/Bash(node:*)/Bash(git:*)/Bash(npm:*) entries in .claude/settings.local.json. Per instructions, no sandbox was brought up and no tests were run (neither Part 1 nor Part 2), so no Teardown was needed. Escalation: ask the orchestrator/operator to run compose_permissions to add a bd grant (e.g. Bash(bd:*)) to .claude/settings.local.json, or land it in .claude/settings.json via a team PR, then re-dispatch this run. This result is informational and does not gate the current sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
