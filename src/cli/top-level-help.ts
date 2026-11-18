/** Text of `apra-fleet --help`. Kept out of src/index.ts (a run-on-import script) so tests can import it. */
export function topLevelHelp(serverVersion: string): string {
  return `apra-fleet ${serverVersion}

Usage:
  apra-fleet                  Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet run              Start MCP server (HTTP, default) -- used by LLM providers after install
  apra-fleet run --transport stdio   Start MCP server (stdio)
  apra-fleet --stdio          Alias for run --transport stdio (backward compat for existing MCP configs)
  apra-fleet start            Start the fleet server service
  apra-fleet stop             Stop the fleet server service
  apra-fleet restart          Restart the fleet server service
  apra-fleet status           Show server and service status
  apra-fleet update           Check for and install latest update
  apra-fleet update --check   Check for update
  apra-fleet watch            Stream live member logs (see 'watch --help')
  apra-fleet workflow <name> [args...]  Run an installed workflow (see 'workflow --help')
  apra-fleet workflow --list            List installed workflows
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet -- PM depends on fleet)
  apra-fleet install --skill none      Skip skill installation
  apra-fleet install --no-skill        Same as --skill none
  apra-fleet register-member --name <name> --path <folder> [options]  Register a fleet member from the shell (see 'register-member --help')
  apra-fleet remove-member --id <uuid> [--force]   Remove a member registration from this install (see 'remove-member --help')
  apra-fleet call --member <uuid> <tool> [--args-file <path>] Call a tool as a member session (see 'call --help')
  apra-fleet call --member <uuid> --list-tools                List the member session's tools
  apra-fleet uninstall                 Remove binary, hooks, and MCP registration
  apra-fleet secret --set <name>       Deliver a secret to a waiting request
  apra-fleet secret --list             List secrets
  apra-fleet secret --delete <name>    Delete a secret
  apra-fleet secret --confirm <credential-name>               Confirm network egress for that credential (interactive)
  apra-fleet auth --oauth [--llm <provider>] <token>          Write OAuth token to provider credential file
  apra-fleet auth --oauth [--llm <provider>] secret.<name>    Resolve token from persistent credential store
  apra-fleet auth --oauth --member <name> secret.<name>       Provision a member's encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN directly (no credential file)
  apra-fleet auth --api-key [--llm <provider>] <token>        Set API key in shell profiles / system env
  apra-fleet auth --api-key [--llm <provider>] secret.<name>  Resolve API key from persistent credential store
  apra-fleet kb directives                             List pending + active user-directives
  apra-fleet kb approve-directive <id>                 Activate a pending directive proposal (human-only)
  apra-fleet kb reject-directive <id>                  Reject a proposal or retire an active directive
  apra-fleet kb add-directive "<text>" [--symbols a,b] Create an already-active directive (human-only)
  apra-fleet kb commit [--repo <path>] [--global]      Re-export + auto-commit the canonical bible (manual/recovery)
  apra-fleet kb profile [full|developer|custom <a,b>]  Show or set the KB tool profile for interactive sessions
  apra-fleet kb-server [--port <n>] [--generate-token] [--db <path>] [--token-file <path>]  Run the shared KB HTTP server (see 'kb-server --help')
  apra-fleet join <member-jwt> [--hub-url <url>]  Activate a device using a member JWT obtained out-of-band from fleet-dashboard
  apra-fleet spoke <origin-member-id>        Run as an outbound hub-connected spoke; requires apra-fleet join first
  apra-fleet --version        Print version
  apra-fleet --help           Show this help`;
}
