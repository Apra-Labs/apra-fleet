# Sprint Analysis: fix/cross-shell-home-var

Scope issue id(s): apra-fleet-ot2z.
Base branch: main.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [8, 8, 14, 14, 14].
High-water-mark closed count this sprint: 15.
Final closed count: 14.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (5): C1: Deploy aborted at step 2 of ## Deploy (npm ci). Permissions check passed: every prefix required by deploy.md's ## Permissions section (Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(*apra-fleet* start), Bash(node scripts/preflight-clear-build-locks.mjs), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *), Bash(curl * localhost:8787/api/sprints*)) is present in the merged permissions.allow from .claude/settings.json + .claude/settings.local.json. Note: .claude/settings.json failed to JSON.parse due to a leading UTF-8 BOM, so this run's merge effectively came from settings.local.json alone; that file already covered every required prefix, so it did not block this deploy, but a future deploy whose grant lives only in settings.json's permissions.allow (currently empty per this repo's convention) would falsely read as 'missing' -- worth fixing the BOM separately. Ran node scripts/preflight-clear-build-locks.mjs successfully: it found and killed 7 stale esbuild.exe processes holding node_modules open (PIDs 33956, 47732, 4860, 31016, 28400, 45520, 38188). Then ran npm ci, which failed: exit code 127, npm error EPERM: operation not permitted, unlink 'C:\akhil\git\apra-fleet\node_modules\@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node' (errno -4048). Full log at C:\Users\akhil\AppData\Local\npm-cache\_logs\2026-08-11T07_44_21_066Z-debug-0.log. Likely cause: the preflight script only kills processes whose own executable path resolves inside node_modules (matches esbuild.exe-style stale build tools via Win32_Process ExecutablePath LIKE <node_modules>%); a native addon like rollup's .node file is loaded into a host process (e.g. a running node.exe or the apra-fleet server itself) whose executable lives outside node_modules, so it is structurally invisible to that matcher and was left holding the lock. Per deploy operator rules I did not attempt to kill the holding process or otherwise route around the lock -- stopping and reporting instead. State left behind: preflight already killed the 7 esbuild PIDs listed above; npm ci failed partway through dependency installation so node_modules may be partially mutated; npm run build, npm run build:binary, install --force, and the active-sprints check (GET localhost:8787/api/sprints) were never reached, so the running fleet server on port 7523 was NOT restarted and is unaffected. No smoke test was run. | C2: Deploy stopped at step: npm ci (in ## Deploy section of deploy.md). Preflight step node scripts/preflight-clear-build-locks.mjs ran successfully first and cleared 8 stale esbuild.exe PIDs (37980, 26520, 34764, 48176, 48932, 16756, 30356, 9104) holding node_modules open. npm ci then failed with a DIFFERENT locked file that the preflight does not cover: @rollup/.rollup-win32-x64-msvc-AJBsWU3G/rollup.win32-x64-msvc.node. Harness-reported exit code: 127. npm's own reported error: EPERM / errno -4048. Full error output:

npm error code EPERM
npm error syscall unlink
npm error path C:\akhil\git\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-AJBsWU3G\rollup.win32-x64-msvc.node
npm error errno -4048
npm error [Error: EPERM: operation not permitted, unlink 'C:\akhil\git\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-AJBsWU3G\rollup.win32-x64-msvc.node'] {
npm error   errno: -4048,
npm error   code: 'EPERM',
npm error   syscall: 'unlink',
npm error   path: 'C:\\akhil\\git\\apra-fleet\\node_modules\\@rollup\\.rollup-win32-x64-msvc-AJBsWU3G\\rollup.win32-x64-msvc.node'
npm error }
npm error
npm error The operation was rejected by your operating system.
npm error It's possible that the file was already in use (by a text editor or antivirus),
npm error or that you lack permissions to access it.
npm error
npm error If you believe this might be a permissions issue, please double-check the
npm error permissions of the file and its containing directories, or try running
npm error the command again as root/Administrator.
npm error A complete log of this run can be found in: C:\Users\akhil\AppData\Local\npm-cache\_logs\2026-08-11T09_00_55_253Z-debug-0.log

No further deploy.md steps (npm run build, npm run build:binary, installer install --force, start, smoke test) were executed, per the runbook's stop-on-failure rule. No files were modified and no workaround was attempted. Recommend identifying and terminating whatever process holds a lock on the rollup native binary under this checkout's node_modules (e.g. an orphaned rollup/vite/esbuild-adjacent process not covered by the current preflight script), then re-triggering deploy. | C3: Deploy stopped at step `npm ci` in the ## Deploy section of deploy.md (cwd C:/akhil/git/apra-fleet). Step 0 permission check passed: all required prefixes (Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(*apra-fleet* start), Bash(node scripts/preflight-clear-build-locks.mjs), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *), Bash(curl * localhost:8787/api/sprints*)) are present in the merged allowlist from .claude/settings.json + .claude/settings.local.json. Ran `node scripts/preflight-clear-build-locks.mjs` first as instructed; it killed 4 stale esbuild.exe PIDs (41740, 51696, 14768, 28988) holding node_modules open. Then ran `npm ci`, which failed with exit code 127: npm error code EPERM / npm error syscall unlink / npm error path C:\akhil\git\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-AJBsWU3G\rollup.win32-x64-msvc.node / npm error errno -4048 / npm error [Error: EPERM: operation not permitted, unlink 'C:\akhil\git\apra-fleet\node_modules\@rollup\.rollup-win32-x64-msvc-AJBsWU3G\rollup.win32-x64-msvc.node'] / npm error The operation was rejected by your operating system. It's possible that the file was already in use (by a text editor or antivirus), or that you lack permissions to access it. Full log: C:\Users\akhil\AppData\Local\npm-cache\_logs\2026-08-11T11_04_57_897Z-debug-0.log. Observation: the preflight script's sanctioned remediation covers stale esbuild.exe process locks but did not cover this holder, which is on a rollup native binary -- a different lock owner than the preflight script targets. No workaround was attempted (no manual node_modules deletion, no preflight re-run, no retry) per role rules against fixing/routing around failures. Deploy did not proceed past `npm ci`: npm run build, npm run build:binary, the active-sprints curl check, and install --force were never run, so the singleton MCP server on localhost:7523 was not touched and no live supervisor sprints were disturbed. Note: npm ci had already begun mutating node_modules before failing, so the checkout's dependency tree is now in an indeterminate state -- any retry should start from the preflight step, and the lingering rollup lock holder should be identified/cleared first. | C4: Deploy stopped at Deploy step 2 (npm ci) in C:\akhil\git\apra-fleet.

Pre-checks: permissions verified OK (all 9 required prefixes covered by merged .claude/settings.json + .claude/settings.local.json allowlist). Active-sprints pre-check (curl -s http://localhost:8787/api/sprints) exited 7 (connection refused, nothing listening on 8787) -- not an active-sprints block, just no supervisor API present in this environment.

Step 1, node scripts/preflight-clear-build-locks.mjs, ran successfully and reported: "no stale processes found holding node_modules open."

Step 2, npm ci, failed:
Exit code: 127
npm error code EPERM
npm error syscall unlink
npm error path C:\akhil\git\apra-fleet\node_modules\@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node
npm error errno -4048
npm error [Error: EPERM: operation not permitted, unlink 'C:\akhil\git\apra-fleet\node_modules\@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node']
npm error The operation was rejected by your operating system. It's possible that the file was already in use (by a text editor or antivirus), or that you lack permissions to access it.
npm debug log: C:\Users\akhil\AppData\Local\npm-cache\_logs\2026-08-11T11_11_39_878Z-debug-0.log

Notably, the runbook's own EPERM mitigation (preflight-clear-build-locks.mjs) ran immediately before this and found no stale process holding the file, so the standard remedy did not prevent the failure -- this needs manual investigation (e.g. antivirus lock, or a handle not attributable to a process whose cmdline points inside this checkout).

Not run (stopped per instructions -- no fix/workaround attempted): npm run build, npm run build:binary, installer install --force, apra-fleet start, and the Smoke test (CLI --version plus MCP version/fleet_status confirmation). | C5: Deploy stopped: 'npm ci' failed in C:/akhil/git/apra-fleet (exit code 127; npm reported code EPERM, errno -4048, syscall unlink). Locked path: node_modules\@rollup\rollup-win32-x64-msvc\rollup.win32-x64-msvc.node -- npm was unable to unlink it (EPERM: operation not permitted). The Deploy section's preflight step (node scripts/preflight-clear-build-locks.mjs) was run first and did clear one stale process (PID 51416, esbuild.exe under this checkout's node_modules), but the process holding the rollup native module lock was not detected/cleared by that script, so npm ci still failed on that file. Likely held by an editor/AV process or another rollup-related process outside preflight's detection scope. No further deploy steps (npm run build, npm run build:binary, installer, start, smoke test) were executed. Per runbook rules, stopping and reporting rather than attempting a workaround.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C3: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/\[\]-]+$/ (or is empty): "Root `npm test` does not run the packages/apra-fleet-se .mjs test suites"

## Final verdict

FAIL -- Final reviewer dispatch failed after repair attempts (including one retry): [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "fleet-win-dev1" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "fleet-win-dev1" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
