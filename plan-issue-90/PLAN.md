# Implementation Plan: Use Claude --auto Permissions for Team/Enterprise

**Issue:** #90  
**Complexity:** Medium-Complex (plan detection, conditional logic)

## Problem Summary

Claude Code ships with an `--auto` flag that enables classifier-based automatic permission approval. This is only available on Team and Enterprise plans — Personal plan members do not have access to it.

## Current Behavior

`compose_permissions` is always used to generate and deliver a provider-native permissions config before every dispatch. This works universally but requires the PM to explicitly compose and deliver permissions for each role change.

## Desired Behavior

- When dispatching to a Claude member: detect whether the member's Claude account is on a Team or Enterprise plan
- If yes: pass `--auto` to the claude CLI invocation instead of delivering a pre-composed permissions file
- If the plan tier cannot be determined (unknown, API error, Personal): fall back to the existing `compose_permissions` approach
- The fallback must be silent — no warnings or errors visible to the PM if detection is unavailable

## Implementation Plan

### Phase 1: Plan Detection Research
- [ ] Research detection methods:
  - `claude --version` output analysis
  - Claude config file inspection (~/.claude/config or similar)
  - API endpoint for account info (if available)
  - Environment variable or flag
- [ ] Determine most reliable method
- [ ] Implement detection with error handling

### Phase 2: Conditional Logic Implementation
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

### Phase 3: Testing
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

### Phase 4: Documentation
- [ ] Update `skills/fleet/permissions.md`:
  - Document `--auto` mode
  - Explain plan detection
  - Explain fallback behavior
- [ ] Update member registration docs:
  - Mention plan tier detection
  - How to force compose_permissions if needed

## Estimated Effort
3-5 hours

## Files Affected
- Dispatch/execution logic (execute_prompt or similar)
- Member configuration schema (for caching plan tier)
- `skills/fleet/permissions.md`
- Tests

## Notes

- `--auto` uses a classifier to approve/deny tool calls automatically, reducing the need for explicit permission lists
- Detection heuristic TBD
- This is a quality-of-life improvement; the compose_permissions path must remain fully functional as the fallback
