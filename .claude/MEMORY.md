# Project Memory — apra-fleet

## MCP Server Restart Workflow
After every `npm run build`: call `shutdown_server` → user runs `/mcp` → confirm before live testing. The running process serves old code until restarted.

## Implementation Gotchas
- `getClaudeCommand(os, args)` in `src/utils/platform.ts` is the single source of truth for claude CLI invocations
- ssh2 streams require `stream.end()` after exec to close stdin (prevents `claude -p` from hanging)
- Auth validation: always use `claude -p "hello"` not `claude auth status` (the latter doesn't validate API keys)
