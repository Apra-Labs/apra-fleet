# Member Onboarding

After `register_agent`, run these 5 steps before dispatching any work.

## Step 1: Detect VCS Provider

Run on the member: `git remote -v`

- `github.com` → GitHub
- `bitbucket.org` → Bitbucket
- `dev.azure.com` → Azure DevOps

No remotes? Ask the user for VCS provider and repo URL.

## Step 2: Determine Roles

Ask the user. Roles: development, code-review, testing, devops, debugging. A member can have multiple.

## Step 3: Setup VCS Auth

Verify auth, provision if needed. See auth-{provider}.md for provider-specific steps and required scopes per role.

## Step 4: Check/Install Required Skills

Look up the member's project + VCS + roles in skill-matrix.md. Install any missing skills.

## Step 5: Update Member Status File

Add to the member's status file:

```
## Member Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```
