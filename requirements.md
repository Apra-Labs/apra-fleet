# apra-fleet -- Code Intelligence Abstraction

## Background

Fleet members currently use GitNexus MCP tools directly (`call_graph`, `impact`, `query`,
`context`). These tool names are provider-specific. If the code intelligence backend
changes (e.g. replaced by Sourcegraph, a custom AST tool, or a cloud service), every
template and every member prompt must change.

The user also expects that the `.mcp.json` approach (wiring gitnexus directly into the
project) is hidden inside fleet -- members and users should never need to know which
backend is in use.

## Goal

Wrap code intelligence behind a fleet-owned abstraction (strategy pattern). Fleet exposes
stable tool names. The current implementation uses GitNexus. Future providers slot in by
changing config, not templates.

## Requirements

### R1 -- Fleet-owned code intelligence MCP tools

Add four tools to the apra-fleet MCP server:

| Fleet tool | Wraps (gitnexus default) | Purpose |
|---|---|---|
| `code_graph` | `call_graph` | Call graph for a symbol (callers + callees) |
| `code_impact` | `impact` | Blast radius for a symbol (upstream affected) |
| `code_query` | `query` | Semantic search across codebase |
| `code_context` | `context` | Full symbol context (callers, callees, flows) |

Each tool:
- Accepts the same parameters as the underlying gitnexus tool
- Reads provider config to route to the correct backend
- Returns the backend's response unchanged
- Fails with a clear message if no backend is configured or indexed

### R2 -- Provider config + simple extension path

`apra-fleet install` Step 9 writes a code intelligence provider config:
```
~/.apra-fleet/data/code-intelligence/config.json
```
```json
{ "provider": "gitnexus" }
```

Implementation uses a single router file (`src/tools/code-intelligence.ts`) with a
provider map:
```typescript
const PROVIDERS = {
  gitnexus: gitnexusProvider,
  // future: sourcegraphProvider, customProvider, ...
};
```

Adding a new provider = implement the `CodeIntelligenceProvider` interface + add one
entry to the map. No changes to MCP tool registration, templates, or installer.

### R3 -- Remove direct gitnexus dependency from templates

Update `tpl-doer.md` and `tpl-reviewer.md`:
- Replace all `call_graph`, `impact`, `query`, `context` references with
  `code_graph`, `code_impact`, `code_query`, `code_context`
- Remove any mention of "GitNexus" from the template body

The KB section in both templates becomes:
```
- During work: use code_graph, code_impact, code_query for cross-file tracing
  and symbol lookup -- never plain-read files for structural questions.
```

### R4 -- .mcp.json no longer required for code intelligence

`apra-fleet install` Step 9 must NOT write a gitnexus entry to `.mcp.json`.
Code intelligence is served through the fleet MCP server -- no separate MCP server
entry is needed.

For repos that already have a gitnexus entry in `.mcp.json` (from prior installs),
the installer should remove it during Step 9.

### R5 -- knowledge-agent.md updated

`skills/fleet/knowledge-agent.md` Phase 1 (Prime) section currently mentions
`call_graph`, `impact`, `query` by name. Update to use fleet tool names:
`code_graph`, `code_impact`, `code_query`, `code_context`.

## Out of Scope

- Implementing a second provider (Sourcegraph, etc.) -- only gitnexus is wired now
- Changing the gitnexus CLI invocation or index format
- Any changes to the KB tools (kb_session_prime, kb_harvest, etc.)

## Acceptance Criteria

1. `code_graph("handleIPChange")` called on a fleet member returns the same result as
   `call_graph("handleIPChange")` called directly on gitnexus
2. tpl-doer.md contains no mention of "gitnexus", "call_graph", "impact", "query", "context"
   (only `code_graph`, `code_impact`, `code_query`, `code_context`)
3. A fresh `apra-fleet install` on a clean repo does NOT create a gitnexus entry in `.mcp.json`
4. `npm test` passes
5. `npm run build` clean
