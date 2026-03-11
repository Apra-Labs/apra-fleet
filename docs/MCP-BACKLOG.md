# Backlog

## Git Auth — Remaining (Low Priority)
- Auto-cleanup: TTL-based removal of credential helper file after token expiry (nice-to-have, tokens expire in 1hr anyway)

## PM Skill (In Progress — Brainstorming)
A Claude Code skill that automates the PM workflow. Currently the PM pattern (CLAUDE.md + PLAN.md + progress.json pushed to agents, monitor/resume cycle) is executed manually by the operator. The skill should automate: plan generation from requirements, progress.json scaffolding with tasks/verify checkpoints, pushing control files to agents, kicking off execution, monitoring progress, and auto-resuming after verify checkpoints. Being brainstormed in the PM workspace (`C:\akhil\claude-fleet-projects`).

## ProjMgr Skill (In Progress — Brainstorming)
A Claude Code skill for project management workflows on fleet agents. See **[ProjMgr-requirements.md](ProjMgr-requirements.md)** for requirements and design discussions. Being brainstormed in `docs/`.

## Auto-Push in Verify Tasks (High Priority)
When generating planned.json / progress.json, every VERIFY checkpoint task should automatically include a `git push origin <branch>` step. This ensures the code is on origin before the reviewer is triggered — no more "branch not found" failures. The PM/ProjMgr skill should bake this into plan generation so it's not dependent on the operator remembering.

## Feature Shipping Pipeline Documentation (Medium Priority)
The PM skill documentation should clearly describe the end-to-end pipeline for shipping features: **vision → requirements → design → plan → progress**. Each stage should be explained simply — what it is, what artifact it produces, and how it flows into the next. This gives operators (and Claude) a shared mental model of how work moves from idea to shipped code.


## Vocabulary Cleanup — "agent" → "worker" (Medium Priority)
The term "agent" is overloaded — it means both fleet members and Claude subagents, causing confusion in logs and conversation. See **[vocabulary.md](vocabulary.md)** for the proposed terminology. Rename "agent" to "worker" in user-facing descriptions, keep `agent_id` in API for backwards compatibility.

## Apra Labs Branding (Medium Priority)
The fleet MCP server has no Apra Labs branding anywhere — no logo, no company name in package.json, README, CLI output, or tool descriptions. Add consistent branding:
- `package.json`: author, homepage, repository fields
- `README.md`: Apra Labs header/logo, "Built by Apra Labs" footer
- CLI/server startup banner: show "Apra Labs — Apra Fleet"
- GitHub repo: description, topics, social preview image
- GitHub Pages site (`apra-labs.github.io/apra-fleet`) for docs/marketing
- License header in source files if needed

## send_files Flat Placement (Low Priority)
`send_files` uses basename only when placing files on the agent. Sending two files with the same basename from different folders silently overwrites the first. Consider preserving relative directory structure or warning on basename collisions.

## reset_session Should Check for Running Work (Low Priority)
`reset_session` clears the stored session ID but does NOT stop any running Claude process on the agent. If called while an agent is mid-task, the process keeps running but PM loses the ability to resume that conversation, and the next `execute_prompt` starts a fresh session that may conflict. Consider checking BUSY status before allowing reset, or optionally killing the running process.

## execute_prompt max-turns Awareness (Medium Priority)
`execute_prompt` hardcodes `--max-turns 50`. Complex tasks can exhaust this limit, causing the agent to stop mid-work without explicit failure. Consider making max-turns configurable per call, or returning a signal when the turn limit was reached so callers can distinguish "task complete" from "ran out of turns."

## Agent Decommissioning Protocol (Low Priority)
`remove_agent` does best-effort credential cleanup but doesn't remove SSH keys from `authorized_keys` or delete working folders on the remote machine. Consider a full decommissioning flow: (1) verify no running work, (2) revoke VCS auth, (3) remove SSH public key from authorized_keys, (4) optionally clean working folder, (5) remove from registry.

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.

## Read Remote File Tool (Low Priority)
New MCP tool: `read_remote_file` — fetches a file from an agent's work folder and returns its contents. Primarily needed for binary files (tar.gz, screenshots, etc.) that can't be read via `execute_command` + `cat`. For text files, `cat` suffices. Not a blocker for the PM skill.
