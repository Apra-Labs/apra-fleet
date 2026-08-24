# Sprint Analysis: feat/windows-shell-selection-attempt3

Scope issue id(s): apra-fleet-7dir.
Base branch: feat/windows-shell-selection.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [49, 51].
High-water-mark closed count this sprint: 53.
Final closed count: 51.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff feat/windows-shell-selection..feat/windows-shell-selection-attempt3 (23 commits, 28 files, +2596/-332) against epic apra-fleet-7dir (24/24 children closed). Note this range is cycle-2 only -- cycle-1 work (e.g. 7dir.1's register_member shell probe) landed on the base branch, so not all 51 closed beads are sourceable here.

Gates: git status clean; npm run build exit 0; npm test exit 0 -- vitest 306 files / 4256 passed / 37 skipped / 0 failed, then the apra-fleet-se node:test suite 2426 pass / 0 fail / 3 skipped; a standalone `npm test --workspace=@apralabs/apra-fleet-se` also exited 0. No lint script is configured in package.json.

Failure-path traces I ran rather than pattern-matching:
1. dolt-settle.mjs ensurePinnedDolt now returns BOTH doltPath (member-shell dialect) and psDoltPath (always PowerShell dialect). Verified every consumer: installPinnedDolt/killProcessAtPath (lines 328/341/342) and spawnEphemeralServer (line 867) all receive psDoltPath -- the case that would have silently broken a gitbash member (a bash $HOME path embedded in a Win32_Process PowerShell script body) is handled; runDoltSql/ctx (lines 882/886) correctly use the member-shell doltPath.
2. SePosixCommands.wrapPowerShellScript throws, and killServerAndVerify is called from settleDoltConflicts' unconditional finally. Confirmed getSeCommands (se-os-commands.mjs:121-132) routes ANY os === 'windows'|'win32' to windowsPowerShell unless shell === 'gitbash', so the throwing base class is unreachable from the win32-guarded call sites -- no throw can escape the finally and mask the original error.
3. resolveGitBashPath (src/os/windows-gitbash.ts:53) no longer degrades to a bare 'bash.exe'; it throws. Its only caller is WindowsGitBashCommands.cleanExec (line 257), i.e. gitbash-registered members only, so pwsh5/pwsh7 members are unaffected. tests/strategy-gitbash-local-exec.test.ts pins the LOCALAPPDATA candidate, the MSYS-uname accept, the WSL-launcher-shadow throw, the no-bash-on-PATH throw, and a revert-detector.
4. scripts/preflight-clear-build-locks.mjs (7dir.9, P1) rewrite: kill path is gated behind a cheap non-mutating lock probe, skips its own pid and every ancestor pid, re-probes empirically before reporting failure, and offers --dry-run. Path matching uses a JS prefix test with a trailing separator (correctly avoiding the WQL LIKE '_' wildcard over-match on 'node_modules'). deploy.md is updated for the new non-zero exit contract and the widened permission grant.
5. isPosixShell consolidation (7dir.11/.15): four private copies removed from member-home.ts, orphan-recovery.ts, compose-permissions.ts and execute-prompt.ts, all routed through one overloaded export in agent-helpers.ts plus isPosixShellMember; semantics preserved byte-for-byte (!isWindows || shell === 'gitbash').
6. Git-bash candidate list is now one literal (src/os/git-bash-candidates.ts) consumed by both shell-probe.ts's remote discovery script and the local resolver, with the user-scope suffix shared too (7dir.7/.14); the parity is test-asserted, not just grepped.
7. runner.js threads the registered shell into every remaining buildSettleCallback site via resolveSettleShell, guarded on args.callTool so mock-sprint callers with no MCP client keep the pre-shell-aware default; verified args is actually passed at the syncMemberAfterOrdered and all three verifyDoerStreakClosed call sites.
8. New tests are substantive, not redundant: se-os-commands-shell-matrix (incl. the POSIX wrapPowerShellScript throw), dolt-settle-gitbash-dialect end-to-end, escapeSqlArg byte-equality against the pre-refactor escapeSqlForShell across the whole matrix, client-server-typedef-parity (reads the real zod schemas, asserts both directions), and shell-matrix pins for execute-command creds / monitor-task / watch / strategy.

Hygiene: no temp files, no stray tool config; .gitignore additions (tasks.json, .scratch-dolt-settle/, .fleet-plan*.json) are the 7dir.10 scope. Bead ids appear only in comments/docs, never in a runtime-printed or LLM-facing string, per CLAUDE.md.

One real secondary defect found (not blocking -- filed as a newTask): SeWindowsGitbashCommands#wrapPowerShellScript emits an UNGUARDED `powershell -NoProfile -EncodedCommand <b64>`, unlike SeWindowsCommands#wrapForMember and src/os/windows.ts wrapPowerShellEncoded, which both prepend $ErrorActionPreference='Stop' + try/catch + $LASTEXITCODE propagation. On a gitbash member the dolt-settle scripts therefore run under PowerShell's default Continue mode and can exit 0 on a non-terminating error -- the exact false-success class this epic exists to kill. It is not a blocker because each call site is independently protected (installPinnedDolt is followed by probeDoltVersion, spawnEphemeralServer's script throws explicitly and its result is gated on a PID: match, the kill paths are best-effort by design). Second finding: the 416-line P1 preflight rewrite ships with no tests at all.

KB: promoted 69ae29c5 only. Deliberately NOT promoting 88870d7b or cfe3c07a -- both assert the apra-fleet-client typedefs ARE missing fields, which this diff's api.mjs (+64) and the new client-server-typedef-parity test supersede; promoting them would mint a claim the tree now contradicts. Everything else in the candidate list was not independently verified this round.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-4rjy, apra-fleet-cnmj, apra-fleet-7kt4, apra-fleet-1xmr, apra-fleet-oo36.
Summary: Ran regression-test-playbook.md Part 1 (real-bd suite + slow lane) and Part 2 (sandbox smoke test); result is informational and does not gate this sprint's verdict. Part 1: after discovering an initial --start resumed a stale 2026-08-22 status file (giving a false impression of a fresh run -- corrected via --fresh and a genuine full re-execution), the real, fresh pass at branch HEAD completed 203/203 files in elapsedWall=3701s (~61.7min) with 4 failures: f34-concurrent-launch-engagement-integration.test.mjs (1578s, dup of open apra-fleet-mmxx), mock-sprint-kb-remote-scope.test.mjs (dup of open apra-fleet-qk6q), mock-sprint-publish-push-failure.test.mjs (dup of open apra-fleet-5i08), and a genuinely new one, mock-sprint-watchdog-timeout-sync-teardown.test.mjs (apra-fleet-oo36, likely same bd-init-template-collision family as apra-fleet-2cf). Two files that have failed in recent sessions (golden-transcript-3bead.test.mjs, mock-sprint-reviewer-dispatch-error.test.mjs) passed cleanly this run, consistent with prior notes classifying them as intermittent/pid-recycle races rather than fixed regressions. check-integ-suite-budget.mjs still fails (38/203 files over the 300s budget) -- tracked in long-open apra-fleet-eft.17, no new bead. The slow lane (npm run test:slow) ran genuinely fresh: pass=1 fail=1, the known apra-fleet-5jlr bd-replay recording-drift issue, reconfirmed. Part 2: Setup (install, server start on 18700, toy-repo clone, git identity, sandbox-local git mirror + beads seed, sandbox-isolation verification) all completed cleanly. Test scenario step 3a (credential-provisioning commands, run verbatim from the playbook) was denied outright by the Claude Code auto mode classifier -- the known, previously-filed apra-fleet-j48h environment block, not a product failure; per repo policy no workaround was attempted. Teardown ran regardless and the sandbox was confirmed removed. Five [regression][carry-over] beads were created this run (parent-less, verified with no PARENT/BLOCKS edges): four were found post-filing to duplicate already-open or already-closed beads and were annotated accordingly rather than left as fresh duplicates; only apra-fleet-oo36 is a genuinely new finding. All results are informational carry-over for a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
