# Member Onboarding

After `register_member`, run these 7 steps before dispatching any work.

## Step 1: Setup SSH Key Auth (remote members only)

Check `member_detail` — if `agentType` is `remote` and `authType` is `password`, run `setup_ssh_key` to migrate to key-based authentication. Skip entirely for local members or members already on key auth.

## Step 2: Disable AI Attribution

Write `{"attribution":{"commit":"","pr":""}}` to `.claude/settings.json` in the member's work folder via `execute_command`. Merge if file already exists.

## Step 3: Detect VCS Provider

Run on the member: `git remote -v`

- `github.com` → GitHub
- `bitbucket.org` → Bitbucket
- `dev.azure.com` → Azure DevOps

No remotes? Ask the user for VCS provider and repo URL.

## Step 4: Determine Roles

Ask the user. Roles: development, code-review, testing, devops, debugging. A member can have multiple.

## Step 5: Setup VCS Auth

Verify auth, provision if needed. See auth-{provider}.md for provider-specific steps and required scopes per role. Skip for local members — they inherit the user's native git credentials.

## Step 6: Check/Install Required Skills

Look up the member's project + VCS + roles in skill-matrix.md. Install any missing skills.

## Step 7: Update Member Status File

Add to the member's status file:

```
## Member Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```
