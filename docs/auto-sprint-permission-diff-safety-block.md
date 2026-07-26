<!-- llm-context: Records a real auto-sprint workflow failure (2026-07-05) for whoever
     next maintains packages/apra-fleet-se/apra-pm's auto-sprint.js -- the setup-shell step's
     permission-auto-detection logic gets blocked by the safety classifier as
     "Self-Modification" even when it would find nothing to grant. -->
<!-- keywords: auto-sprint, safety classifier, self-modification, permissions.allow, setup-shell -->

# auto-sprint workflow: setup-shell blocked by safety classifier

## What happened

Invoked `Workflow({ name: 'auto-sprint', args: { issues: [...], branch:
'feat/hub-spoke-migration', goal: 'P1/P2/P3/P4' } })` against three small,
non-deployment code-fix issues in apra-fleet-reorg. The workflow failed
immediately at its first step:

```
[setup-shell] blocked by safety classifier: [Self-Modification] The delegated
script reads permission declarations from project files and diffs them
against `.claude/settings.json`'s allow-list to identify "missing" Bash
permissions -- clear preparation for auto-widening the agent's own
permission grants, which the user never explicitly requested for this
specific change.
```

Result: `{"error":"setup failed"}`, zero agents ran, zero tokens spent
beyond the blocked dispatch.

## Root cause

`~/.claude/workflows/auto-sprint.js`'s setup phase (around line 1132-1150)
unconditionally includes a `node -e` command in its very first
`dispatchShell` call that:
1. Reads `deploy.md` and `integ-test-playbook.md`, looking for a
   `## Permissions` heading and extracting `Bash(...)` entries under it.
2. Reads `.claude/settings.json`'s `permissions.allow` array.
3. Diffs the two and prints the missing entries (comma-joined).

A LATER, separate agent dispatch (`step5Block`, Phase 2) is the one that
would actually WRITE any missing entries into `.claude/settings.json`. But
the safety classifier evaluates the setup-shell dispatch's code pattern
up front and blocks it based on where the whole flow is clearly heading
(detect-then-self-grant), not on whether anything is actually missing at
runtime.

**In this specific run, the block was for nothing:** `deploy.md` exists in
apra-fleet-reorg but has **no `## Permissions` section at all** --
confirmed via `grep -n "## Permissions" deploy.md` (zero matches). Had the
node script actually been allowed to run, `declared` would have been `[]`,
`missing` would have been `[]`, and Step 5 would have printed "Already
satisfied... Do nothing." The entire step-5/6 machinery was dead weight
for this sprint's actual issues (three small code fixes, no deployment
step involved at all), and it never got the chance to determine that
itself before being blocked.

## Recommended improvements to auto-sprint.js

1. **Skip the permission-diff step entirely when there's nothing to
   check.** The script already computes `_deployExists`/`_playbookExists`
   as separate outputs -- cheaply extend that same shell pass to also
   check for a literal `## Permissions` heading (e.g.
   `grep -q '^## Permissions' deploy.md`) BEFORE deciding whether to
   include the diff-and-print `node -e` command at all. If neither file
   has a Permissions section, skip step 6 outright and hardcode
   `_missingPerms = []` -- no classifier-triggering code pattern is even
   dispatched for the common case (most sprints are small code fixes with
   no deploy/integ-test playbook requirements).

2. **When there IS something to check, don't have the sprint self-grant.**
   Even in the legitimate case (a project's deploy.md really does declare
   Bash permissions a sprint needs), auto-provisioning permissions.allow
   from within the sprint's own low-trust setup dispatch is exactly the
   pattern a safety classifier should be suspicious of. Prefer: have the
   workflow SURFACE the missing permissions as a clear, structured message
   back to the top-level orchestrator/user (who already has the authority
   to edit settings.json), and stop or degrade gracefully if they're not
   present, rather than attempting to add them itself. This turns a
   blocked, all-or-nothing setup failure into an actionable "here's
   exactly what's missing and why" message the user can act on in one
   step, without the workflow needing self-grant authority at all.

3. **Fail more gracefully on classifier block.** The current failure mode
   is a hard stop with no partial progress and no journal entries (the
   journal.jsonl for this run doesn't even exist, since setup never
   completed). Consider making the permission-diff step non-fatal --
   if it's blocked or errors, log a warning and proceed with
   `_missingPerms = []` (treat "couldn't check" the same as "nothing
   missing" for sprints that don't actually need new permissions), rather
   than aborting the entire sprint before a single agent runs.

## What was done instead

Given the workflow couldn't run, the three underlying beads issues
(apra-fleet-8yn, apra-fleet-36x, apra-fleet-y2f -- all filed from an
independent adversarial review's findings) were implemented directly
rather than through auto-sprint. See the commits following this doc's
addition for that work.
