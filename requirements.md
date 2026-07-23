# Per-member code-intelligence provider routing

Source: apra-fleet-c6o.2

## Problem

`getProvider()` in `src/tools/code-intelligence.ts` resolves a single global
code-intelligence provider from `config.json`. Fleet members with different
provider preferences (gitnexus, codebase-memory, or none) all get the same
backend. Members that want code intelligence disabled still receive tool
responses that imply an active provider.

## Requirement

Route code-intelligence tool calls through the member's own provider setting
(`codeIntelProvider` on the Agent type, delivered by apra-fleet-c6o.1).

### Functional spec

1. **Per-member resolution** -- `getProvider(memberId?)` looks up the agent
   record and returns the provider matching `codeIntelProvider`. When the field
   is unset, fall back to the global config provider (backward compat).

2. **NullProvider** -- when `codeIntelProvider === 'none'`, return a
   `NullProvider` whose methods return structured disabled-messages (never
   throw). All 7 code-intelligence tool methods must be covered.

3. **Dispatch wiring** -- when code-intelligence tools are called from
   `execute_prompt`, the calling member's id is threaded through to
   `getProvider()`. Direct MCP tool calls with no member context still work
   via the global fallback. `memberId` is internal plumbing, not exposed in
   the tool's zod schema.

### Files in scope

- `src/tools/code-intelligence.ts` -- getProvider, NullProvider, tool handlers
- `src/services/registry.ts` -- agent lookup by id (if needed)
- `src/index.ts` -- member context threading for tool registration
- `tests/code-intelligence.test.ts` -- new tests

### Risk

The riskiest part is threading member context from the MCP tool handler layer
down to getProvider without breaking the 7 existing tool schemas. This should
be Task 1 conceptually (provider resolution) since the wiring depends on it.

## Non-goals

- Changing any tool's external schema
- Supporting runtime provider switching (per-call)
- Modifying the registration/update flow (already done in c6o.1)
