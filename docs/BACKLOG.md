# Backlog

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.

## Read Remote File Tool (Low Priority)
New MCP tool: `read_remote_file` — fetches a file from an agent's work folder and returns its contents. Primarily needed for binary files (tar.gz, screenshots, etc.) that can't be read via `execute_command` + `cat`. For text files, `cat` suffices. Not a blocker for PM skill.

## Git Credential Provisioning (Medium Priority)
New MCP tool: `provision_git_credentials` — deploys git authentication tokens from the master machine to fleet agents. Same pattern as `provision_auth` for Claude credentials. Supports PAT-based auth for GitHub, Azure DevOps, Bitbucket, GitLab. The PM user generates a token once; the tool configures `git credential.helper` on each agent to use it. Required for PM skill git workflows (clone, fetch, push, PR creation).
