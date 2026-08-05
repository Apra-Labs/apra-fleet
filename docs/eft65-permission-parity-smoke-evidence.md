<!-- llm-context: Live-smoke evidence record for apra-fleet-eft.65.8, corroborating
     apra-fleet-eft.65.1 (Edit/Write work-folder parity) and apra-fleet-eft.65.2
     (doer surface-dont-bypass coaching) on branch feat/sprint-service-1. -->
<!-- keywords: eft.65, permission block, Edit/Write parity, doer, smoke test -->

# eft.65 live smoke retest evidence (apra-fleet-eft.65.8)

## Context

This doer was dispatched on branch `feat/sprint-service-1` via the exact prompt
produced by `buildDoerPrompt()` in
`packages/apra-fleet-se/fleet-sprint/runner.js` -- the same function apra-fleet-eft.65.2
patched to append the "PERMISSION BLOCKS MUST BE SURFACED, NOT ROUTED AROUND"
directive to every doer dispatch. The dispatched `.fleet-task.md` prompt text
for this run matched that function's output verbatim, including the
permission-block-surfacing paragraph, confirming apra-fleet-eft.65.2's fix is
live in this dispatch path.

## Fix presence on this branch

Checked directly against source (not git-log commit search, since this branch
has since renamed/restructured `auto-sprint` -> `fleet-sprint` and the original
eft.65.1/eft.65.2 commits are not literal ancestors of this branch, but their
functional changes are present):

- `src/providers/claude.ts` `workspaceEditPermissionFlag()` returns
  `--permission-mode acceptEdits`, with an inline comment citing
  apra-fleet-eft.65.1, granting Edit/Write parity for the dispatched agent's own
  work folder in headless dispatch without the broad
  `--dangerously-skip-permissions` bypass.
- `packages/apra-fleet-se/fleet-sprint/runner.js` `buildDoerPrompt()` includes the
  apra-fleet-eft.65.2 permission-block-surfacing directive verbatim (see comment
  citing apra-fleet-eft.65.2 immediately above the pushed lines).

## Live evidence (this run)

- This file was created with the `Write` tool as a brand-new file in this
  repo's working tree. No permission block occurred; the tool call succeeded
  on the first attempt.
- No Bash heredoc, `cat > file`, wrapper script, or other workaround was used
  at any point in this session to create or edit a file.
- No permission block of any kind (Edit/Write, git push, or otherwise) was
  encountered during this task's execution.

## Result

PASS: Edit/Write parity held for a brand-new file in this dispatch context,
and no route-around workaround was needed or used. This corroborates
apra-fleet-eft.65.1 and apra-fleet-eft.65.2 on `feat/sprint-service-1`.
