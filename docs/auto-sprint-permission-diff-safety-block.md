<!-- llm-context: Why a sprint workflow must never diff-and-self-grant its own
     CLI permissions -- the setup-shell permission-auto-detection pattern is
     blocked by the provider's safety classifier as "Self-Modification" even
     when it would find nothing to grant. States the surface-don't-self-grant
     rule that replaced it. -->
<!-- keywords: auto-sprint, safety classifier, self-modification, permissions.allow, setup-shell -->

# Sprint workflows must surface missing permissions, never self-grant them

## The failure mode

A sprint workflow whose setup phase dispatches a shell step that:

1. Reads `deploy.md` and `integ-test-playbook.md`, looking for a
   `## Permissions` heading and extracting `Bash(...)` entries under it,
2. Reads `.claude/settings.json`'s `permissions.allow` array, and
3. Diffs the two and prints the missing entries,

is blocked outright by the provider's safety classifier:

```
[setup-shell] blocked by safety classifier: [Self-Modification] The delegated
script reads permission declarations from project files and diffs them
against `.claude/settings.json`'s allow-list to identify "missing" Bash
permissions -- clear preparation for auto-widening the agent's own
permission grants, which the user never explicitly requested for this
specific change.
```

The result is a hard stop before a single agent runs: setup fails, no
journal entries are written, and zero work happens.

Two properties make this especially expensive:

- **The classifier judges the code pattern, not the runtime outcome.** The
  block fires even when the diff would have found nothing -- for example in
  a repo whose `deploy.md` has no `## Permissions` section at all, where the
  declared and missing sets would both be empty and the whole
  detect-then-grant machinery would have been a no-op.
- **It fires up front, on the setup dispatch**, because the classifier
  evaluates where the flow is clearly heading (detect-then-self-grant), not
  whether the writing step is a separate, later dispatch.

## The rule

**When something needs granting, the workflow surfaces it; it never grants
it itself.** Auto-provisioning `permissions.allow` from inside a sprint's
own low-trust setup dispatch is exactly the pattern a safety classifier
should be suspicious of. Instead, surface the missing permissions as a
clear, structured message back to the orchestrator or user -- who already
holds the authority to edit settings -- and stop or degrade gracefully if
they are absent. That turns an all-or-nothing setup failure into an
actionable "here is exactly what is missing and why" report the user can act
on in one step.

Two supporting practices follow from the same reasoning:

- **Do not dispatch the classifier-triggering pattern in the common case.**
  Check cheaply for a literal `## Permissions` heading (for example
  `grep -q '^## Permissions' deploy.md`) in the same pass that already
  detects whether the runbooks exist, and skip the diff step entirely when
  neither file declares any permissions. Most sprints are small code fixes
  with no deploy/integ-test permission requirements at all.
- **Make the permission check non-fatal.** If it is blocked or errors, log a
  warning and proceed with an empty missing-permissions set rather than
  aborting the sprint before any agent runs. "Could not check" and "nothing
  missing" should have the same effect for a sprint that does not actually
  need new permissions.

This is the repository-wide rule recorded in `CLAUDE.md`: permission blocks
must be surfaced, not routed around.
