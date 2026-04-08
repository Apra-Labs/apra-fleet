# Issue Triage Summary
**Date:** 2026-04-08  
**Bot:** GitHub Copilot Agent  
**Task:** Analyze open issues, create PRs for simple fixes, create plans for complex issues

## Summary

**Total Issues Analyzed:** 10  
**Issues Skipped (has PR):** 1  
**Simple Fixes (PR created):** 1  
**Complex Issues (plan needed):** 8  

---

## Issue-by-Issue Analysis

### ✅ Issue #103: Fleet uniqueness check should use host+port+folder
**Status:** SKIPPED - Already has PR #104 (draft)  
**Complexity:** Simple (would be 10-15 lines, 2 files)  
**Action:** None - PR already exists

---

### ✅ Issue #99: cleanup.md blindly removes CLAUDE.md and AGENTS.md
**Status:** FIXED - PR #105 created (draft)  
**Complexity:** Simple (1 file, 1 line changed)  
**Files Changed:**
- `skills/pm/cleanup.md`

**Fix Summary:**
Modified cleanup command to check if files are tracked by git before removing them:
```bash
for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do 
  git ls-files --error-unmatch "$file" 2>/dev/null || rm -f "$file"
done
```

This prevents accidental deletion of sprint deliverables that share names with ephemeral agent context files.

**Recommendation:** ✓ Ready for review - add `bot_reviewed` label

---

### 📋 Issue #100: Track and resolve transitive dependency vulnerabilities
**Status:** NEEDS PLAN  
**Complexity:** Complex (dependency updates, testing, potential breaking changes)

**Analysis:**
- 6 high severity vulnerabilities in transitive dependencies
- Root cause: outdated `@modelcontextprotocol/sdk`
- Fix involves `npm audit fix` which adds 49 packages, changes 7
- Risk of breaking API changes from SDK update

**Plan:**

#### Phase 1: Assessment
- [ ] Run `npm audit` to get current baseline
- [ ] Run `npm audit fix --dry-run` to see proposed changes
- [ ] Review changelog for `@modelcontextprotocol/sdk` between current and proposed versions
- [ ] Identify any breaking API changes

#### Phase 2: Update Dependencies
- [ ] Create feature branch `fix/npm-audit-vulnerabilities`
- [ ] Run `npm audit fix`
- [ ] Review `package-lock.json` changes
- [ ] Update any code affected by SDK API changes

#### Phase 3: Testing
- [ ] Run full test suite: `npm test`
- [ ] Manual testing of MCP server startup
- [ ] Test all MCP tools (register_member, execute_prompt, etc.)
- [ ] Verify no regressions in fleet operations

#### Phase 4: Verification
- [ ] Confirm `npm audit` reports 0 high/critical vulnerabilities
- [ ] All existing tests pass
- [ ] No breaking changes to MCP tool interfaces
- [ ] Update documentation if SDK changes affect usage

**Estimated Effort:** 2-4 hours  
**Files Affected:** `package.json`, `package-lock.json`, potentially TypeScript files using MCP SDK

**Recommendation:** Create this plan as a comment on issue #100, add `bot_reviewed` label

---

### 📋 Issue #98: Support glob patterns and directories in send_files/receive_files
**Status:** NEEDS PLAN  
**Complexity:** Medium-Complex (4 files, SFTP integration, testing)

**Analysis:**
- Currently only accepts individual file paths
- Need to support glob patterns (`tests/*.ts`) and directories (`src/`)
- Affects file transfer core functionality
- Tagged as "good first issue" but requires Node.js fs and SSH/SFTP knowledge

**Plan:**

#### Phase 1: Research & Design
- [ ] Review current `send_files` and `receive_files` implementation
- [ ] Research Node.js glob libraries (e.g., `glob`, `fast-glob`)
- [ ] Review SFTP library capabilities for recursive transfers
- [ ] Design API: should patterns be expanded client-side or server-side?

#### Phase 2: Implementation
- [ ] Add glob pattern expansion in `src/services/file-transfer.ts`
  - Handle directory recursion
  - Handle glob patterns (e.g., `**/*.ts`)
  - Preserve directory structure
- [ ] Update `src/services/sftp.ts`
  - Modify `uploadViaSFTP` to handle multiple files/directories
  - Modify `downloadViaSFTP` to handle multiple files/directories
  - Ensure recursive transfer works correctly
- [ ] Update tool schemas in `src/tools/send-files.ts` and `src/tools/receive-files.ts`
  - Update parameter descriptions
  - Add examples showing glob patterns and directories
- [ ] Add dependency if needed (e.g., `fast-glob`)
  - Check for vulnerabilities before adding

#### Phase 3: Testing
- [ ] Unit tests for glob expansion logic
- [ ] Integration tests for directory transfer
- [ ] Integration tests for glob pattern transfer
- [ ] Test edge cases:
  - Empty directories
  - Nested directories
  - Non-existent patterns
  - Mixed paths (some files, some globs)
- [ ] Manual testing with actual SFTP transfers

#### Phase 4: Documentation
- [ ] Update tool descriptions with examples
- [ ] Update README or documentation with glob pattern usage
- [ ] Add migration notes if behavior changes

**Estimated Effort:** 4-8 hours  
**Files Affected:**
- `src/services/sftp.ts`
- `src/services/file-transfer.ts`
- `src/tools/send-files.ts`
- `src/tools/receive-files.ts`
- Tests files
- Possibly `package.json` for new dependency

**Recommendation:** Create this plan as a comment on issue #98, add `bot_reviewed` label

---

### 📋 Issue #96: Installer fails on Windows when MCP server is running
**Status:** NEEDS PLAN  
**Complexity:** Medium-Complex (platform-specific code, process management)

**Analysis:**
- Windows locks executables while running
- Need to detect and stop MCP server process before replacing binary
- Platform-specific solution required
- Affects installer scripts

**Plan:**

#### Phase 1: Detection
- [ ] Research process detection methods on Windows
  - Process name matching (`apra-fleet.exe`)
  - PID file approach
  - Port-based detection (if MCP server listens on a port)
- [ ] Implement detection in installer scripts
  - `install.cmd` for Windows batch
  - `install.ps1` for PowerShell

#### Phase 2: Graceful Shutdown
- [ ] Option 1: HTTP shutdown endpoint
  - Add `/shutdown` endpoint to MCP server
  - Installer calls endpoint before replacing binary
  - Wait for process to exit (with timeout)
- [ ] Option 2: Process termination
  - Use `taskkill /IM apra-fleet.exe` on Windows
  - Implement with fallback to `/F` flag if graceful fails
- [ ] Implement shutdown logic in installer

#### Phase 3: Binary Replacement
- [ ] Verify process has stopped before copying
- [ ] Copy new binary with retry logic (handle lingering locks)
- [ ] Set appropriate permissions

#### Phase 4: Restart/Notification
- [ ] Option 1: Auto-restart MCP server
  - May not work if Claude Code needs to reload config
- [ ] Option 2: Notify user to restart Claude Code
  - Print clear instructions
  - Detect Claude Code process and suggest specific restart

#### Phase 5: Testing
- [ ] Test on Windows with MCP server running
- [ ] Test graceful shutdown
- [ ] Test forced shutdown
- [ ] Test when server is not running
- [ ] Test restart/notification flow

**Estimated Effort:** 4-6 hours  
**Files Affected:**
- `install.cmd` (Windows batch installer)
- `install.ps1` (PowerShell installer)
- Possibly `src/index.ts` if adding shutdown endpoint
- Documentation/README with installation notes

**Recommendation:** Create this plan as a comment on issue #96, add `bot_reviewed` label

---

### 📋 Issue #92: PM skill should source deploy.md from project git root
**Status:** NEEDS PLAN  
**Complexity:** Complex (workflow changes, PM skill modification)

**Analysis:**
- Currently deploy.md lives in PM project folder, outside repo
- Need to prioritize repo version, fall back to PM folder
- Create and commit deploy.md on first successful deploy
- Affects PM skill workflow

**Plan:**

#### Phase 1: Update PM Skill Logic
- [ ] Modify `skills/pm/single-pair-sprint.md` deploy section
  - Add step to check for `deploy.md` in project git root first
  - Fall back to `<pm-folder>/deploy.md` if not found
  - Document the precedence order
- [ ] Add logic for first-time deploy:
  - If no `deploy.md` exists anywhere, work with user to create it
  - After successful deploy, commit to project git root
  - Copy to PM folder for caching

#### Phase 2: Sync Logic
- [ ] Implement bidirectional sync strategy:
  - If repo version newer, use it and update PM folder cache
  - If PM folder version has manual changes, prompt to push to repo
  - Add timestamp/hash comparison logic
- [ ] Handle conflicts:
  - If both versions exist and differ, prompt user to choose
  - Show diff if possible

#### Phase 3: Update Workflow
- [ ] Update PM instructions for deviation handling:
  - When deploy process deviates from runbook, update `deploy.md`
  - Commit and push updated runbook to repo
  - Update PM folder cache
- [ ] Add validation:
  - Verify deploy.md is in git root after first successful deploy
  - Warn if deploy.md is stale

#### Phase 4: Testing
- [ ] Test first-time deploy (no deploy.md anywhere)
- [ ] Test with deploy.md in git root only
- [ ] Test with deploy.md in PM folder only
- [ ] Test with both versions (same content)
- [ ] Test with both versions (different content)
- [ ] Test update-and-push workflow

**Estimated Effort:** 3-5 hours  
**Files Affected:**
- `skills/pm/single-pair-sprint.md`
- Possibly PM skill helper scripts
- Documentation

**Recommendation:** Create this plan as a comment on issue #92, add `bot_reviewed` label

---

### 📋 Issue #91: Git worktree .git file path corrupted by bash shell context
**Status:** NEEDS PLAN  
**Complexity:** Complex (server-side changes, agent context, detection logic)

**Analysis:**
- Git worktrees use `.git` file (not directory) with path to parent repo
- Agents sometimes "fix" the path, breaking it for Windows git.exe
- Need worktree detection and protection mechanisms
- Affects execute_command, execute_prompt, and agent templates

**Plan:**

#### Phase 1: Server-Side Worktree Detection
- [ ] Add worktree detection in member registration:
  - Check if `work_folder/.git` is a file (not directory)
  - Read gitdir path and validate format
  - Store worktree flag in member config
- [ ] Add worktree detection in execute_command:
  - Before command execution, check for `.git` file
  - Set environment flag if worktree detected

#### Phase 2: Git Command Handling
- [ ] On Windows members with worktrees:
  - Always use `git.exe` for push/fetch/pull (not bash git)
  - Set GIT_EXEC_PATH or use full path to Windows git binary
  - Avoid bash git which may have different path resolution
- [ ] Add git command wrapper:
  - Detect if command modifies `.git` file
  - Block such modifications
  - Return error with explanation

#### Phase 3: Agent Context Updates
- [ ] Update `tpl-doer.md` or agent templates:
  - Add rule: Never modify `.git` files
  - If git fails in a worktree, report blocked (don't try to fix)
  - Provide clear error message for PM intervention
- [ ] Add worktree troubleshooting guidance:
  - Document `git worktree repair` command
  - Add to error messages when worktree issues detected

#### Phase 4: Registration Safeguards
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

#### Phase 5: Testing
- [ ] Test worktree detection logic
- [ ] Test git operations in worktree (Windows)
- [ ] Test .git file protection (block modifications)
- [ ] Test error handling and user messaging
- [ ] Test regular clone (ensure no regression)
- [ ] Test auto-repair if implemented

**Estimated Effort:** 6-10 hours (complex, multi-component)  
**Files Affected:**
- `src/services/execute-command.ts` or similar
- `src/services/execute-prompt.ts` or similar
- `src/tools/register-member.ts`
- Agent template files (tpl-doer.md, etc.)
- Member configuration schema
- Documentation

**Recommendation:** Create this plan as a comment on issue #91, add `bot_reviewed` label

---

### 📋 Issue #90: Use claude --auto permissions mode for Team/Enterprise
**Status:** NEEDS PLAN  
**Complexity:** Medium-Complex (plan detection, conditional logic)

**Analysis:**
- Claude Code has `--auto` flag for automatic permissions (Team/Enterprise only)
- Need to detect user's plan tier
- Fall back to compose_permissions for Personal plan or detection failure
- Should be silent/graceful fallback

**Plan:**

#### Phase 1: Plan Detection Research
- [ ] Research detection methods:
  - `claude --version` output analysis
  - Claude config file inspection (~/.claude/config or similar)
  - API endpoint for account info (if available)
  - Environment variable or flag
- [ ] Determine most reliable method
- [ ] Implement detection with error handling

#### Phase 2: Conditional Logic Implementation
- [ ] Modify dispatch logic (execute_prompt or similar):
  - Detect plan tier before dispatch
  - If Team/Enterprise: use `--auto` flag
  - If Personal or unknown: fall back to compose_permissions
- [ ] Ensure fallback is silent:
  - No errors or warnings if detection fails
  - Seamless UX for users
- [ ] Cache detection result:
  - Store in member config to avoid repeated checks
  - Add refresh mechanism if plan changes

#### Phase 3: Testing
- [ ] Test with Team/Enterprise account (if available)
  - Verify `--auto` flag is used
  - Verify permissions work correctly
- [ ] Test with Personal account
  - Verify fallback to compose_permissions
  - Verify no errors or warnings
- [ ] Test with detection failure
  - Simulate API error, missing config, etc.
  - Verify graceful fallback
- [ ] Test plan upgrade scenario
  - User upgrades from Personal to Team
  - Verify detection refresh works

#### Phase 4: Documentation
- [ ] Update `skills/fleet/permissions.md`:
  - Document `--auto` mode
  - Explain plan detection
  - Explain fallback behavior
- [ ] Update member registration docs:
  - Mention plan tier detection
  - How to force compose_permissions if needed

**Estimated Effort:** 3-5 hours  
**Files Affected:**
- Dispatch/execution logic (execute_prompt or similar)
- Member configuration schema (for caching plan tier)
- `skills/fleet/permissions.md`
- Tests

**Recommendation:** Create this plan as a comment on issue #90, add `bot_reviewed` label

---

### 📋 Issue #77: Slack notifications for fleet state changes
**Status:** NEEDS PLAN  
**Complexity:** Complex (new feature, watcher process, Slack integration)

**Analysis:**
- Backlog item marked as "Future"
- Standalone watcher process
- Reads statusline-state.json and sends Slack webhooks
- Opt-in feature

**Plan:**

#### Phase 1: Design
- [ ] Review `statusline-state.json` format
- [ ] Define notification triggers:
  - Member hits verify checkpoint
  - Member becomes blocked
  - Member goes offline unexpectedly
- [ ] Design configuration:
  - Slack webhook URL per fleet
  - Enabled/disabled flag
  - Notification filtering options

#### Phase 2: Watcher Process Implementation
- [ ] Create watcher service:
  - Periodic polling of statusline-state.json
  - State change detection logic
  - Debouncing to avoid notification spam
- [ ] Implement Slack integration:
  - POST to webhook URL
  - Format notification messages
  - Include relevant context (member name, state, timestamp)
  - Handle webhook errors gracefully

#### Phase 3: Configuration
- [ ] Add Slack settings to fleet configuration:
  - Webhook URL
  - Enabled flag
  - Polling interval
  - Notification filters
- [ ] Add CLI command or tool to configure Slack:
  - Test webhook connection
  - Enable/disable notifications

#### Phase 4: Testing
- [ ] Unit tests for state change detection
- [ ] Integration tests with mock Slack webhook
- [ ] Manual testing with real Slack workspace
- [ ] Test error handling (webhook down, network issues)
- [ ] Test performance impact of polling

#### Phase 5: Documentation
- [ ] Setup guide for Slack integration
- [ ] Webhook configuration instructions
- [ ] Notification format examples
- [ ] Troubleshooting guide

**Estimated Effort:** 8-12 hours (full feature)  
**Files Affected:**
- New watcher service file(s)
- Configuration schema
- CLI or tool for Slack setup
- Documentation
- Tests

**Recommendation:** This is marked as "Future" - create plan as comment on issue #77, add `bot_reviewed` label, but low priority

---

### 📋 Issue #76: Research GitHub App installation token scope limitations
**STATUS:** NEEDS RESEARCH PLAN  
**Complexity:** Complex (research task, not implementation)

**Analysis:**
- GitHub App tokens have limited permissions
- Cannot push workflow files (requires `workflows` permission)
- `gh` CLI may not work with installation tokens
- Need to research and document findings

**Research Plan:**

#### Phase 1: GitHub App Permissions Research
- [ ] Review GitHub App permissions documentation:
  - Available permissions for GitHub Apps
  - How to request `workflows` permission
  - Scope limitations vs OAuth/PAT
- [ ] Test current GitHub App:
  - Attempt to push workflow file with installation token
  - Document exact error message
  - Check App settings in GitHub

#### Phase 2: CLI Compatibility Research
- [ ] Test `gh` CLI with installation tokens:
  - Try `gh pr merge` with installation token
  - Try `gh api` with installation token
  - Document which commands work vs fail
- [ ] Research `gh` authentication methods:
  - Does `gh` support GitHub App tokens?
  - What token types does `gh` expect?
  - Workarounds or alternatives?

#### Phase 3: Solutions Analysis
- [ ] Option 1: Broader-scoped tokens
  - Can we add `workflows` permission to GitHub App?
  - What are security implications?
  - Would this fix gh CLI issues?
- [ ] Option 2: Route through PM
  - Keep narrow-scoped tokens for members
  - PM handles CI/workflow pushes with full auth
  - Pros/cons of this approach
- [ ] Option 3: Hybrid approach
  - Use installation tokens for most operations
  - Fall back to OAuth/PAT for specific operations
  - Complexity vs benefit analysis

#### Phase 4: Documentation
- [ ] Document findings in issue comment or doc file:
  - Current limitations (with examples)
  - Tested workarounds
  - Recommended solution with rationale
  - Implementation plan if solution identified
- [ ] Update `provision_vcs_auth` documentation:
  - Known limitations
  - Workaround instructions
  - When to use PM vs member auth

**Estimated Effort:** 4-6 hours (research + documentation)  
**Deliverable:** Research findings document, not code

**Recommendation:** Create this research plan as comment on issue #76, add `bot_reviewed` label, mark as "high priority" per issue description

---

## Limitations Encountered

During this triage, I encountered the following limitations:

1. **Cannot add labels directly:** The GitHub MCP tools available to me only support reading issues, not modifying them (adding labels, creating comments). I can only create PRs.

2. **Cannot create multi-branch PRs easily:** The `report_progress` tool pushes to a single PR branch. To create separate PRs for each issue, I would need a different workflow or permissions to push to multiple branches.

3. **Cannot add comments to issues:** I cannot programmatically attach the above plans to their respective issues as comments. This would need to be done manually or with additional GitHub API write permissions.

## Recommendations

### For Completed Work:
- **Issue #99:** Review and merge PR #105, then manually add `bot_reviewed` label

### For Complex Issues Needing Plans:
The following issues need the plans above to be added as comments, then labeled with `bot_reviewed`:
- Issue #100 (npm audit)
- Issue #98 (glob patterns)
- Issue #96 (Windows installer)
- Issue #92 (PM skill deploy.md)
- Issue #91 (git worktree)
- Issue #90 (claude --auto)
- Issue #77 (Slack notifications - future)
- Issue #76 (GitHub App research - high priority)

### Permission Requests:
To fully automate this workflow in the future, the bot would need:
- GitHub API write permissions to add labels to issues
- GitHub API write permissions to create comments on issues
- Ability to push to multiple branches (or a different PR workflow)

---

**Generated by:** GitHub Copilot Agent  
**Session ID:** ea976057-0203-433f-88ce-ec0ae1737ca8
