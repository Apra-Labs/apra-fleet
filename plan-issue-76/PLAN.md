# Research Plan: GitHub App Installation Token Scope Limitations

**Issue:** #76  
**Complexity:** Complex (research task, not implementation)  
**Priority:** High

## Problem Summary

GitHub App installation tokens minted by `provision_vcs_auth` have restricted permissions that cause friction:

1. **Cannot push workflow files** (`.github/workflows/*.yml`) — requires `workflows` permission, not available on fine-grained tokens by default
2. **`gh` CLI compatibility** — installation tokens may not work with all `gh` commands (e.g. `gh pr merge`, `gh api`) that expect OAuth/PAT
3. **Workaround today:** PM creates PRs and merges from the controller (full `gh` auth), or user manually pushes CI files

## Research Questions

- Can the GitHub App be configured with `workflows` permission at the App level?
- Does `gh` CLI work with installation tokens at all?
- Should we mint broader-scoped tokens, or keep them narrow and route CI/gh operations through PM permanently?

## Research Plan

### Phase 1: GitHub App Permissions Research
- [ ] Review GitHub App permissions documentation:
  - Available permissions for GitHub Apps
  - How to request `workflows` permission
  - Scope limitations vs OAuth/PAT
- [ ] Test current GitHub App:
  - Attempt to push workflow file with installation token
  - Document exact error message
  - Check App settings in GitHub

### Phase 2: CLI Compatibility Research
- [ ] Test `gh` CLI with installation tokens:
  - Try `gh pr merge` with installation token
  - Try `gh api` with installation token
  - Document which commands work vs fail
- [ ] Research `gh` authentication methods:
  - Does `gh` support GitHub App tokens?
  - What token types does `gh` expect?
  - Workarounds or alternatives?

### Phase 3: Solutions Analysis
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

### Phase 4: Documentation
- [ ] Document findings in issue comment or doc file:
  - Current limitations (with examples)
  - Tested workarounds
  - Recommended solution with rationale
  - Implementation plan if solution identified
- [ ] Update `provision_vcs_auth` documentation:
  - Known limitations
  - Workaround instructions
  - When to use PM vs member auth

## Estimated Effort
4-6 hours (research + documentation)

## Deliverable
Research findings document, not code

## Status
Backlog item #15 from docs/MCP-BACKLOG.md. High priority.
