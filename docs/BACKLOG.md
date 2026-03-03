# Backlog

## PMO Skill (In Progress — Brainstorming)
A Claude Code skill that automates the Project Management Office workflow. Currently the PMO pattern (CLAUDE.md + PLAN.md + progress.json pushed to agents, monitor/resume cycle) is executed manually by the operator. The skill should automate: plan generation from requirements, progress.json scaffolding with tasks/verify checkpoints, pushing control files to agents, kicking off execution, monitoring progress, and auto-resuming after verify checkpoints. Being brainstormed in the PMO workspace (`C:\akhil\claude-fleet-projects`).

## ProjMgr Skill (In Progress — Brainstorming)
A Claude Code skill for project management workflows on fleet agents. See **[ProjMgr-requirements.md](ProjMgr-requirements.md)** for requirements and design discussions. Being brainstormed in `docs/`.

## Git Authentication & Scoped Access (In Progress)
New MCP tools: `setup_git_app` + `provision_git_auth` — mints short-lived, scoped git tokens per agent using GitHub App / Azure AD Service Principal / Bitbucket OAuth. Replaces the current manual SSH key / PAT approach. Users declare `git_access: read | push | admin | issues` per agent; the fleet handles token minting, credential deployment, and auto-refresh. See **[design-git-auth.md](design-git-auth.md)** for the full design proposal and **[tasks-git-auth.md](tasks-git-auth.md)** for implementation tasks. GitHub App `claude-fleet-git` (App ID: 3001109) already created and verified working.

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.

## Read Remote File Tool (Low Priority)
New MCP tool: `read_remote_file` — fetches a file from an agent's work folder and returns its contents. Primarily needed for binary files (tar.gz, screenshots, etc.) that can't be read via `execute_command` + `cat`. For text files, `cat` suffices. Not a blocker for PM skill.

## Git Authentication & Scoped Access (High Priority)
New MCP tool: `provision_git_auth` — mints short-lived, scoped git tokens per agent using GitHub App / Azure AD Service Principal / Bitbucket OAuth. Replaces the current manual SSH key / PAT approach. Users declare `git_access: read | push | admin | issues` per agent; the fleet handles token minting, credential deployment, and auto-refresh. See **[design-git-auth.md](design-git-auth.md)** for the full design proposal. Key deps: `@octokit/app` for GitHub, `@azure/identity` for Azure DevOps. Required for PM skill git workflows and secure multi-agent access control.
