<!-- llm-context: Step-by-step setup of the GitHub App that apra-fleet mints short-lived git tokens from, with the exact App permissions each git_access level requests. Read before running setup_git_app, when provision_vcs_auth fails with "is not granted one or more of the requested permissions", or when upgrading an existing App to a new release. -->
<!-- keywords: GitHub App, setup_git_app, provision_vcs_auth, git_access, push+pr, permissions, Actions, Workflows, installation, private key, 422, not granted -->
<!-- see-also: design-git-auth.md (why tokens are scoped this way), secret-variables.md ({{secret.NAME}}), ../skills/fleet/auth-github.md (fleet skill summary) -->
# Before you run setup_git_app

apra-fleet can give members GitHub access in two ways (`provision_vcs_auth`
with `provider: 'github'`):

| Mode | `github_mode` | What you set up | Token lifetime |
|---|---|---|---|
| GitHub App (recommended for orgs) | `github-app` (default) | One App, once, via this guide + `setup_git_app` | ~1 hour, re-minted by fleet |
| Personal access token | `pat` | Nothing here -- pass `token` | Whatever you chose |

This guide is only for GitHub App mode. PAT mode ignores `git_access`
entirely; its reach is whatever scopes you gave the PAT.

## How permissions work (read this first)

Every time fleet mints a token it asks GitHub for EXACTLY the permission set
of the requested `git_access` level (table below) -- no more, no less. If the
App has not been granted every permission in that set, GitHub refuses the
mint (HTTP 422) and `provision_vcs_auth` fails with an error naming the
requested permissions. Fleet never retries with fewer permissions: a silent
downgrade would hide the misconfiguration and fail later, somewhere less
obvious.

The App's permissions are a ceiling, not a grant to every token. Giving the
App the union of what your levels need does not widen any single token --
a `read` mint still gets only `contents: read` + `metadata: read`.

## Permissions per git_access level

Set these under the App's **Repository permissions**. In the GitHub UI,
"read" is **Read-only** and "write" is **Read and write**. **Metadata:
Read-only** is mandatory on every App and is requested by every level.

| App permission (UI name) | `read` | `push` | `push+pr` | `admin` | `issues` | `full` |
|---|---|---|---|---|---|---|
| Metadata | Read-only | Read-only | Read-only | Read-only | Read-only | Read-only |
| Contents | Read-only | Read and write | Read and write | Read and write | - | Read and write |
| Workflows | - | Read and write | Read and write | Read and write | - | Read and write |
| Pull requests | - | - | Read and write | - | Read and write | Read and write |
| Actions | - | - | Read and write | Read and write | - | Read and write |
| Administration | - | - | - | Read and write | - | Read and write |
| Issues | - | - | - | - | Read and write | Read and write |
| Discussions | - | - | - | - | Read and write | Read and write |

Source of truth: `mapAccessLevel()` in `src/services/github-app.ts`. If this
table and that function ever disagree, the function wins -- please file an
issue.

Why some of these are there:
- **Workflows** (push levels): GitHub rejects any push touching
  `.github/workflows/**` from an App token without it.
- **Actions** (`push+pr`, `admin`, `full`): lets an agent re-run failed CI jobs
  (`gh run rerun --failed`) on its own PR. Added to `push+pr` in 0.4.3.
- **Discussions** (`issues`, `full`): the Discussions GraphQL API.

### Which to pick

Grant the union of every level you will actually use. Common cases:

- **fleet-sprint / PM workflows (minimum):** the `push+pr` column --
  Metadata, Contents, Workflows, Pull requests, Actions. Sprints mint `push`
  for sync and `push+pr` just before raising the PR, so both must succeed.
- **Plus issue/Discussions triage:** add Issues and Discussions.
- **Everything fleet can request:** the `full` column.

Note: `register_member` / `update_member` accept `git_access` values
`read | push | admin | issues | full` only. `push+pr` is passed per call to
`provision_vcs_auth` (fleet-sprint does this itself).

## Step 1 -- Create the App

1. Go to your org: **Settings -> Developer settings -> GitHub Apps -> New
   GitHub App** (direct URL:
   `https://github.com/organizations/<org>/settings/apps/new`).
2. **GitHub App name**: anything unique (e.g. `<org>-apra-fleet`).
3. **Homepage URL**: any URL (your org or repo page is fine).
4. **Webhook**: uncheck **Active**. Fleet never receives webhooks; it only
   calls the GitHub API.
5. **Repository permissions**: set the columns you chose above. Leave
   Organization and Account permissions at "No access".
6. **Where can this GitHub App be installed?**: **Only on this account**.
7. Click **Create GitHub App**.

## Step 2 -- Note the App ID and generate a private key

1. On the App's **General** page, copy the **App ID** (a number).
2. Scroll to **Private keys -> Generate a private key**. GitHub downloads a
   `.pem` file. This is the only copy GitHub gives you.

Treat the `.pem` as a secret: whoever holds it can mint tokens for every repo
the App is installed on.

## Step 3 -- Install the App and get the installation ID

1. On the App page, choose **Install App -> Install** next to your org.
2. **Repository access**: pick **Only select repositories** and choose the
   repos fleet members will work on (or **All repositories**). A mint for a
   repo outside this selection fails.
3. After installing you land on
   `https://github.com/organizations/<org>/settings/installations/<number>`.
   That trailing `<number>` is the **installation ID**. (Later: org
   **Settings -> GitHub Apps -> Configure** next to the App shows the same URL.)

## Step 4 -- Run setup_git_app

Pass a plain path to the downloaded key:

    setup_git_app(app_id: "123456",
                  private_key_path: "/home/me/Downloads/<app>.<date>.private-key.pem",
                  installation_id: 78901234)

Or keep the path (or the PEM content itself) in the credential store and
reference it as `{{secret.NAME}}`: if the resolved value starts with
`-----BEGIN` it is used as the key content, otherwise as a file path. See
`secret-variables.md`. The credential must be usable by all members (it is
resolved for member `*`).

`setup_git_app` checks that the key authenticates as the App and that the
installation exists, then copies the key to `<data dir>/github-app.pem`
(owner-only permissions; data dir is `~/.apra-fleet/data` unless
`APRA_FLEET_DATA_DIR` is set). On success it prints the App name, org,
installation ID and the stored key path. You may delete the downloaded
`.pem` afterwards.

`setup_git_app` does NOT check the App's permission set. That is verified at
the first mint (Step 5).

## Step 5 -- Verify with one mint

Mint the highest level you plan to use on one member, e.g.:

    provision_vcs_auth(member_name: "<member>", provider: "github",
                       github_mode: "github-app", git_access: "push+pr",
                       repos: ["<org>/<repo>"])

Expected:
- `structuredContent.ok: true`.
- `metadata.permissions` lists every permission of that level -- for
  `push+pr`: `contents`, `pull_requests`, `metadata`, `workflows`, `actions`.
  A successful mint IS the proof the App has them all.
- `reason: "ok"` and `verified: true` when the member has `git_repos`
  registered (fleet runs `git ls-remote` on the first one).
  `reason: "deployed_verification_skipped"` just means the member has no
  registered `git_repos` -- the credential is still deployed.
- `metadata.ghCliAuth: ok` if the `gh` CLI on the member accepted the token.

## Troubleshooting

**`Token mint failed: GitHub App <id> (installation <id>) is not granted one or more of the requested permissions [contents, pull_requests, metadata, workflows, actions]: ...`**

(`reason: deploy_failed`, full text in `structuredContent.message`.) The App
lacks at least one permission of the requested level. Re-minting will not
help. Fix:
1. App settings -> **Permissions & events** -> add the missing permission(s)
   from the table above -> **Save changes**.
2. Changing an App's permissions does NOT update existing installations.
   An org owner must accept it: org **Settings -> GitHub Apps -> Configure**
   next to the App -> **Review request** -> **Accept new permissions**
   (GitHub also emails the org owners).
3. Re-run `provision_vcs_auth`.

**`Token mint failed: Token mint failed (422): ... not accessible to the parent installation`** (or similar repo wording)

A repo in `repos` is not in the installation's repository selection. Add it
under the installation's **Repository access** (Step 3).

**`GitHub App not configured. Run setup_git_app first.`** -- Step 4 not done
on this fleet server (or a different data dir).

**`No git_access level specified and none on agent config.`** -- pass
`git_access`, or set it with `update_member`.

**`No repos specified and none on agent config.`** -- pass `repos`, or set
`git_repos` with `update_member`.

**fleet-sprint finishes but no PR is raised; the log shows
`[Publish PR Skipped] ... due to an unrecoverable VCS auth failure: Could not provision a push+pr credential ...`**

The branch was pushed, but the `push+pr` mint failed -- almost always the
permission error above (typically Actions after upgrading to 0.4.3). Fix the
App, then raise the PR by hand or re-run publish.

## Upgrading to 0.4.3

0.4.3 requests two App permissions that earlier releases did not:

- **Workflows: Read and write** on `push`, `push+pr`, `admin`, `full`.
- **Actions: Read and write** on `push+pr` (it was already on `admin`/`full`).

An App set up for 0.4.2 or earlier fails these mints with the
"is not granted" error above until you add the permissions AND an org owner
accepts them on the installation. For fleet-sprint the visible symptom is a
sprint that pushes its branch but skips raising the PR. Do this before
upgrading the fleet server.
