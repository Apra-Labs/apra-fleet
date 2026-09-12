<!-- llm-context: Design doc for fleet's git authentication system -- scoped token provisioning via GitHub Apps, PATs, Bitbucket, and Azure DevOps. Read when a user asks how to give members git access, how tokens are scoped, or how credentials are managed. -->
<!-- keywords: git auth, GitHub App, PAT, Bitbucket, Azure DevOps, token, scope, provision, revoke, credential, push, pull, clone -->
<!-- see-also: ../README.md (step-by-step git auth setup), design-vcs-auth-onboarding.md (onboarding flow) -->

# Design: Git Authentication for Fleet Members

## Problem

Fleet members need git access (clone, push, force-push, issue management) across multiple git hosts (GitHub, Azure DevOps, Bitbucket, GitLab). Without a standardized provisioning path, git credentials land on members ad hoc and cannot be scoped per member role.

Key requirements:
- **Multi-host**: Same abstraction across GitHub, Azure DevOps, Bitbucket, GitLab, self-hosted
- **Scoped permissions**: Read-only members shouldn't be able to push; dev members shouldn't force-push to main
- **Short-lived tokens**: Compromised member = limited blast radius
- **Zero user plumbing**: Users declare intent ("this member needs read access"), fleet handles the rest
- **Audit trail**: Every token mint logged with member name, scope, timestamp

## Design

### User-Facing Config

Members declare git access in their registration or member config:

```yaml
members:
  code-analyst:
    host: 192.168.1.13
    work_folder: /Users/akhil/git/ApraPipes
    git_access: read
    git_repos: [Apra-Labs/ApraPipes]

  feature-dev:
    host: 192.168.1.13
    work_folder: /Users/akhil/git/ApraPipes
    git_access: push
    git_repos: [Apra-Labs/ApraPipes]

  release-bot:
    host: 192.168.1.14
    work_folder: /home/deploy/releases
    git_access: admin
    git_repos: ["*"]

  project-mgr:
    host: local
    work_folder: C:\akhil\project-tracking
    git_access: issues
    git_repos: [Apra-Labs/ApraPipes, Apra-Labs/apra-lic-mgr]
```

### Access Levels

| Level | Git operations | Non-git |
|---|---|---|
| `read` | clone, pull, fetch, blame, log | - |
| `push` | read + push to branches (branch protection blocks main/force-push) | - |
| `admin` | read + push + force-push + tags + releases | CI/CD triggers |
| `issues` | - (no code access) | issues, PRs, projects, comments |
| `full` | admin + issues | Everything |

### VCS provider resolution

A member's VCS provider (`github` | `bitbucket` | `azure-devops` | `none`)
determines which credential backend `provision_vcs_auth` targets and which
PR-shaped command `fleet-sprint` builds for it. `register_member` accepts an
explicit `vcs_provider`; when omitted, registration reads the member's git
`origin` remote (best effort) and maps its host to a provider
(`github.com` -> `github`, `bitbucket.org` -> `bitbucket`, `dev.azure.com` /
`*.visualstudio.com` -> `azure-devops`). A GitHub Enterprise host has no
fixed domain and is never auto-detected -- register those members with an
explicit `vcs_provider`.

Auto-detection commonly fails at registration time, because the ordinary
flow is register-then-clone: the member's work folder has no git repo yet,
so there is no `origin` to read. Registration still succeeds in that case
(a missing VCS provider does not block onboarding), but emits a loud warning
that the member cannot push or open a PR until one is set. There are three
ways to resolve it after the fact: call `provision_vcs_auth` with an explicit
`provider` (this also records `vcsProvider` as a side effect of provisioning
credentials); call `update_member` with `vcs_provider` set, to record the
provider directly without provisioning credentials; or rely on
`fleet-sprint`'s dispatch-time fallback, which re-attempts the same
remote-based detection once a git remote exists and self-heals the
registry entry automatically. Re-registering the same folder path is
rejected as a duplicate registration, so it is never the remedy for a wrong
or missing auto-detect.

### Backend: GitHub App Token Minting

For GitHub-hosted repos, use a **GitHub App** installed on the org.

```
+---------------------------------------------+
|  apra-fleet-app (GitHub App)                |
|  Installed on: the org                      |
|  App private key stored on PM/master        |
|                                             |
|  Max permissions (app-level):               |
|  - contents: write                          |
|  - issues: write                            |
|  - pull_requests: write                     |
|  - actions: write                           |
|  - administration: write                    |
+--------------+------------------------------+
               |
  PM mints scoped tokens per member at runtime:
               |
               +--> code-analyst:  { contents: read,  repos: [ApraPipes] }
               +--> feature-dev:   { contents: write, repos: [ApraPipes] }
               +--> release-bot:   { contents: write, admin: write, repos: [*] }
               +--> project-mgr:   { issues: write, pull_requests: write }
```

**Token minting flow:**

```typescript
// Using @octokit/app
import { App } from "@octokit/app";

const app = new App({
  appId: FLEET_GITHUB_APP_ID,
  privateKey: FLEET_GITHUB_APP_KEY,
});

async function mintGitToken(agent: Agent): Promise<string> {
  const octokit = await app.getInstallationOctokit(installationId);

  const { token } = await octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      repositories: agent.git_repos,          // scoped to specific repos
      permissions: mapAccessLevel(agent.git_access),  // scoped permissions
    }
  );

  return token;  // valid for 1 hour
}

function mapAccessLevel(level: string): Record<string, string> {
  switch (level) {
    case "read":   return { contents: "read" };
    case "push":   return { contents: "write" };
    case "admin":  return { contents: "write", administration: "write", actions: "write" };
    case "issues": return { issues: "write", pull_requests: "write" };
    case "full":   return { contents: "write", administration: "write", issues: "write", pull_requests: "write", actions: "write" };
  }
}
```

**Credential deployment to member:**

```typescript
async function provisionGitAuth(agent: Agent): Promise<void> {
  const token = await mintGitToken(agent);

  // Configure git credential helper on the member
  await agent.executeCommand(
    `git config --global credential.helper '!f() { echo "password=${token}"; }; f'`
  );

  // Or more robustly, write a credential helper script
  await agent.executeCommand(`cat > ~/.fleet-git-credential << 'EOF'
#!/bin/sh
echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=${token}"
EOF
chmod +x ~/.fleet-git-credential
git config --global credential.helper ~/.fleet-git-credential`);
}
```

### Backend: Azure DevOps

Use an **Azure AD App Registration** (Service Principal):

```typescript
// Using @azure/identity + azure-devops-node-api
const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
const token = await credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default");

// Deploy to member as PAT-style credential
await agent.executeCommand(
  `git config --global credential.helper '!f() { echo "password=${token.token}"; }; f'`
);
```

### Backend: Bitbucket

Use a **Bitbucket OAuth Consumer** or **Repository Access Token**:
- OAuth Consumer: org-level, token minting via client_credentials grant
- Repository Access Token: per-repo, created via Bitbucket API, scoped permissions

### Backend: Self-hosted / GitLab

- GitLab: **Project Access Tokens** or **Group Access Tokens** via API
- Self-hosted: SSH keys (fallback -- no token API available)

### Token Lifecycle

```
Member startup / first git operation
        |
        v
  PM mints scoped token (1hr TTL)
        |
        v
  Deploy credential to member via execute_command
        |
        v
  Member uses git normally (clone/push/etc)
        |
        v
  Token nearing expiry? Auto-refresh before next git operation
        |
        v
  Member deregistered? Token expires naturally (1hr max)
```

### MCP Tool Interface

The tool is `provision_vcs_auth` (`src/tools/provision-vcs-auth.ts`), with
`revoke_vcs_auth` as its counterpart. Its input carries a member identifier
plus a `provider` (`github` | `bitbucket` | `azure-devops`), an optional
credential `label` and `scope_url`, and a per-provider credential group:

- **GitHub**: `github_mode` (`github-app` | `pat`), `token`, and the
  `git_access` / `repos` overrides for the GitHub App path.
- **Bitbucket**: `email`, `api_token`, `workspace`.
- **Azure DevOps**: `org_url`, `pat`, `pat_expires_at`.

Secret-bearing fields accept a `{{secure.NAME}}` token, resolved from the
credential store server-side so no secret passes through a model's context.

### Structured provisioning responses

`provision_vcs_auth`, `provision_auth` (the LLM-credential counterpart) and
`member_reservation` all return a structured MCP result (an `ok`/`failed`
discriminator, a machine-readable `reason` code, and tool-specific fields)
rather than emoji-prefixed prose. This matters for any orchestrator-side
consumer: `reason` values include benign-but-not-fully-successful outcomes
(for example `provision_auth`'s `skipped_local_member`) that still report
`ok: true`, so a consumer that only checks `ok` cannot distinguish "actually
provisioned" from "correctly skipped." Always branch on `reason` before
falling back to the generic `ok`/`failed` split. Any caller that stubs these
tools in a test must stub the structured shape (`{ text, structuredContent }`),
not the old string return -- a stub still shaped like the old prose return
passes type-checking (both are just objects) but throws at the first
`.structuredContent.ok` read, and if that call site is wrapped in a
best-effort `catch`, the throw is silently swallowed and the mismatch never
surfaces as a test failure.

### Server-side credential handoff (`vcs_credential_exec`)

Before this tool existed, the only way an orchestrator-side caller could run
a credential-requiring git/VCS command was to first learn the token itself:
dispatch the deployed git-credential-helper as a member command and parse
`password=<token>` out of the captured stdout. Even dispatched with a
silent flag, the plaintext token still round-trips through a command result
the orchestrator process reads.

`vcs_credential_exec` (`src/tools/vcs-credential-exec.ts`) removes that
round-trip. The caller sends a command containing the literal placeholder
`{{vcs_token}}` where the credential belongs (never inside the caller's own
quotes -- the substituted value arrives already shell-escaped for the
member's shell, the same convention `execute_command`'s `{{secure.NAME}}`
tokens use), and the server performs the whole handoff in one call:

1. Runs the member's deployed credential helper through `strategy.execCommand`
   -- that output is consumed in-process and is never part of this tool's
   result.
2. Substitutes `{{vcs_token}}` with the token, shell-escaped per
   `isPosixShell(agentOs, agentShell)` -- never assumed to be POSIX.
3. Dispatches the substituted command.
4. Redacts any occurrence of the token from stdout/stderr before returning,
   the same defense `execute-command.ts`'s output redaction applies.

The tool refuses any command lacking the `{{vcs_token}}` placeholder, so it
cannot degrade into a second, unguarded `execute_command`. The plaintext
token appears in no field of any result an orchestrator-side caller can
read; `readMemberVcsCredentialToken` (the old prose-scraping path) is left in
place for callers that have not migrated.

Redaction must cover every exit path the substituted command can take, not
just its successful stdout/stderr -- a dispatch failure that throws (the
`dispatch_failed` catch branch) can still carry the token verbatim inside
the thrown error's own message (many transport layers echo the failed
command back into the error text). A redaction pass applied only to the
success path leaves that throw path as an unguarded leak of exactly the
secret the tool exists to protect.

### Security Properties

| Property | How it's achieved |
|---|---|
| **Least privilege** | Token scoped to declared repos + access level |
| **Short-lived** | 1hr tokens, auto-refreshed |
| **Auditable** | Token minting logged with member, scope, timestamp |
| **Revocable** | Remove member = token expires naturally; revoke app installation for emergency |
| **No secrets on members** | Members never see the app private key, only short-lived tokens |
| **Compromised member** | Max 1hr window, scoped to declared repos only |

### Comparison with Alternatives

| | SSH Keys | PATs | GitHub App (this design) |
|---|---|---|---|
| Per-member scoping | No | Manual | Automatic |
| Token lifetime | Forever | Days-years | 1 hour |
| Multi-host | Same key everywhere | Different per host | Abstracted |
| User effort | Generate + register keys | Generate + distribute tokens | Declare `git_access: push` |
| Revocation | Manual key removal | Manual token revocation | Auto-expires |
| Audit | SSH logs | None built-in | Full mint log |

## Delivery pieces

1. **GitHub App setup** -- create app, install on org, store private key in fleet config (`setup_git_app`, `src/services/github-app.ts`)
2. **`provision_vcs_auth` tool** -- mints scoped token, deploys credential to member; `revoke_vcs_auth` tears it down
3. **Auto-provisioning** -- mint token on member startup or first git operation
4. **Auto-refresh** -- check token expiry before git operations, refresh if needed
5. **Multi-host backends** -- GitHub, Bitbucket, and Azure DevOps adapters behind the same `provision_vcs_auth` interface (`src/services/vcs/`); GitLab is not implemented
6. **Member config** -- `git_access` and `git_repos` fields on `register_member` / `update_member`
