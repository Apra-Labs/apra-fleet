# Proposal: Structured Errors in apra-fleet MCP Server

Design note: this proposes a server-side change to the apra-fleet MCP server (an external
repository, outside this package) and is not yet implemented. Until it lands, the workflow
layer in this package (`src/workflow/errors.mjs`) implements a client-side stopgap --
classifying certain known failure text patterns (e.g. a missing member) into the typed error
hierarchy described in `docs/apra-fleet-workflow-architecture.md` section 4.4 -- which this
proposal's "Migration Path" step 3 anticipates replacing once the server ships either option
below.

## Problem Statement

Currently, the `apra-fleet` MCP server embeds error strings within successful text payloads. This approach forces clients to implement fragile parsing logic to determine whether a tool call succeeded or failed by inspecting the text content. This is an anti-pattern that violates the principles of structured communication and makes error handling across the fleet unreliable.

## Proposed Solution

We propose updating the `apra-fleet` MCP server to provide structured errors across all its tool calls. This can be achieved in two primary ways:

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

### Option 2: Standardized Payload Structure

If using JSON-RPC error responses is not feasible due to specific architectural constraints, we should standardize a JSON payload structure for all tool responses that explicitly indicates success or failure.

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

## Migration Path

1. Define a standard set of error codes and messages for the `apra-fleet` server.
2. Update the tool handlers in the `apra-fleet` server to return the structured errors.
3. Publish a new version of the server and update clients to handle the new structured errors.
4. (Optional) Provide a backward-compatibility layer or transition period if necessary, though a clean break is preferred if possible.
