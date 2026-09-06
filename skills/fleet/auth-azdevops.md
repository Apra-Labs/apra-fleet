# Azure DevOps Authentication

Personal Access Tokens (PATs) with configurable scopes and expiration. Auth: empty username, PAT as password.

## Setup

1. Go to `https://dev.azure.com/{org}/_settings/tokens`
2. Click "New Token"
3. Set descriptive name (e.g., "fleet-{name}")
4. Select required scopes (see below)
5. Set expiration (recommend: 90 days)
6. Copy token - shown only once
7. Provide token and org URL when prompted

### Expiry Capture (Optional)

When first registering a PAT, you can optionally capture its expiration date by responding to the out-of-band prompt with the expiry timestamp. The fleet stores this expiry date and checks it against two separate thresholds (see `src/utils/agent-helpers.ts`):

- **Minute-scale warning** (`EXPIRY_WARNING_MS`, 10 minutes): fires for any provider once the credential is within 10 minutes of expiry. This threshold was sized for GitHub App tokens (~1hr lifetime).
- **Day-scale warning** (`DAY_SCALE_WARNING_MS`, 7 days): fires only for providers listed in `DAY_SCALE_WARNING_PROVIDERS`, which currently includes `azure-devops`. Because Azure DevOps PATs run weeks to months (see "Set expiration" above), this gives a heads-up long before the minute-scale check would ever fire.

Either warning causes the fleet to request a fresh provisioning before the sprint dispatch rather than failing mid-sprint when the credential becomes invalid.

This step is optional; PATs function normally even without expiry tracking. However, recording expiry dates helps prevent surprise authentication failures and reduces retry cycles.

## Deploy

```
provision_vcs_auth(member_id, provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg', pat: '...')
```

## Secret-Name Convention

The Azure DevOps PAT is stored in the fleet's credential store under a configurable name. **Default:** `azdevops_pat`

The credential is entered via the out-of-band prompt during `provision_vcs_auth` and is stored as a secure placeholder. When used in `execute_command` calls, the fleet resolves the placeholder on the server side - the plaintext token never appears in logs, prompts, or LLM transcripts.

**Store or reference the default credential:**

```
credential_store_set  name=azdevops_pat
execute_command  command="curl -sf -u :{{secure.azdevops_pat}} 'https://dev.azure.com/{org}/_apis/projects?api-version=7.1'"
```

**Per-sprint override:** To use a different credential name for a specific sprint (for example, when working with a different Azure DevOps organization or test repo), pass the `azdevops_pat_secret_name` argument to the sprint invocation (threaded through `packages/apra-fleet-se/fleet-sprint/runner.js`). It must name a credential already stored via `credential_store_set`; the runner validates it as a credential-store name at contract-validation time and uses it instead of the default `azdevops_pat` entry for provisioning, self-heal, and preflight checks on that sprint.

## Scopes

| Role | PAT Scopes |
|------|-----------|
| development | Code: R&W, Pull Request Threads: R&W |
| code-review | Code: Read, Pull Request Threads: R&W |
| testing | Code: Read, Build: Read |
| devops | Full access, or Code + Build + Release: R&W |
| debugging | Code: Read |

Union of all roles assigned to the member.

## Test

```bash
curl -sf -u :pat "https://dev.azure.com/{org}/_apis/projects?api-version=7.1&\$top=1"
git ls-remote https://dev.azure.com/{org}/{project}/_git/{repo} HEAD
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Create new PAT and re-deploy |
| 403 Forbidden | Create PAT with broader scopes |
| TF400813: Resource not available | Verify org URL matches `https://dev.azure.com/{org}` |
| Clone prompts for password | Re-run `provision_vcs_auth` |

## PAT Lifetime and Expiry

A fleet provisioning Azure DevOps credentials **cannot self-extend or auto-renew a PAT**. The Azure DevOps PAT lifecycle management API requires an Entra (Azure AD) OAuth token with admin consent, which the fleet does not hold. This is a fundamental design constraint: the fleet stores only the PAT itself, never the credentials needed to mint a fresh PAT or extend an existing one.

**Implications:**

- PATs must be renewed manually before expiry by re-running `provision_vcs_auth` and providing a fresh token.
- The optional expiry capture (see Setup section above) enables day-scale preflight warnings so the sprint can request a fresh provisioning before the credential becomes invalid.
- If a PAT expires mid-sprint, the sprint will fail with auth errors until `provision_vcs_auth` is re-run with a valid token.

To avoid disruption, set a calendar reminder to renew PATs well before their expiry date, or use the optional expiry-capture feature to let the fleet warn you in advance.

## Storing tokens for reuse

After provisioning VCS auth, you can store the Azure DevOps PAT in the credential store (see Secret-Name Convention section above) for direct use in `execute_command` - for example, calling the Azure DevOps REST API or authenticating git operations manually.

**Store an Azure DevOps PAT for reuse:**

```
credential_store_set  name=azdevops_pat
```

**Use it in a command on a member:**

```
execute_command  command="curl -sf -u :{{secure.azdevops_pat}} 'https://dev.azure.com/{org}/_apis/projects?api-version=7.1'"
execute_command  command="git remote set-url origin https://token:{{secure.azdevops_pat}}@dev.azure.com/{org}/{project}/_git/{repo}"
```

The token is resolved server-side and redacted in output (`[REDACTED:azdevops_pat]`) - it never appears in the LLM conversation or command logs.

## Notes

- PAT expiration: default 30 days, max 1 year
- Azure DevOps does not support app-based tokens - PATs are the standard
- Org URL must be base URL without trailing path
- To learn what scopes are required for your role, see the Scopes table above
