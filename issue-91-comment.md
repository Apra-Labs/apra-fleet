## Research: Git Worktree .git Corruption on Windows

### 1. Where does the fleet server resolve/use `work_folder`?

`workFolder` is defined on the `Agent` interface at **`src/types.ts:17`** and used throughout:

| File | Line(s) | Usage |
|------|---------|-------|
| `src/tools/execute-command.ts` | 169 | `resolveTilde(input.run_from ?? agent.workFolder)` — resolves folder for command execution |
| `src/tools/execute-prompt.ts` | 104 | `resolveTilde(agent.workFolder)` — sets up prompt execution context |
| `src/services/strategy.ts` | 43 | `this.agent.workFolder` in RemoteStrategy.deleteFiles |
| `src/services/strategy.ts` | 77 | `exec(wrapped, { cwd: this.agent.workFolder, ...` in LocalStrategy.execCommand |
| `src/services/strategy.ts` | 101-102 | Destination base in LocalStrategy.transferFiles |
| `src/services/strategy.ts` | 131, 147, 152-153 | LocalStrategy.receiveFiles and testConnection |

### 2. Is there any existing worktree detection?

**NO.** No `.git` file vs directory checks exist anywhere in the codebase.

- `src/version.ts:24-28` reads `.git/HEAD` for dev version detection, but only for the fleet server itself
- Git operations use bare `git` command (not `git.exe`) everywhere:
  - `src/os/windows.ts:259-260` — `gitCurrentBranch()` invokes `git` via PowerShell
  - `src/os/linux.ts:230-231` — same with bash `git`
  - `src/os/windows.ts:219-220, 226` — credential helper setup also uses bare `git`

### 3. Best place to add worktree detection

**Recommended: Strategy Layer (`src/services/strategy.ts`)**

Add `isWorktree()` to the `AgentStrategy` interface (lines 15-23) and implement in both `RemoteStrategy` and `LocalStrategy`:
- **LocalStrategy**: `fs.statSync(path.join(workFolder, '.git')).isFile()` — if `.git` is a file (not directory), it's a worktree
- **RemoteStrategy**: Execute shell check over SSH: `test -f <workFolder>/.git && echo true || echo false`
- Cache the result on the strategy instance to avoid repeated checks

Then in **`src/os/windows.ts:259-260`** and credential helper methods, use `git.exe` explicitly when worktree is detected. This is the root fix — bash-bundled `git` on Windows mishandles the `.git` file reference in worktrees.

Secondary option: Add detection in `execute-command.ts` at line ~216 (before command wrapping), but this is higher in the stack and would need to be duplicated for `execute-prompt.ts`.

### 4. Guard against agent writes to `.git` file

**Available hook points:**

**Hook 1: `execute-command.ts:130-170`** (after credential token resolution)
- Add regex check for commands writing to `.git` paths
- Pattern already exists: lines 38-39, 58-60 check for raw `sec://` handles — same approach works
- Check: `/\.git[\\\/]/` combined with write indicators (`echo`, `Set-Content`, `tee`, `printf`, `>`)

**Hook 2: `strategy.ts:28-30`** (SSH exec entry point in RemoteStrategy)
- Add `isDangerous(command)` guard before executing via SSH
- Pro: catches all commands regardless of entry point
- Con: regex-based filtering has false positive risk (e.g. `git -C repo/.git-mirror`)

**Limitation:** Cannot reliably block all shell-level operations (e.g. `sh -c "echo x > .git/HEAD"`). The real fix is using `git.exe` on Windows, not trying to filter every possible write. The command filtering is a defense-in-depth layer.

### 5. tpl-doer.md change complexity

**TRIVIAL** — 1-2 lines of documentation.

The file is at `skills/pm/doer-reviewer.md`. The safeguards section (lines 64-76) already has a table of restrictions. Add one row for `.git` file protection, and add a note to the "Git as transport" section (lines 78-82):

> "Doers and reviewers NEVER modify `.git` files directly — all git operations must use the `git` CLI, which is automatically routed to `git.exe` on Windows to prevent worktree corruption."

### 6. Implementation complexity estimate

**MEDIUM** (~9.5 hours)

| Component | Effort | Notes |
|-----------|--------|-------|
| Worktree detection in strategy layer | 2h | Add `isWorktree()` + caching in both strategy classes |
| Force `git.exe` on Windows | 1.5h | Update `gitCurrentBranch()` + credential helpers in `windows.ts` |
| Command filtering in `execute-command.ts` | 1h | Regex guard at line ~132, following existing `sec://` pattern |
| Strategy-level `isDangerous()` guard | 2h | Careful regex to avoid false positives |
| Testing on Windows with real worktree | 3h | Non-trivial environment setup, cross-platform verification |
| Documentation (doer-reviewer.md) | 0.5h | Add safeguard row + git transport note |

**Why MEDIUM:** Cross-platform concerns (Windows PowerShell escaping vs bash), false positive risk in command filtering, and need for real worktree testing make this more than a quick fix. But no architectural changes needed — it's localized to strategy, os-commands, and execute-command layers.

### Root cause summary

On Windows with git worktrees, `.git` is a **file** (containing `gitdir: /path/to/parent/.git/worktrees/name`) not a **directory**. When bash-bundled `git` runs in this context, it can mishandle the `.git` file reference. The fix is: detect worktree status, then enforce native `git.exe` for all git operations on Windows worktree members.
