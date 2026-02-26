# Project Memory — claude-code-fleet-mcp

## MCP Server Restart Workflow
After every `npm run build`:
1. Call `shutdown_server` tool to kill the running MCP server
2. Tell the user to run `/mcp` to restart
3. Wait for the user to confirm before proceeding with live testing

## Key Patterns
- All read-only tools (`list_agents`, `fleet_status`, `agent_detail`) support `format: compact | json` (default: compact)
- Compact format: pack multiple fields per line, stay under 4 lines to avoid console collapse
- `getClaudeCommand(os, args)` in `src/utils/platform.ts` is the single source of truth for claude CLI invocations
- ssh2 streams require `stream.end()` after exec to close stdin (prevents `claude -p` from hanging)
- Auth validation: always use `claude -p "hello"` not `claude auth status` (the latter doesn't validate API keys)
