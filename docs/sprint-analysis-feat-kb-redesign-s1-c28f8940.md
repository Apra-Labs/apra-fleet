# Sprint Analysis: feat/kb-redesign-s1

Scope issue id(s): apra-fleet-b4g.68.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [4].
High-water-mark closed count this sprint: 5.
Final closed count: 4.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Scope: apra-fleet-b4g.68 (remote memberCall left its args file untracked in the member's git checkout) and children .68.1-.68.3. Reviewed net diff feat/kb-redesign..feat/kb-redesign-s1, focusing on db77f5db..a01112b3 (member-call.mjs, se-os-commands.mjs, se-posix.mjs, se-windows.mjs plus 3 test files).

Implementation [OK]:
- member-call.mjs runRemote: ensureArgsDirExcluded runs getSeCommands(target).ensureGitExcluded('.apra-call/') before the first send_files to each member (cached per instance only on success, otherwise retried; a failure is logged and the call continues). An outer finally runs removeFile(argsPath) after send_files plus the call on every outcome: success, isError, unparseable output, a thrown or timed-out executeCommand, and a failed send. A failed delete is logged and swallowed, so it never hides the call's own result or typed error. --list-tools delivers no file and runs neither command.
- se-posix.mjs: the exclude file is located with git rev-parse --git-path info/exclude, so subdirectories and linked worktrees work. The append is idempotent (grep -qxF), a missing trailing newline is repaired first, and outside a git repo the command exits 0. It uses no member env vars, ~ or backticks (per the CLAUDE.md shell rule).
- se-windows.mjs: PowerShell twin wrapped in -EncodedCommand. The git call has its own try/catch for PS 5.1 under ErrorActionPreference Stop, LASTEXITCODE is reset, and lines end in LF.
- assertSafeRelativePath throws on any path outside a strict charset and on '..', a leading '/' or a leading '-'. Paths are rejected, never quoted or escaped into the command.

Acceptance criteria [OK], each with a test that runs commands for real:
- A member without the call verb leaves no file in .apra-call/.
- Success and timeout cases leave no args file.
- .apra-call/ is excluded before the first send, and git status --porcelain --untracked-files=all stays empty even when the delete is forced to fail. The test uses a real temp git repo and runs the commands with real bash.
- Commands are built per shell (bash and PowerShell shape tests). pwsh is installed on this host, so the real-PowerShell tests in se-os-commands-git-exclude ran and passed.

Build/tests: npm run build exit 0. npm test exit 0: vitest 386 files / 5426 tests passed (61 skipped); node suites pass=43, 321, 3587 and 489 with fail=0.

Hygiene: every changed file maps to KB-redesign sprint work. sprint-analysis docs are expected.

Minor (not blocking): each remote member call now makes 1 to 2 extra execute_command round trips (exclude on the first call, delete on every call). Filed as a follow-up. KB MCP was unavailable (apra-fleet ECONNREFUSED), so there are no KB promotions.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
