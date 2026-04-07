# Member Onboarding

After `register_member`, run these 7 steps before dispatching any work.

## Step 1: Setup SSH Key Auth (remote members only)

Check `member_detail` — if member type is `remote` and `authType` is `password`, run `setup_ssh_key` to migrate to key-based authentication. Skip entirely for local members or members already on key auth.

## Step 1.5: Verify CLI Installation

Use `member_detail` to determine `llmProvider` and `os`. Run `execute_command` with the provider's version command to confirm the agent CLI is installed:

- **Claude:** `claude --version`
- **Gemini:** `gemini --version`
- **Codex:** `codex --version`
- **Copilot:** `copilot --version`

If the CLI is not installed or the command fails, run the provider's install command (`installAgent` via `execute_command`) before proceeding. Do not attempt any prompt dispatch until the CLI is confirmed.

## Step 2: Disable AI Attribution

**Claude only.** Write `{"attribution":{"commit":"","pr":""}}` to `.claude/settings.json` in the member's work folder via `execute_command`. Merge if file already exists.

Gemini, Codex, and Copilot do not support attribution config — skip this step for those providers.

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

## Step 7: Add Fleet Ephemeral Files to .gitignore

Run `execute_command → echo '.fleet-task*' >> .gitignore` on the member's work folder. These are ephemeral prompt delivery files managed by the fleet server and must never be committed to the repo.

## Step 8: Update Member Status File

Add to the member's status file:

```
## Member Profile
- LLM Provider: Gemini
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```
