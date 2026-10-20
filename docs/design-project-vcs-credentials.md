# Design: per-project VCS credentials (v0.5)

Status: DRAFT for owner approval -- no code until approved.
Covers: the per-project credential binding, and the dashboard pick-a-secret
flow that fills it. Supersedes the per-sprint shape of #758 (reverted by #762).

## Goal

A project decides which VCS account its sprints use -- a second GitHub
account, a Bitbucket workspace, an Azure DevOps org -- once, when the project
is set up. Sprints just use it. Nobody types an email or a secret name per
launch, the engine stays provider-neutral, and no secret's policy is
loosened to make it work.

## What is wrong today (facts)

- Bitbucket (#755) reads one fixed credential-store name,
  `bitbucket_api_token`, and has no place for the account email Bitbucket's
  Basic auth needs. Azure DevOps has its own fixed name (`azdevops_pat`) with
  a per-sprint override. Two providers, two ad-hoc mechanisms.
- #758 moved the choice to launch time (`--bitbucket-secret-name`,
  `--bitbucket-email`) and required `network_policy=allow` on the secret,
  which also lets any `execute_command` send it to network tools unprompted.
  Rejected: per-sprint, provider-specific flags in a generic engine, identity
  per launch, weaker secret policy.
- A project has no repo, host or credential field. v0.5 has two project
  notions: the live single project folder (`supervisor.config.json`,
  `/api/project`, `/ui/projects`) and the mounted-but-UI-less sqlite store
  (`supervisor.sqlite`, `/api/projects*`). Launches carry no project id; they
  are bound to the single folder and its pinned local backlog member.
- `provision_vcs_auth` deploys a git credential helper into the member's
  GLOBAL git config, keyed by host. One member therefore holds one live
  credential per host, and provisioning the (local) backlog member rewrites
  the operator's own global git config.
- The credential store scopes secrets by member name only. It has no notion
  of "this secret is a VCS token" or of the identity (email/username) that
  goes with it.

## Design in one paragraph

A VCS credential is a credential-store secret that also records, as plain
metadata, what it is for: `kind=vcs`, `provider`, `host` and the account
`username` (Bitbucket: the Atlassian email). A project binds ONE such secret
by NAME (per remote host, normally one). The binding is stored on the
project. At sprint start the supervisor resolves the binding and the engine
provisions each sprint member with it through the existing
`provision_vcs_auth` path -- written into that member's checkout (repo-local
git config), not its global one. Everything downstream (push, PR REST calls
through `vcs_credential_exec`'s label path) is unchanged and provider-neutral.
A VCS secret stays an ordinary secret (usable in `execute_command` under its
own `network_policy`); the VCS paths need no `network_policy=allow`.

## 1. The credential: identity lives with the secret

Extend the credential-store record with optional, non-secret metadata:

```
vcs: { provider: 'github' | 'bitbucket' | 'azure-devops',
       host: 'github.com' | 'bitbucket.org' | 'dev.azure.com' | <ghe host>,
       username?: string,        // Bitbucket email; GitHub login for a PAT; omitted for Azure PAT
       scope?: string }          // optional workspace / org / owner the token is for
```

- Set by `credential_store_set` / `credential_store_update` (new optional
  `vcs` input; names and metadata only, never the value) and by the secure
  entry flow, which pre-fills it.
- Listed by `credential_store_list` (metadata only, as today), so a UI can
  filter secrets by host.
- `username` is metadata, not a secret: it is shown in lists and logs.

Why on the secret and not on the project: the identity belongs to the token
(an email is meaningless with a different token), two projects that share an
account share one secret, and rotating the token never touches projects.

## 2. Secret handling without loosening network_policy

A VCS secret is still an ordinary secret (owner decision): `{{secret.NAME}}`
works in `execute_command` like any other secret, under that secret's own
`network_policy` (default `confirm`), so an operator can still use it in
their own `curl` to the provider's API.

The VCS paths do not need `network_policy=allow` (the #758 requirement):
`provision_vcs_auth` resolves the secret server-side and writes the
member's git credential helper, and `vcs_credential_exec` reads only that
helper. Neither is `execute_command` network egress, so the secret's policy
is never loosened to make sprints work.

Host check: `provision_vcs_auth` refuses a secret whose `vcs.host` differs
from the target host.

## 3. The binding: on the project

```
project.vcs = { bindings: [ { host: 'bitbucket.org', secret: 'acme_bitbucket' } ] }
```

- One entry per remote host the project pushes to (normally exactly one,
  derived from the project's origin). Names only.
- Single project folder (live today): stored in `supervisor.config.json`
  under `vcs` (project-config already keeps unknown keys); read/written via
  `GET/PUT /api/project/vcs`.
- sqlite projects (M2): a `vcs_json` column on `projects`, via
  `GET/PUT /api/projects/:id/vcs`, same shape. One accessor serves both so the
  engine-facing contract does not care which project model is live.
- PUT validates: the name exists in the credential store, has `vcs` metadata,
  and its `host` matches the binding's host (supervisor asks the fleet server
  via `credential_store_list`).

Why the project and not the backlog member: the member is a runtime detail
(it is re-registered, adopted, may serve another project later). The project
is what the operator configures and what outlives members. The member's
provisioned helper is the *effect* of the binding, recomputed every sprint.

## 4. How a sprint uses it

1. Launch (dashboard or `POST /api/sprints`) carries no credential fields.
   The supervisor reads the project's binding and passes it to the engine as
   resolved launch context (`vcsBindings: [{host, secret}]`, names only) --
   the same way it already passes the pinned backlog member. It is not a
   user-facing per-sprint option. The standalone engine CLI reads the same
   binding from the project folder's config.
2. Before reserving members the supervisor validates the binding (exists,
   `kind=vcs`, host matches the origin, not expired). Failure is a 400 with a
   fix line (pick a credential on the project page); members stay free.
3. VCS preflight (existing `createVcsAuthPreflightCallback`) provisions every
   member that pushes or raises PRs (harvester, backlog) with
   `provision_vcs_auth({ member, provider, secret: NAME, scope: 'repo' })`.
   Provider, host and username come from the secret's metadata; the server
   resolves the token. The fixed `bitbucket_api_token` / `azdevops_pat`
   reads go away, and so does the per-sprint `azdevops_pat_secret_name`
   override (owner decision: retired as part of this design).
4. `scope: 'repo'` (new): the helper is written into the member's checkout
   (`git config --local` in its work folder) instead of `--global`. Two
   projects on one member with different accounts on the same host no longer
   collide, and the operator's own global git config is never touched.
5. PR creation is unchanged: `vcs_credential_exec` reads the provisioned
   helper by label (`{{vcs_token}}`, `{{vcs_username}}`), redacts output, and
   never sees a secret name.

GitHub App credentials (app id + key + installation) keep today's path;
`kind=vcs` covers token-style credentials: GitHub PAT (any account),
Bitbucket API token, Azure DevOps PAT. No binding = today's behaviour
(the member's existing provisioned credential).

## 5. Dashboard (pick a secret)

On the project page (not the launch form -- the choice is per project):

- "VCS credential for <host>": a select of credential NAMES with `vcs.host`
  equal to the project's origin host (names, provider, username, expiry;
  never values).
- "Add new": opens the existing secure entry flow (masked field, one-time
  URL) with name, provider, host and username pre-filled; persists by
  default (the current console add form never sends `persist`, so console
  secrets are session-only today -- fixed for this flow).
- Saving writes the binding (section 3). The launch form shows the bound
  credential read-only, with a link to change it on the project page. "Last
  choice remembered per project" is the binding itself.

## 6. Migration from `bitbucket_api_token`

- On first read of a project with no binding whose origin is bitbucket.org:
  if a secret named `bitbucket_api_token` exists, the engine uses it once with
  a warning naming the project page, exactly as today.
- The project page offers "Use bitbucket_api_token": it asks for the account
  email (one-time), adds `vcs` metadata to the existing secret via
  `credential_store_update`, and saves the binding. The value is never
  re-entered.
- Same for `azdevops_pat`. The fallback is removed one release later.
- The per-sprint `azdevops_pat_secret_name` launch argument is removed in
  this change (no deprecation period); a project binding replaces it.

## 7. Changes by component (for the plan, after approval)

- Credential store: `vcs` metadata; list/update fields.
- Tools: `credential_store_set`/`update` gain `vcs`; `provision_vcs_auth`
  gains `secret` (store NAME, identity from metadata) and `scope: 'repo'`.
  Client wrapper, api-reference and the tool docs in the same
  change (CLAUDE.md client-parity rule).
- Supervisor: binding in project config and sqlite; `/api/project/vcs` and
  `/api/projects/:id/vcs`; launch-time validation; pass `vcsBindings`.
- Engine: preflight provisions from the binding; drop the fixed-name reads
  and the `azdevops_pat_secret_name` launch argument; no provider-specific
  launch options.
- Console/dashboard: project page credential select + add-new; launch form
  shows the bound credential.
- Docs: auth-bitbucket/auth-github/auth-azdevops skills, getting-started,
  supervisor API/OpenAPI.

## Owner decisions

- One binding per host is enough for v0.5 (a project pushing to two hosts,
  e.g. a mirror, has two entries; nothing more).
- `azdevops_pat_secret_name` (per-sprint override) is retired as part of
  this design.
- A VCS secret is an ordinary secret: usable in any `execute_command` under
  its own `network_policy`. No VCS-only restriction.

## Open question for the owner

1. Where should a sprint-provisioned member's git credential live?

   Today `provision_vcs_auth` registers a "git credential helper" in the
   member's GLOBAL git config (`~/.gitconfig` of the OS user the member runs
   as), keyed by host. Two side effects:
   - The backlog member is a local member running as the operator, so
     provisioning it for a project's account replaces the operator's own
     login for that host (e.g. their personal bitbucket.org login for every
     repo on that machine).
   - One member can hold only one account per host, so two projects with
     different accounts on the same host overwrite each other on a shared
     member.

   Proposal: register the helper in the project checkout's own
   `.git/config` (`git config --local`) instead. Only that repository uses
   the project's account; the operator's global config and other repos are
   untouched. Git authenticates the same way either way. OK to make this
   the default for members that sprints provision?
