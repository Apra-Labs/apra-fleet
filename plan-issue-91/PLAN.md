# Implementation Plan: Fix Git Worktree Path Corruption Bug

**Issue:** #91  
**Complexity:** Complex (server-side changes, agent context, detection logic)

## Problem Summary

When a fleet member's `work_folder` is a git worktree (not a regular repo clone), the fleet server's bash execution context can corrupt the `.git` pointer file, breaking all subsequent git operations for that member. This has never been observed with regular clones — it is specific to worktrees.

## Background: How Git Worktrees Work

A git worktree is a secondary working tree linked to a parent repo. Unlike a regular clone, the worktree directory does not contain a `.git/` directory — it contains a `.git` **file** with a single line:

```
gitdir: C:/akhil/git/apra-fleet/.git/worktrees/apra-fleet-skill-refactor
```

This path points to the worktree's metadata inside the parent repo's `.git/worktrees/` directory.

## What Goes Wrong

Fleet dispatches `execute_command` via a bash shell on Windows members. When git fails for unrelated reasons, the dispatched agent tries to "fix" the worktree by rewriting the `.git` file to use WSL path format (`/mnt/c/...`), which **breaks Windows `git.exe`**.

## Root Cause

Two compounding issues:

1. **Agents modify `.git` files** — they should never do this. The `.git` file in a worktree is repo metadata, not a config file.

2. **No worktree awareness in execute_command** — when the server detects a member's `work_folder` contains a `.git` file (vs a `.git/` directory), it should handle git invocation differently.

## Implementation Plan

### Phase 1: Server-Side Worktree Detection
- [ ] Add worktree detection in member registration:
  - Check if `work_folder/.git` is a file (not directory)
  - Read gitdir path and validate format
  - Store worktree flag in member config
- [ ] Add worktree detection in execute_command:
  - Before command execution, check for `.git` file
  - Set environment flag if worktree detected

### Phase 2: Git Command Handling
- [ ] On Windows members with worktrees:
  - Always use `git.exe` for push/fetch/pull (not bash git)
  - Set GIT_EXEC_PATH or use full path to Windows git binary
  - Avoid bash git which may have different path resolution
- [ ] Add git command wrapper:
  - Detect if command modifies `.git` file
  - Block such modifications
  - Return error with explanation

### Phase 3: Agent Context Updates
- [ ] Update `tpl-doer.md` or agent templates:
  - Add rule: Never modify `.git` files
  - If git fails in a worktree, report blocked (don't try to fix)
  - Provide clear error message for PM intervention
- [ ] Add worktree troubleshooting guidance:
  - Document `git worktree repair` command
  - Add to error messages when worktree issues detected

### Phase 4: Registration Safeguards
- [ ] Option 1: Warn on worktree registration
  - Detect worktree during registration
  - Prompt user to confirm or use regular clone instead
- [ ] Option 2: Auto-repair on registration
  - Run `git worktree repair` during registration
  - Validate path format is correct for platform
- [ ] Add worktree documentation:
  - Known limitations
  - Recommended workarounds
  - How to use worktrees safely with fleet

### Phase 5: Testing
- [ ] Test worktree detection logic
- [ ] Test git operations in worktree (Windows)
- [ ] Test .git file protection (block modifications)
- [ ] Test error handling and user messaging
- [ ] Test regular clone (ensure no regression)
- [ ] Test auto-repair if implemented

## Estimated Effort
6-10 hours (complex, multi-component)

## Files Affected
- `src/services/execute-command.ts` or similar
- `src/services/execute-prompt.ts` or similar
- `src/tools/register-member.ts`
- Agent template files (tpl-doer.md, etc.)
- Member configuration schema
- Documentation

## Workaround (Until Fixed)

If a Windows member's worktree `.git` file gets corrupted with a WSL path, run:

```
git.exe -C "C:\path\to\worktree" worktree repair
```
