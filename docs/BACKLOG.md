# Backlog

## Auth Token Refresh

## Auth Token Refresh
Silently refresh and forward the OAuth token to fleet agents before deploying. If the token is near expiry or expired, refresh it automatically so agents don't fail prompts with stale credentials.

## Retry on Anthropic 500 Errors
When `execute_prompt` gets a 500 (internal server error) from the Anthropic API on a fleet device, detect this from the JSON output and automatically retry the prompt with backoff instead of returning the raw error.

## Detect Auth Errors in execute_prompt
When `execute_prompt` gets a "Not logged in" or auth error response from a fleet agent, return a clear message asking the user to run `/login` on the master machine to refresh credentials and re-run `provision_auth`. Currently the raw error JSON is returned without actionable guidance.

## Prompt User to /login When Credentials Missing
When `provision_auth` detects that `~/.claude/.credentials.json` is missing, suggest the user run `/login` on the CLI to create it. Makes the workflow more discoverable.

## Shell Strategy Variants (Low Priority)
Add support for different Windows SSH shell types: `windows-cmdExe`, `windows-gitbash` (derives from linux). Currently all Windows commands assume PowerShell as the SSH default shell, but some Windows SSH servers use cmd.exe or Git Bash.
