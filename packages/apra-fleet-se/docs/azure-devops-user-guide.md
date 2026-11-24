# Using fleet-sprint with Azure DevOps

A short, practical guide for running fleet-sprint against your own Azure
DevOps repository -- register a member, give it access, launch a sprint,
get a pull request back. This assumes you already have the supervisor
running; see `supervisor-setup-guide.md` for that one-time setup if you
don't.

## What you need first

- A git repository on Azure DevOps (`https://dev.azure.com/<org>/<project>/_git/<repo>`,
  or the legacy `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`;
  an `ssh.dev.azure.com` / `vs-ssh.visualstudio.com` v3 remote also works, but
  then git push uses the member's own SSH key and the PAT serves only the
  pull-request REST calls) that already has a [beads](https://github.com/gastownhall/beads) (`bd`)
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
  pat: "{{secret.azdevops_pat}}",
  git_access: "push+pr"
)
```

Store the PAT via `credential_store_set` first (name it `azdevops_pat`, or
anything -- see `auth-azdevops.md`'s "Secret-Name Convention" section) so
it's referenced as a `{{secret.NAME}}` placeholder here, never typed
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
does not open a second one or fail: it updates the existing PR, and changes
only what fleet owns on it:

- **The description.** Fleet owns only its engine-marked block, between the
  hidden `<!-- fleet-sprint:pr-block v1 -->` and
  `<!-- /fleet-sprint:pr-block v1 -->` markers. Each run replaces that block
  in place; every character outside it -- text you or a reviewer wrote above
  or below it -- is kept exactly as it was. A description with no block (a PR
  a human opened) keeps all its text, and the block is appended below it.
- **The title.** A title fleet wrote (`fleet-sprint [<VERDICT>]: <branch>`)
  is updated to the new verdict; a human-written title is never changed.
- **An aborted run.** The `[ABORTED]` status, what the run closed, what is
  still open or deferred, and the last reviewer verdict go into the block --
  never into a human-written title or text.
- **Text that does not fit.** Azure DevOps descriptions are limited (fleet
  sends at most 3500 characters, minus your own text outside the block).
  Whatever fleet text does not fit -- reviewer notes past the limit, or a
  whole section -- is posted as engine-marked PR comments, and the block ends
  with a link to them. On a re-run those comments are updated in place, not
  duplicated. If the comments cannot be posted, the block says so and points
  at the sprint run log, which always has the full text.

Re-running a sprint on a branch that already has a PR is therefore safe.

Publish PR (and the `[ABORTED]` PR an aborted sprint raises) uses the PAT
already deployed on the member and never re-provisions it: a PAT cannot be
minted by the fleet, so there is nothing to widen. It writes no host-scope
credential and leaves every other credential on the member -- including your
own `dev.azure.com` credential on a local member -- untouched. If no PAT is
deployed, or Azure DevOps answers with a sign-in page instead of a pull
request, the PR is reported as skipped with the reason; deploy or refresh the
PAT with `provision_vcs_auth` and re-run.

## Troubleshooting

If something fails, `auth-azdevops.md`'s own Troubleshooting table covers
the common causes (expired/insufficient-scope PAT, wrong org URL). Two
things specific to actually running a sprint, not just testing the
credential directly:

- **A stuck "active sprint" gate on relaunch**: if a prior run of the same
  issue root ended in a failure the supervisor considers deterministic, a
  relaunch is refused with a 409 until you pass `overrideRelaunchGate: true`
  once you've actually fixed the cause.
- **Multi-member launches align members automatically** -- every member is
  fetched and checked out on the sprint branch at launch (uncommitted work is
  kept in a named stash). The launch refuses only if a member is unreachable,
  members use different origin URLs, the base branch is missing on origin, or
  a fetch fails authentication; the message names the member and the fix. If
  you're only using one member (the common case), none of this applies.

## Keeping it simple

You don't need a separate "backlog" member, a beads-only companion
folder, or any of the multi-member topology machinery described elsewhere
in these docs to get started. That's for larger, ongoing setups running
many concurrent sprints. One member with `push+pr` access to your Azure
DevOps repo is a complete, working setup.
