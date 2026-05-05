# Member Onboarding

After `register_member`, run these 8 steps before dispatching work.

## Step 1: Setup SSH Key Auth (remote members only)

Check `member_detail`—if member type is `remote` and `authType` is `password`, run `setup_ssh_key` to migrate to key-based authentication. Skip for local members or members already on key auth.

## Step 1.5: Verify CLI Installation

Use `member_detail` to determine `llmProvider` and `os`. Run `execute_command` with the provider's version command to confirm the agent CLI is installed:

- **Claude:** `claude --version`
- **Gemini:** `gemini --version`
- **Codex:** `codex --version`
- **Copilot:** `copilot --version`

If the LLM CLI is not installed or the command fails, use `update_llm_cli` to install it. Do not attempt prompt dispatch until the CLI is confirmed.

## Step 2: Disable AI Attribution

**Claude only.** Write `{"attribution":{"commit":"","pr":""}}` to `.claude/settings.json` in the member's work folder via `execute_command`. Merge if the file already exists.

Gemini, Codex, and Copilot do not support attribution config—skip this step for those providers.

## Step 3: Detect VCS Provider

Run on the member: `git remote -v`

- `github.com` → GitHub
- `bitbucket.org` → Bitbucket
- `dev.azure.com` → Azure DevOps

If no remotes are found, ask the user for the VCS provider and repo URL.

## Step 4: Determine Roles

Ask the user. Roles: development, code-review, testing, devops, debugging. A member can have multiple.

## Step 5: Setup VCS Auth

Verify auth and provision if needed. See auth-{provider}.md for provider-specific steps and scopes per role. Skip for local members as they inherit the user's git credentials.

## Step 6: Check/Install Required Skills

Look up the member's project + VCS + roles in skill-matrix.md. Install missing skills.

## Step 7: Add Fleet Ephemeral Files to .gitignore

Run `execute_command → echo '.fleet-task.md' >> .gitignore` on the member's work folder. These ephemeral prompt delivery files are managed by the fleet server and must never be committed to the repo.

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

## Pre-loading credentials before dispatch

If the task requires an API key, token, or password (e.g., calling an external API, pushing to a private registry, or authenticating to a third-party service), store it in the credential store **before** dispatching the member.

**Why:** `execute_prompt` prompts are visible in the LLM conversation. Passing raw secrets exposes them in logs and chat history. The credential store keeps the plaintext out of the LLM.

**Steps:**
1. Call `credential_store_set` with a descriptive name (e.g., `github_pat`, `npm_token`, `openai_key`)—Fleet opens an OOB terminal prompt for the value.
2. Pass the `sec://NAME` handle in the task prompt—reference by name only (e.g. `"authenticate using credential github_pat"`). The secret value is injected server-side when `{{secure.NAME}}` appears in an `execute_command` call—never in AI prompt text.
3. The member uses `{{secure.NAME}}` in `execute_command`—Fleet resolves the value server-side and redacts it from output before the LLM sees it.

**Example — dispatching a member that needs to push code to GitHub:**

```
# PM stores the token before dispatch
credential_store_set  name=github_pat

# PM includes in the task prompt — reference by name only:
"When pushing code to GitHub, authenticate using credential github_pat."

# Member uses it in a command transparently
execute_command  command="git remote set-url origin https://token:{{secure.github_pat}}@github.com/Org/Repo.git"
```
