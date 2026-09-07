# Structured Errors in the apra-fleet MCP Server

**Status: partially adopted.** Option 2 below is implemented for the two tools the workflow
layer depends on most -- `execute_prompt` and `execute_command` (`src/tools/` in this
monorepo) return a `structuredContent` payload carrying `isError` plus a `reason` code
(`'busy'`, `'reserved'`, `'session_not_found'`, `'insufficient_context_headroom'`,
`'budget_exhausted'`, `'workspace_not_trusted'`, ...). `src/workflow/errors.mjs`'s
`AgentDispatchError` is classified from exactly that payload.

The rest of the tool surface has not adopted it. Some conditions -- notably "member not
found" -- are still returned as ordinary success-shaped text, and the workflow layer
classifies them with a text sniff (`text.startsWith('Member "') && text.includes('" not
found.')` in `src/workflow/index.mjs`) into the typed hierarchy described in
`docs/apra-fleet-workflow-architecture.md` section 4.4. That sniff is the remaining gap this
document tracks; the design below is what the remaining tools should adopt.

## Problem Statement

Where the `apra-fleet` MCP server embeds error strings within successful text payloads, it
forces clients to implement fragile parsing logic to determine whether a tool call succeeded
or failed by inspecting the text content. This is an anti-pattern that violates the
principles of structured communication and makes error handling across the fleet unreliable.

## The two options

Structured errors across the remaining tool calls can be achieved in two ways:

### Option 1: Standard MCP JSON-RPC Error Codes (Recommended)

Leverage the existing MCP protocol's support for JSON-RPC error responses. When a tool call fails, the server should return a standard JSON-RPC error response object rather than a success response with an embedded error string.

**Example Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Internal error: Failed to provision LLM auth",
    "data": {
      "details": "Authentication server timeout"
    }
  }
}
```

### Option 2: Standardized Payload Structure (the shape already adopted by `execute_prompt`/`execute_command`)

Where JSON-RPC error responses are not feasible due to specific architectural constraints, standardize a JSON payload structure for tool responses that explicitly indicates success or failure. This is the shape the two dispatch tools already emit, under `structuredContent`.

**Example Error Payload:**
```json
{
  "isError": true,
  "code": "AUTH_FAILED",
  "message": "Failed to provision LLM auth: Authentication server timeout",
  "data": null
}
```

**Example Success Payload:**
```json
{
  "isError": false,
  "data": {
    "status": "success",
    "message": "Successfully registered member."
  }
}
```

## Benefits

1. **Robust Client Logic**: Clients will no longer need to parse unstructured text to detect errors.
2. **Simplified Error Handling**: Structured errors allow clients to implement uniform error handling strategies (e.g., retries, logging, alerting) based on standard error codes.
3. **Improved Interoperability**: By adhering to standard MCP JSON-RPC error patterns (Option 1), `apra-fleet` will be more compatible with standard MCP clients and debugging tools.
4. **Better Developer Experience**: Clear, typed error definitions make it easier for developers to integrate with the `apra-fleet` server.

## Remaining work

1. Define a standard set of error codes and messages for the tools that do not yet emit one,
   reusing the `reason` vocabulary the dispatch tools already established.
2. Update those tool handlers to return the structured error.
3. Route the client's JSON-RPC rejection path
   (`McpClient.handleMessage`, `packages/apra-fleet-client/src/client/client.mjs`) through
   the same classifier, so the same typed classes are raised regardless of which signal the
   server used.
4. Retire the "member not found" text sniff in `src/workflow/index.mjs` once
   `MEMBER_NOT_FOUND` is reported structurally.
