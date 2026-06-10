# Knowledge Layer

> Architecture overview for the apra-fleet Knowledge Layer.
> This document is a placeholder -- full content added in Phase 4.

## Overview

The knowledge layer consists of two planes:

1. **KB Service (Learned Knowledge)** -- SQLite-backed store of learnings,
   runbooks, context-cache entries, and knowledge captured by agents.
   Implements the `MemoryProvider` interface (see `src/services/knowledge/`).

2. **Codebase Plane (GitNexus)** -- AST-level graph of the repository.
   Provides structural context: symbol definitions, call graphs, file impact.
   Configured as an MCP server in `.mcp.json`.

## GitNexus Configuration

GitNexus is added to `.mcp.json` as an MCP server:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus", "mcp"]
    }
  }
}
```

Run `npx gitnexus analyze` to build the initial graph before use.

## DB Path

`$APRA_FLEET_DATA_DIR/knowledge/kb.sqlite` (defaults to `~/.apra-fleet/data/knowledge/kb.sqlite`).

## Setup

Full setup guide coming in Phase 4. See `docs/architecture.md` for system context.
