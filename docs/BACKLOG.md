# Backlog

## Local Agent Integration Tests on Linux and macOS

The `cleanExec` pristine shell has only been integration-tested with a local Windows agent (`agent-win-local-1`). Need to add local agent entries to `fleet.config.json` for Linux and macOS hosts and run the integration test to verify:
- `env -i bash -l -c '...'` correctly rebuilds the environment from login profiles
- `child.stdin?.end()` prevents `claude -p` from hanging on those platforms
- Claude CLI finds its auth credentials (`.credentials.json`) in the clean env

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.
