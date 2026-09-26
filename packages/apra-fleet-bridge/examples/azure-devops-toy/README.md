# Azure DevOps toy project: running fleet-bridge from a pipeline

`azure-pipelines.yml` in this directory is a complete pipeline that extends
`packages/apra-fleet-bridge/templates/azure-pipelines.yml`, filled in for the toy
project (org `apralabs`, project `e2e-fleet-testing`, member `aztoy`). Copy it into
the repo your pipeline lives in and change the values marked `CHANGE ME`.

What has and has not been proven: every step's script has been executed against the
real CLI by a local harness (preflight and ingest against the live toy project, launch
against a fake supervisor). The pipeline itself has not yet run on a self-hosted Azure
DevOps agent - the Azure-specific parts (the repository resource, the artifact
upload, the compile-time parameter guard) are unexercised.

Do `packages/apra-fleet-bridge/docs/setup.md` first, by hand, on the agent machine.
A pipeline adds nothing but a trigger; if the loop does not work from a shell, it will
not work from a pipeline, and the errors are far easier to read in a shell.

## What the agent machine needs

The pipeline job runs **on** the machine that runs the sprint. That machine needs,
before the first run:

1. The apra-fleet server, the supervisor and `bd`, as in setup.md.
2. **An apra-fleet source checkout with `npm install` run in it.** fleet-bridge is a
   private workspace package, not a registry package; the template runs
   `node <bridgeHome>/packages/apra-fleet-bridge/bin/fleet-bridge.mjs`. Set the
   `bridgeHome` parameter to that checkout.
3. **`fleet-bridge daemon` running from that same checkout, as the same user the
   agent service runs as.** The job only launches; the daemon watches and finalizes,
   and finalize is what publishes carry-over. The daemon is also where the Azure
   DevOps org/project and any blob storage are configured (setup.md, "Run the
   daemon"). The launch step fails the job if no live daemon claims the sprint within
   a minute, so a missing daemon cannot go unnoticed - but it is much better to start
   it first.
4. A self-hosted agent registered in an agent pool (default name `fleet-sprints`).
   Registering needs a PAT with **Agent Pools (Read & manage)**, a scope the bridge
   itself never uses.
5. On Windows: Git Bash on the agent's PATH (the steps are `bash:` steps), ahead of
   the WSL launcher in `System32`.

## What the pipeline needs

1. **A GitHub service connection** for the repository resource that supplies the
   template (Project settings > Service connections > New > GitHub). Put its name in
   `endpoint:`. Azure DevOps requires one even for a public repository.
2. **`ref:` pinned to the commit or tag your agent's checkout is on.** The template and
   the CLI are versioned together. The CLI rejects any flag it does not know, so a
   mismatch fails on the first step with the offending flag named, instead of
   half-working.
3. **No secrets, no variable group.** The bridge refers to the stored PAT by name
   (`secretName`, default `fleet_bridge_azdevops_pat`, deposited with
   `apra-fleet secret --set fleet_bridge_azdevops_pat --persist` as in setup.md); the
   fleet server substitutes the value itself. No step maps a PAT, a SAS or
   `System.AccessToken`, and "Allow scripts to access the OAuth token" can stay off.

## Parameters

Chosen by whoever queues the run (the example exposes these in the "Run pipeline"
form):

| Parameter | Meaning |
|---|---|
| `workItems` | Work item ids or URLs, **comma**-separated. Must have acceptance criteria, or ingest refuses them. |
| `targetBranch` | The sprint's own new branch; its commits land here. |
| `baseBranch` | The branch the sprint is cut from and the PR targets. Must differ from `targetBranch`. |
| `goal` | Priority ceiling: `P1`, `P1/P2` or `P1/P2/P3`. Not free text. |
| `awaitUntil` | How long the job holds before detaching: `launch`, `plan-round`, `plan-approved` (default), `plan-settled`. |

Fixed per agent, in the example's `extends:` block: `agentPool`, `bridgeHome`,
`member`, `repoPath` (the member's clone - its beads DB lives there),
`repoRemoteUrl`, `secretName`, `maxCycles` (1 or more; 5 is the engine default),
`budget` (USD as a string; empty means no ceiling - `0` would mean a zero-dollar
ceiling), `awaitTimeoutMinutes`, and optionally `requirementsFile`,
`allowMissingCriteria` and `viewerPort` (the port of `fleet-bridge viewer`, if you run
one; default 8788).

Parameter values reach the scripts only as environment variables, never as script
text, and a value containing `$(` is rejected before anything runs (Azure would
otherwise expand it as a macro).

## What a run does

1. **Preflight** - every precondition in one pass; the step fails if any fail-level
   check fails.
2. **Ingest** - pulls the work items into the member's beads DB under a root, and
   prints the root's id.
3. **Launch** - builds the SprintRequest from the parameters, launches against
   ingest's root, holds until `awaitUntil` (or `awaitTimeoutMinutes`), then confirms a
   daemon claimed the sprint.
4. **Publish sprint handle** - the `sprint-handle` artifact: `sprint-handle.json`,
   the join key for `fleet-bridge status/watch/finalize --sprint-id <id>`. Published
   even when launch went red, because the sprint may still be running.
5. **Report** - the sprint id, and a LAN viewer link if a viewer is listening.

A green run means: preflight passed, the plan milestone was reached (or the hold timed
out while the sprint kept going - a timeout never stops a sprint), and a live daemon
owns the sprint. After that the work items get progress comments, a PR is raised
against `baseBranch`, and carry-over lands in the backlog, all from the daemon.

A red run names its reason in the failing step. The most likely first-run failures:
preflight (member busy, no VCS provider, secret name not in the store, base branch not
fetched), ingest (work items without acceptance criteria, or beads' `ado.org` /
`ado.project` not set - setup.md step 5), and launch's watcher check (no daemon, or a
daemon running as a different user or against a different spool directory).
