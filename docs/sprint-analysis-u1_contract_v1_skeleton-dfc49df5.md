# Sprint Analysis: u1_contract_v1_skeleton

Scope issue id(s): my-beads-db-27m.
Base branch: main.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [9, 10, 13, 16, 16].
High-water-mark closed count this sprint: 17.
Final closed count: 16.
Final open-at-goal-priority count: 11.

## Deploy/Integration outcomes

Deploy failures (5): C1: Deploy halted per runbook Caution/active-sprints gate, before install --force. Completed steps: node scripts/preflight-clear-build-locks.mjs (no stale processes found), npm ci (added 243 packages, ok), npm run build (build:contract + tsc, ok), npm run build:binary (produced dist/apra-fleet-installer-win-x64.exe, version v0.4.1_a9e85a; two non-fatal warnings: 'rcedit not found -- icon not replaced' and postject's 'warning: The signature seems corrupted!', both expected/benign per runbook). Gate check `curl -s http://localhost:8787/api/sprints` returned a NON-EMPTY sprints array: {"sprints":[{"sprintId":"my-beads-db-27m-8276503b-5758-4c52-bb1b-84b900c4960b","members":["repo4-apra-fleet"],"issueRoots":["my-beads-db-27m"],"childPid":32940,"port":8081}],"scopeFreshness":{"lastSyncedAt":null,"ageSeconds":"never-synced"}}. This active sprint (member repo4-apra-fleet) is likely the very sprint that dispatched this deploy task -- running `install --force` restarts the shared singleton MCP server on 7523 and could collaterally kill that sprint's own child process (pid 32940), producing a stalled/lost run instead of a clean failure report. The runbook's fallback ('force-release stale reservations and relaunch') is a workaround outside this role's remit (no allowlisted command for it, and deployer must not improvise past a documented stop condition). Stopped before `install --force`, the detached `run` launch, and the smoke test -- none of those executed. Next action: confirm whether pid 32940 / sprint my-beads-db-27m-8276503b is still live; once it finishes (or is deliberately force-released by the orchestrator), re-dispatch deploy to resume from the install --force step onward. | C2: Deploy stopped at `npm ci` step (per deploy.md ## Deploy) -- did not proceed further. Environment unchanged: install --force never ran, so the singleton MCP server on 7523 was never stopped, no supervisor dispatches collaterally affected, no rollback needed. Prior successful step: `node scripts/preflight-clear-build-locks.mjs` ran cleanly (exit 0), killing 4 orphaned esbuild PIDs (40576, 36260, 7136, 3332) holding node_modules open.

Failing command: `npm ci`. Exit code 127. Full error:
npm error code EPERM
npm error syscall unlink
npm error path D:\Umang\source\Repositories4\apra-fleet\node_modules\@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node
npm error errno -4048
npm error [Error: EPERM: operation not permitted, unlink '...rollup.win32-x64-msvc.node'] { errno: -4048, code: 'EPERM', syscall: 'unlink' }
Log: C:\Users\ushah\AppData\Local\npm-cache\_logs\2026-08-20T06_31_35_367Z-debug-0.log

Runbook gap found (durable, worth KB capture): scripts/preflight-clear-build-locks.mjs is documented as clearing locks so npm ci won't EPERM/unlink, and it DID run and succeed -- but it only detects/kills @esbuild/win32-x64/esbuild.exe holders. The actual blocker this run was a different locked file, @rollup/rollup-win32-x64-msvc/rollup.win32-x64-msvc.node, held by some other process not covered by the script's scan. Preflight coverage does not match its stated purpose on this tree -- needs extending to cover rollup's native binary (and possibly other native addons) under this repo's node_modules.

Did not attempt any workaround (no manual unlink, no re-run of npm ci, no killing unrelated processes by name) per deployer rules -- reporting and stopping. node_modules is left in a partially-unlinked state from the aborted npm ci; next deploy attempt should expect this.

Permissions check (Step 0a) passed: all 9 required prefixes from deploy.md ## Permissions present in merged .claude/settings.json + settings.local.json allow list. KB session-prime/capture skipped -- no ToolSearch tool exposed to this dispatch; KB entries were provided inline in the task and reviewed (none contradicted by what was observed). | C3: Step 0a permissions check: PASS. Merged allowlist (.claude/settings.json + .claude/settings.local.json) covers all required prefixes from deploy.md's Permissions section (node scripts/preflight-clear-build-locks.mjs, npm ci, npm run build, npm run build:binary, *apra-fleet-installer-* install *, dist/apra-fleet-installer-* install *, *apra-fleet* --version, *apra-fleet* run *, curl * localhost:8787/api/sprints*). Step 0b KB priming: skipped -- no ToolSearch or kb_* MCP tools present in this harness's tool list (KB entries were already supplied inline in the dispatch prompt and reviewed; none of them cover this failure mode).

Deploy execution: ran `node scripts/preflight-clear-build-locks.mjs` first -> output: 'no stale processes found holding node_modules open.' Then ran `npm ci`, which FAILED:

Exit code 127
npm error code EPERM
npm error syscall unlink
npm error path D:\Umang\source\Repositories4\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-NiJb4RdG\rollup.win32-x64-msvc.node
npm error errno -4048
npm error [Error: EPERM: operation not permitted, unlink '...\rollup.win32-x64-msvc.node'] { errno: -4048, code: 'EPERM', syscall: 'unlink', path: '...' }
npm error The operation was rejected by your operating system.
npm error It's possible that the file was already in use (by a text editor or antivirus), or that you lack permissions to access it.
npm error A complete log of this run can be found in: C:\Users\ushah\AppData\Local\npm-cache\_logs\2026-08-20T08_01_21_502Z-debug-0.log

Per deploy.md error handling, stopped immediately at this step. Did NOT run npm run build, npm run build:binary, the installer, or the smoke test -- smoke test would likely have exited 0 against the previously-installed binary, which would falsely read as success since it doesn't itself verify the version matches a fresh build. git status shows no working-tree changes (npm ci died during its own unlink phase, before completing reinstall), so node_modules for this checkout may now be in a partial/indeterminate state for whoever retries.

No fix attempted per role rules (do not work around failures). Recommend: investigate what is holding a lock on the rollup native binary (preflight-clear-build-locks.mjs reported clean, so the lock holder was not detected by that script's ownership-scoped check -- possibly an antivirus scan or a process that loaded the .node addon without its own cmdline pointing into this repo's node_modules; this is a hypothesis, not confirmed), then re-run npm ci and the rest of ## Deploy. | C4: Step 0a permissions check: all deploy.md-required Bash prefixes covered by merged .claude/settings.json + settings.local.json allowlist -- proceeded. Step 0b: no ToolSearch tool available this session, so kb_session_prime/kb_capture were not called live; KB entries arrived inline via the dispatch prompt (5 CONFIRMED entries, none about deploy.md/npm ci/rollup) -- treated as read, none applicable. Ran `node scripts/preflight-clear-build-locks.mjs` (output: 'no stale processes found holding node_modules open.'), then `npm ci`, which FAILED: exit code 127, npm error body 'npm error code EPERM / npm error syscall unlink / npm error path D:\Umang\source\Repositories4\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-NiJb4RdG\rollup.win32-x64-msvc.node / npm error errno -4048 / EPERM: operation not permitted, unlink ... / npm error The operation was rejected by your operating system.' Stopped immediately per rules -- did not retry, did not rm -rf node_modules, did not re-run preflight, did not attempt any workaround. Deploy did not proceed past this point: never reached the `curl localhost:8787/api/sprints` active-sprints check or `install --force`, so the singleton MCP server on port 7523 was never touched and no live supervisor sprint was collaterally affected. Post-failure read-only check (not a remediation) shows the tree is now in a partially-deleted state, not pristine: node_modules has only 23 top-level entries and node_modules/@rollup/.rollup-win32-x64-msvc-NiJb4RdG still exists on disk (npm ci died mid-unlink before completing removal/reinstall) -- the checkout is not currently in a buildable state; the next attempt should not assume npm ci starts clean. Smoke test was not run. kb_captures: [{"type":"runbook","confidence":"observed","title":"preflight-clear-build-locks.mjs does not catch all node_modules lock causes","summary":"scripts/preflight-clear-build-locks.mjs reported no stale process held node_modules, immediately followed by npm ci EPERM unlink failure on node_modules/@rollup/.rollup-win32-x64-msvc-NiJb4RdG/rollup.win32-x64-msvc.node on Windows -- the runbook's own pre-flight mitigation (deploy.md Deploy section) does not cover this failure mode (likely AV/file-handle lock not tied to a live process holding the file open, so the script's process-ownership scan finds nothing to kill). Anchors: scripts/preflight-clear-build-locks.mjs, deploy.md.","source_files":["scripts/preflight-clear-build-locks.mjs","deploy.md"]}] | C5: Stopped at pre-`install --force` active-sprints check per deploy.md ## Deploy Caution. GET http://localhost:8787/api/sprints exited 0 with one active sprint: sprintId my-beads-db-27m-8276503b-5758-4c52-bb1b-84b900c4960b, member repo4-apra-fleet, issueRoot my-beads-db-27m, childPid 32940, port 8081. No deploy step ran: no preflight-clear-build-locks.mjs, no npm ci, no npm run build, no build:binary, no installer invocation. Tree and installed fleet untouched. Step 0a passed -- all required command prefixes covered by merged .claude/settings.json + settings.local.json allowlist; block is the sprint, not permissions. No smoke test ran. Durable finding: the active sprint's own member is this repo's own checkout (repo4-apra-fleet), so a fleet-dispatched deploy will trip this same STOP gate every time it runs mid-sprint -- escalate to operator to either run deploy outside an active sprint window, or force-release the stale reservation and relaunch afterward (operator action per runbook, not a deployer action).
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Final reviewer dispatch failed after repair attempts (including one retry): [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "repo4-apra-fleet" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permissions check) before bringing the sandbox up: regression-test-playbook.md's ## Permissions section lists eight required command prefixes, and three have no covering entry in permissions.allow of either .claude/settings.json (which contains no permissions block at all) or .claude/settings.local.json -- Bash(node dist/index.js *), Bash(node scripts/run-integ-suites.mjs *), and Bash(npm run test:slow*). Without these, neither Part 1 (the real-bd apra-fleet-se suite, driven by scripts/run-integ-suites.mjs plus the test:slow lane) nor Part 2 (the sandbox smoke test, whose every lifecycle step invokes node dist/index.js) can be executed. No sandbox was ever brought up, so there was nothing to tear down, and no tests ran, so no [regression][carry-over] beads were filed. Resolution is for the orchestrator/operator to run compose_permissions in grant mode to add these prefixes to .claude/settings.local.json; this role must not hand-edit either settings file. This result is informational and does not gate the current sprint's PASS/FAIL verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
