# Azure DevOps toy project: fleet-bridge setup

This example has **NOT yet been run against a live Azure DevOps project** - credentials
are not available yet - so it is a reviewed starting point, not a proven recipe. The
pipeline logic is sound, but the exact steps for granting agent pool access and
configuring storage may vary based on your Azure DevOps and storage setup.

## Overview

The `azure-pipelines.yml` in this directory extends the self-contained template at
`templates/azure-pipelines.yml`, filling in concrete values for the toy project.
To adopt this for your own project, follow the checklist below top to bottom.

## Adaptation checklist

### 1. Replace placeholder values in azure-pipelines.yml

The file uses obvious placeholders to mark what must change:

- `YOUR-ORG` - Your Azure DevOps organization name (in the URL:
  `https://dev.azure.com/YOUR-ORG`)
- `YOUR-PROJECT` - Your Azure DevOps project name
- `YOUR-ACCOUNT` - Your Azure Blob Storage account name (if using the blob sink;
  omit the blob parameters if you do not want remote logging)

Replace these with your actual values. Do **not** add real credentials yet - only
the names and paths.

Example:
```yaml
adoOrgUrl: 'https://dev.azure.com/mycompany'
adoProject: 'DevOps'
blobAccountUrl: 'https://mycompanylogs.blob.core.windows.net'
blobContainer: 'sprint-logs'
```

### 2. Create a variable group in Azure DevOps

In your Azure DevOps project:

1. Go to **Pipelines** > **Library** > **Variable groups**
2. Create a new variable group named `fleet-bridge-secrets`
3. Add the following variables:
   - `adoPatSecret` - Your Azure DevOps PAT (mark as secret)
   - `blobSasSecret` (if using blob sink) - Short-lived SAS token for blob write
     access (mark as secret)
4. Save the group

The pipeline uses `$(adoPatSecret)` and similar to reference these without
exposing them in logs.

### 3. Register a service connection (if using blob sink)

If you are using `blobAccountUrl` and `blobContainer` (remote logging to blob
storage):

1. Go to **Project Settings** > **Service connections**
2. Create a new **Azure Resource Manager** service connection
3. Note the service connection name and reference it in the blob sink
   configuration

### 4. Ensure the agent pool exists and is registered

1. Register this machine in the `fleet-sprints` agent pool
   - Go to **Agent pools** and create one if needed
   - Register this machine as an agent
   - Confirm the pool name matches the `agentPool` parameter in
     `azure-pipelines.yml`
2. Verify the fleet server and supervisor are running on this agent
3. Register at least one fleet member with `vcsProvider` set (e.g., for git
   operations)

### 5. Deposit the PAT into the fleet credential store

This is a **one-time, out-of-band step** that keeps the secret out of the
pipeline definition:

```bash
apra-fleet secret --set fleet_bridge_azdevops_pat --persist
# Paste your Azure DevOps PAT when prompted
# It is now stored locally and never needs to appear in the pipeline again
```

Note: the bridge's own default credential name is `fleet_bridge_azdevops_pat`,
deliberately not `azdevops_pat` -- that name is already used by an unrelated
system at some operators' sites. The sprint engine itself still defaults to
its own `azdevops_pat_secret_name` arg (default `azdevops_pat`) for
`provision_vcs_auth`; this bridge's `launch` step forwards its own configured
name to the engine via the `patSecretName` field so the two never diverge (see
`--ado-pat-secret-name` below).

The pipeline only references the **name** `fleet_bridge_azdevops_pat`, not the
value. The credential store substitutes the real value at runtime via
`{{secret.fleet_bridge_azdevops_pat}}`, server-side, where it is never exposed
to logs or third-party services.

If you need to rotate the PAT, run the same command with the new value; it
overwrites the stored value.

**Why this pattern:** The fleet server controls secret substitution. A secret
that is never an argv element, a file, or a logged string is safe by
construction. Verification (next step) confirms this.

### 6. Verify with fleet-bridge preflight

Before the first real pipeline trigger:

```bash
cd <your-repo>
npm exec --yes fleet-bridge preflight \
  --member toy-member-1 \
  --ado-org-url https://dev.azure.com/YOUR-ORG \
  --ado-project YOUR-PROJECT \
  --agent-pool fleet-sprints \
  --ado-pat-secret-name fleet_bridge_azdevops_pat
```

This will:
- Check supervisor connectivity
- Verify the member is registered
- Confirm the PAT is in the credential store (by name only, never by value)
- Verify the target branch is resolvable
- Confirm the agent pool exists

If `preflight` passes, the pipeline run will also pass. If it fails, fix the
named problem (e.g., missing member, PAT not in store) and re-run preflight.

### 7. Grant pipeline permissions

In your Azure DevOps project settings:

1. Go to **Pipelines** > **Settings**
2. Enable **Make secrets available to builds of forks** (if the repo is forked)
3. Enable **Allow scripts to access the OAuth token** - the template uses
   `$(System.AccessToken)` for Azure DevOps REST calls (work-item comments,
   build status updates)

Without this, `System.AccessToken` is empty and those calls will fail.

### 8. Configure storage account CORS (if using blob sink)

If you are uploading sprint logs to blob storage, the static website origin
(e.g., `https://mycompanylogs.z13.web.core.windows.net`) must be allowed to
fetch data from the blob origin (`https://mycompanylogs.blob.core.windows.net`).

This requires an account-level CORS rule. **Easy to miss; produces a blank page
rather than an error.**

In the Azure Storage account:

1. Go to **Resource Sharing (CORS)** under **Settings** > **Blob service**
2. Add a CORS rule:
   - **Allowed origins:** `https://YOUR-ACCOUNT.z13.web.core.windows.net`
   - **Allowed methods:** `GET`
   - **Allowed headers:** `*`
   - **Exposed headers:** `*`
   - **Max age:** `3600`
3. Save

Without this, the static website viewer will fetch `state.json` and get a CORS
error, leaving the page blank. With it, the page loads and updates normally.

### 9. Link the variable group to the pipeline

If your variable group is not automatically linked:

1. Edit the pipeline definition
2. In the **Variables** tab, link the `fleet-bridge-secrets` variable group
3. Save

### 10. Trigger the pipeline

1. Edit `azure-pipelines.yml` and set `workItems` to a real work-item ID from
   your project (or semicolon-separated IDs)
2. Commit and push the file
3. Go to **Pipelines** and manually trigger a run, or push to a branch that has
   the pipeline configured

The job will:
1. Run `fleet-bridge preflight` - verify all preconditions (10-15 seconds)
2. Run `fleet-bridge ingest` - pull work items (10-30 seconds)
3. Run `fleet-bridge launch --await-until plan-approved` - start the sprint and
   wait for the first planning round to complete and be approved (10-30 minutes,
   depending on work)
4. **Exit green**, while the sprint continues as a detached child process

## What success looks like

A successful run shows:

- **Job exits green** after the `await` milestone, usually within 20-30 minutes
  (configurable via `awaitTimeoutMinutes`)
- **Sprint is still running** after the job ends - you can check this by opening
  the LAN viewer URL or running `fleet-bridge status` on the runner
- **No secrets in logs** - search the job log for the PAT, SAS token, or bearer
  token; they must not appear
- **Sprint results published** - after the sprint finishes, a work-item comment
  is posted with a link to the results and carry-over items are created as new
  work items in the backlog

If the job exits red:
- Check the `preflight` step first - it lists all preconditions
- If preflight passed but `ingest` failed, check the work-item titles and
  acceptance criteria format
- If `launch` failed, check the member is registered and has sufficient budget
- Rerun `preflight` to confirm the setup

## Alternative: self-contained copy without extends

If your organization prefers not to add a `resources: repositories:` entry to
reference a template across repos, you can copy the entire content of
`templates/azure-pipelines.yml` directly into this file, replacing the
`extends:` block. Everything else stays the same.

This trades 10 extra lines of boilerplate for one fewer shared dependency.
Either approach is valid.

## Next steps

1. Follow the checklist above
2. Run `fleet-bridge preflight` to verify setup
3. Trigger the pipeline with a small set of test work items
4. Observe the run and adjust parameters (budget, timeout, await milestone) as
   needed
5. Once comfortable, integrate into your CI/CD process or trigger manually as
   needed

## Further reading

- `packages/apra-fleet-se/docs/fleet-bridge-implementation-plan.md` - Part C
  covers configuration, secrets, and credential handling in detail
- `packages/apra-fleet-bridge/src/cli/args.mjs` - Full argument reference for
  each fleet-bridge verb
- `packages/apra-fleet-bridge/src/verbs/preflight.mjs` - Details of what each
  preflight check validates
