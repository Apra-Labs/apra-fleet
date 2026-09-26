# Sprint Analysis: chore/bkax-planner-notes-contradiction-check

Scope issue id(s): apra-fleet-bkax.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [5].
High-water-mark closed count this sprint: 5.
Final closed count: 5.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (1): C1: Sandbox Deploy (integration/regression mode) for sprintId apra-fleet-bkax-89e78d0e-7b06-4434-a7e6-9a3e1e791b2e. Permissions check passed. Build steps (preflight-clear-build-locks, npm ci, npm run build) all succeeded (npm ci only emitted EBADENGINE warnings: package.json requires node>=22.16.0). `node scripts/sandbox-deploy.mjs up --sprint-id <id>` failed at the smoke step: init/start/verify all passed (fleet server + supervisor came up, isolation verified, production untouched), but the sandbox fleet server's /health stopped answering. Root cause found by reproducing init/start/verify/smoke individually and inspecting fleet-server.log before auto-teardown: the sandbox fleet server crashed with an uncaught exception on the first MCP session-initialize request: `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`. node:sqlite is a Node 22+ built-in. The `node` resolved on PATH is v20.20.2 (/home/akhil/.local/bin/node, shadowing nvm), while package.json declares engines.node >=22.16.0 and nvm's own default alias is already v22.22.2 (present under ~/.nvm/versions/node/v22.22.2). This is an environment Node-version mismatch, not a runbook or code defect -- deploy.md does not mention Node-version selection and I did not attempt to change PATH/nvm or code as that would be a workaround outside the deploy role's scope. No sandbox artifacts were left behind: ran `sandbox-deploy.mjs teardown` for both the auto-failed run and my manual reproduction run, and confirmed via `sandbox-deploy.mjs env --sprint-id <id>` (exit 1, 'no values file') that nothing remains under /home/akhil/tmp or the ~/.fleet-sandbox-*.env file. Production singleton (7523/8787) was never touched (Sandbox Deploy never calls install --force or the active-sprints gate). Recommend: fix PATH/nvm so `node` resolves to >=22.16.0 (e.g. `nvm use default` or removing /home/akhil/.local/bin/node from ahead of the nvm shim) before re-dispatching this deploy. Suggested KB capture (runbook/learning): 'Sandbox deploy smoke fails with node:sqlite ERR_UNKNOWN_BUILTIN_MODULE if PATH resolves node to <22.16.0 even when nvm default is 22.x -- the fleet server crashes on the very first MCP session initialize, not at build time, so npm ci/build succeed and only EBADENGINE warnings hint at it.'
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed net diff main..chore/bkax-planner-notes-contradiction-check against epic apra-fleet-bkax (5/5 children closed). All acceptance criteria met.

PROMPT FIXES (ccmv/beom): planner.md gains a 'Read NOTES before decomposing' block treating CORRECTION/AMENDMENT/SUPERSEDES/REVISED entries as authoritative over stale DESCRIPTION; plan-reviewer.md adds criterion 12 (child-vs-parent-NOTES contradiction) requiring both conflicting passages be quoted, mapped to kind:'other', and updates the count to twelve. Both are generic; check-generic-boundary.mjs exits 0.

TOOLING (fsxg): parent-notes-staleness.mjs computes a strictly-advisory staleness signal via bd history (notes-change timestamp, not updated_at) + bd list --parent, threaded once per plan phase into both prompts, registered in guarded-modules.mjs with a dispatch-safety baseline. Degrades to prompt-only on any bd failure.

TESTS (bkax.1/bkax.2): guidance test asserts marker vocabulary + quoting via whitespace-normalized matching with mutation self-checks; staleness test covers positive + both negative cases. 65 targeted tests pass; repo build passes.

Deploy FAILED environmentally only: PATH node is v20.20.2 (confirmed) while engines require >=22.16.0; fleet server crashes on node:sqlite (Node22+ builtin). Not a code/runbook defect; nvm has 22.22.2. Re-run deploy under Node >=22.16.0.

Full `npm test` reports 2 failures (mock-sprint-beads-health-gate eft.58.2/eft.63.2) that PASS in isolation -- contention flakes in code this branch does not touch, matching known KB flake pattern; not a regression.

SECONDARY FINDING (non-blocking, see newTasks): collectParentNotesStalenessNotes runs `bd list --parent <id> --json` WITHOUT --status all, so it excludes CLOSED children. Verified: that command returns [] for apra-fleet-bkax while --status all returns its 5 children. This can miss the signal once children close and can false-positive when the newest child is closed but an older sibling is open with NOTES timed between. Tests stub the command so they miss it. Advisory P3, so filed as follow-up rather than a reopen.

Working tree also carries unrelated local edits (.claude skills, AGENTS.md, CLAUDE.md, .gitignore) and an untracked scratch file test/.phase4probe-dolt-sync-brackets.test.mjs -- none committed on the branch, none part of this sprint.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass at branch HEAD c3c5d7ee590c49cb81106da464add69f6506d127. Part 1 (real-bd suite): recovered from a stale leftover status file via --fresh, then a fresh 266-file real-bd run completed with 0 test failures, but the slow lane's mock-sprint-planner-dispatch-stalled-session.test.mjs failed (bd-replay fixture drift) and the budget check still flags 2 long-pole files (phase3/phase4 completeness probes) -- both are pre-existing, already-tracked issues (apra-fleet-5jlr, apra-fleet-eft.17), updated with fresh evidence, so suitePassed is reported false to reflect the real slow-lane failure. Part 2 (smoke test): Setup completed cleanly (install, server boot, toy-repo clone, beads seed + isolation guard, supervisor boot all verified OK), but the Test scenario's credential-provisioning step (3a) was denied by the Claude Code auto-mode classifier -- a long-standing, already-tracked recurring environment block (apra-fleet-j48h, reproducing on nearly every regression pass since 2026-08-19) -- so smokePassed is false and no workaround was attempted per repo policy. Teardown ran to completion regardless (supervisor stopped, lock released, server stopped, dolt reap clean, sandbox fully removed). No new [regression][carry-over] bugs were filed this run: every finding matched an existing open carry-over/integ bug and was updated with today's evidence instead of duplicated (apra-fleet-eft.17, apra-fleet-jl71, apra-fleet-5jlr, apra-fleet-j48h). This entire result is informational and does not gate the current sprint's verdict; all carried-over issues remain for a future sprint to address.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
