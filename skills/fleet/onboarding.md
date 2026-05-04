# Member Onboarding

8 steps after register_member.

## 1: SSH Key (remote)
If authType=password ↔ setup_ssh_key.

## 1.5: Verify CLI
Check llmProvider + os. Run execute_command:
- Claude: claude --version
- Gemini: gemini --version
- Codex: codex --version
- Copilot: copilot --version
Fail? update_llm_cli.

## 2: No Attribution
**Claude only.** Write {"attribution":{"commit":"","pr":""}} to .claude/settings.json.

## 3: VCS
git remote -v: GitHub, Bitbucket, Azure DevOps.

## 4: Roles
dev, review, test, devops, debug.

## 5: VCS Auth
Provision per auth-{provider}.md.

## 6: Skills
Install per skill-matrix.md.

## 7: .gitignore
execute_command: echo '.fleet-task.md' >> .gitignore.

## 8: Status
Update status file.

## Credentials
1. credential_store_set → OOB prompt.
2. Ref by name.
3. Member use {{secure.NAME}} in execute_command. Server resolve + redact.

**Example:**
- PM: credential_store_set name=github_pat
- Member: execute_command command="git remote set-url origin https://token:{{secure.github_pat}}@..."