# Backlog

## Git Auth — Remaining (Low Priority)
- Auto-cleanup: TTL-based removal of credential helper file after token expiry (nice-to-have, tokens expire in 1hr anyway)

## PMO Skill (In Progress — Brainstorming)
A Claude Code skill that automates the Project Management Office workflow. Currently the PMO pattern (CLAUDE.md + PLAN.md + progress.json pushed to agents, monitor/resume cycle) is executed manually by the operator. The skill should automate: plan generation from requirements, progress.json scaffolding with tasks/verify checkpoints, pushing control files to agents, kicking off execution, monitoring progress, and auto-resuming after verify checkpoints. Being brainstormed in the PMO workspace (`C:\akhil\claude-fleet-projects`).

## ProjMgr Skill (In Progress — Brainstorming)
A Claude Code skill for project management workflows on fleet agents. See **[ProjMgr-requirements.md](ProjMgr-requirements.md)** for requirements and design discussions. Being brainstormed in `docs/`.


## Apra Labs Branding (Medium Priority)
The fleet MCP server has no Apra Labs branding anywhere — no logo, no company name in package.json, README, CLI output, or tool descriptions. Add consistent branding:
- `package.json`: author, homepage, repository fields
- `README.md`: Apra Labs header/logo, "Built by Apra Labs" footer
- CLI/server startup banner: show "Apra Labs — Claude Code Fleet MCP"
- GitHub repo: description, topics, social preview image
- GitHub Pages site (`apra-labs.github.io/claude-code-fleet-mcp`) for docs/marketing
- License header in source files if needed

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.

## Read Remote File Tool (Low Priority)
New MCP tool: `read_remote_file` — fetches a file from an agent's work folder and returns its contents. Primarily needed for binary files (tar.gz, screenshots, etc.) that can't be read via `execute_command` + `cat`. For text files, `cat` suffices. Not a blocker for PM skill.
