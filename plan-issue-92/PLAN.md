# Implementation Plan: PM Skill Deploy.md Sourcing from Git Root

**Issue:** #92  
**Complexity:** Complex (workflow changes, PM skill modification)

## Problem Summary

The PM skill currently maintains `deploy.md` in the PM project folder (e.g. `apra-fleet-projects/<project>/deploy.md`). This means:

- The runbook lives outside the project repo and is not version-controlled alongside the code
- It must be manually kept in sync — stale runbooks cause deployment failures
- A new PM session or different operator has no way to discover the authoritative runbook

## Desired Behaviour

1. **Source from project git root first.** When PM needs to deploy, check for `deploy.md` at the project git root. If present, use it as the runbook.

2. **Fall back to PM folder.** If not in git root, fall back to `<pm-folder>/deploy.md` as today.

3. **Develop and push on first success.** If no `deploy.md` exists anywhere, PM should:
   - Work with the user to draft one interactively during the first deploy
   - After a successful deployment, commit and push `deploy.md` to the project git root on the project's base branch
   - Also copy it to the PM folder for local caching

4. **Update on change.** If PM deviates from the runbook (workaround, new step), prompt to update and re-push.

## Implementation Plan

### Phase 1: Update PM Skill Logic
- [ ] Modify `skills/pm/single-pair-sprint.md` deploy section
  - Add step to check for `deploy.md` in project git root first
  - Fall back to `<pm-folder>/deploy.md` if not found
  - Document the precedence order
- [ ] Add logic for first-time deploy:
  - If no `deploy.md` exists anywhere, work with user to create it
  - After successful deploy, commit to project git root
  - Copy to PM folder for caching

### Phase 2: Sync Logic
- [ ] Implement bidirectional sync strategy:
  - If repo version newer, use it and update PM folder cache
  - If PM folder version has manual changes, prompt to push to repo
  - Add timestamp/hash comparison logic
- [ ] Handle conflicts:
  - If both versions exist and differ, prompt user to choose
  - Show diff if possible

### Phase 3: Update Workflow
- [ ] Update PM instructions for deviation handling:
  - When deploy process deviates from runbook, update `deploy.md`
  - Commit and push updated runbook to repo
  - Update PM folder cache
- [ ] Add validation:
  - Verify deploy.md is in git root after first successful deploy
  - Warn if deploy.md is stale

### Phase 4: Testing
- [ ] Test first-time deploy (no deploy.md anywhere)
- [ ] Test with deploy.md in git root only
- [ ] Test with deploy.md in PM folder only
- [ ] Test with both versions (same content)
- [ ] Test with both versions (different content)
- [ ] Test update-and-push workflow

## Estimated Effort
3-5 hours

## Files Affected
- `skills/pm/single-pair-sprint.md`
- Possibly PM skill helper scripts
- Documentation

## Motivation

Deploy runbooks are project artifacts, not PM session state. They should live in the repo, be reviewed like code, and be reusable across sessions and operators.
