# Member Onboarding

8 steps after `register_member`.

## 1: SSH Key (remote only)

Check `member_detail`. If `remote` + `password`, run `setup_ssh_key`. Skip if local or key-based.

## 1.5: Verify CLI

Check `llmProvider` + `os` via `member_detail`. Run `execute_command` with version flag:

- Claude: `claude --version`
- Gemini: `gemini --version`
- Codex: `codex --version`
- Copilot: `copilot --version`

If fails, run `update_llm_cli`. confirm CLI before prompt dispatch.

## 2: Disable Attribution (Claude only)

Write `{"attribution":{"commit":"","pr":""}}` to `.claude/settings.json` in work folder via `execute_command`. Merge if exists. Skip for others.

## 3: Detect VCS

Run `git remote -v`.
- `github.com` → GitHub
- `bitbucket.org` → Bitbucket
- `dev.azure.com` → Azure DevOps
No remotes? Ask user for provider + repo URL.

## 4: Roles

Ask user. Roles: development, code-review, testing, devops, debugging. Can have multiple.

## 5: VCS Auth

Verify/provision auth. See `auth-{provider}.md` for scopes. Skip for local members.

## 6: Skills

Check `skill-matrix.md` (project + VCS + roles). Install missing skills.

## 7: .gitignore

Run `execute_command → echo '.fleet-task.md' >> .gitignore`. Ephemeral files must not be committed.

## 8: Status File

Add to member's status file:
```
## Member Profile
- Provider: Gemini
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket token (verified)
- Skills: bitbucket-devops (installed)
```

## Pre-load Credentials

If task needs secrets (API keys, tokens), store in credential store **before** dispatch.

**Why**: `execute_prompt` text is visible. Passing raw secrets exposes them. Credential store keeps plaintext out of LLM.

**Steps**:
1. `credential_store_set` with name (e.g., `github_pat`). Fleet opens OOB terminal for value.
2. Reference by name in prompt (e.g. "use credential github_pat"). Value injected server-side when `{{secure.NAME}}` in `execute_command`.
3. Member uses `{{secure.NAME}}` in `execute_command`. Fleet resolves server-side, redacts output.

**Example**:
```
# PM stores token
credential_store_set name=github_pat

# PM includes in task prompt:
"Pushing to GitHub? use credential github_pat."

# Member uses in command
execute_command command="git remote set-url origin https://token:{{secure.github_pat}}@github.com/Org/Repo.git"
```
