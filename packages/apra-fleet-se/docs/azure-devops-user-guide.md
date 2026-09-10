# Using fleet-sprint with Azure DevOps

A short, practical guide for running fleet-sprint against your own Azure
DevOps repository -- register a member, give it access, launch a sprint,
get a pull request back. This assumes you already have the supervisor
running; see `supervisor-setup-guide.md` for that one-time setup if you
don't.

## What you need first

- A git repository on Azure DevOps (`https://dev.azure.com/<org>/<project>/_git/<repo>`)
  that already has a [beads](https://github.com/gastownhall/beads) (`bd`)
  issue tracker set up -- fleet-sprint reads and writes real beads issues,
  it does not create a tracking system of its own. If your repo has no
  beads DB yet, run `bd init` in it and push once so `sync.remote` is real.
- A Personal Access Token (PAT) for that Azure DevOps organization, scoped
  at minimum to **Code: Read & Write** and **Pull Request Threads: Read &
  Write** -- see `skills/fleet/auth-azdevops.md` for exactly how to create
  one and the full scopes table for other roles (review-only, CI, etc).
- A machine (local or SSH-reachable) with a real git checkout of your repo,
  and Node.js installed.

## Step 1 -- Register a member pointing at your repo

```
register_member(
  friendly_name: "my-dev",
  member_type: "local",          // or "remote" for SSH
  work_folder: "/path/to/your/repo-checkout",
  llm_provider: "claude"
)
```

This is a normal fleet member -- nothing Azure-DevOps-specific here. One
member is enough to start.

## Step 2 -- Give it Azure DevOps access

```
provision_vcs_auth(
  member_name: "my-dev",
  provider: "azure-devops",
  org_url: "https://dev.azure.com/<your-org>",
  pat: "{{secure.azdevops_pat}}",
  git_access: "push+pr"
)
```

Store the PAT via `credential_store_set` first (name it `azdevops_pat`, or
anything -- see `auth-azdevops.md`'s "Secret-Name Convention" section) so
it's referenced as a `{{secure.NAME}}` placeholder here, never typed
directly into a tool call. The fleet resolves it server-side; the plaintext
never enters your conversation with the agent.

`git_access: "push+pr"` is the right level for a normal development
member -- it can push branches and open pull requests. See
`auth-azdevops.md`'s Scopes table if you're setting up a review-only or
CI-only member instead.

**PATs don't auto-renew.** Azure DevOps doesn't support app-based tokens
the way GitHub does, so when your PAT expires you'll need to re-run this
step with a fresh one. `auth-azdevops.md`'s "PAT Lifetime and Expiry"
section covers the optional expiry-tracking that warns you ahead of time.

## Step 3 -- Launch a sprint

Through the supervisor's HTTP API (never the CLI directly -- see
`overview.md`):

```bash
curl -X POST http://localhost:8787/api/sprints \
  -H "Content-Type: application/json" \
  -d '{
    "issue": "<a beads root id in your repo>",
    "branch": "<new-or-existing-branch>",
    "base": "<your default branch, e.g. main>",
    "members": ["my-dev"]
  }'
```

Watch it run at the supervisor's dashboard (`http://localhost:8787`) or
the per-sprint dashboard URL the launch response returns.

## What happens

Fleet-sprint runs its normal cycle -- Plan, Develop, Review, repeating
until the goal priority is satisfied or `maxCycles` is reached -- then
Harvest and **Publish PR**. For an Azure DevOps repo, Publish PR:

1. Pushes the sprint branch.
2. Calls Azure DevOps's REST API to open a real pull request from your
   branch to the base branch you specified.
3. Reports back the PR's URL and ID.

If a pull request from that branch to that base already exists, fleet-sprint
treats it as success rather than erroring (idempotent -- safe to re-run a
sprint that already opened a PR).

## Troubleshooting

If something fails, `auth-azdevops.md`'s own Troubleshooting table covers
the common causes (expired/insufficient-scope PAT, wrong org URL). Two
things specific to actually running a sprint, not just testing the
credential directly:

- **A stuck "active sprint" gate on relaunch**: if a prior run of the same
  issue root ended in a failure the supervisor considers deterministic, a
  relaunch is refused with a 409 until you pass `overrideRelaunchGate: true`
  once you've actually fixed the cause.
- **Multiple members must share the same git HEAD** before a multi-member
  sprint launch -- if you're only using one member (the common case), this
  doesn't apply.

## Keeping it simple

You don't need a separate "orchestrator" member, a beads-only companion
folder, or any of the multi-member topology machinery described elsewhere
in these docs to get started. That's for larger, ongoing setups running
many concurrent sprints. One member with `push+pr` access to your Azure
DevOps repo is a complete, working setup.
