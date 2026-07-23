# Requirements: Per-member code-intelligence provider routing

Source issue: apra-fleet-c6o.2 (P1)
Sprint root: apra-fleet-dg2
Branch: test/kb-eval-b (base: main)

## Goal

Route code-intelligence tool calls through per-member provider configuration
so each fleet member can use a different code-intelligence backend (gitnexus,
codebase-memory, or none).

## Background

apra-fleet-c6o.1 (closed) added the `codeIntelProvider` field to the Agent
type and register/update schemas. This sprint implements the runtime routing:
`getProvider()` resolves per-member when a memberId is supplied, falls back
to the global config otherwise, and returns a NullProvider for members with
provider set to 'none'.

## Scope

Three tasks, sequential dependencies:

1. **apra-fleet-c6o.2.1** (premium) -- Implement per-member provider
   resolution in getProvider(). Add NullProvider class. Modify
   src/tools/code-intelligence.ts and src/services/registry.ts.

2. **apra-fleet-c6o.2.2** (premium) -- Wire member context into code-intel
   tool dispatch. Thread memberId from MCP tool handler through to
   getProvider(). Modify src/index.ts and src/tools/code-intelligence.ts.

3. **apra-fleet-c6o.2.3** (standard) -- Write/extend tests in
   tests/code-intelligence.test.ts for per-member routing, NullProvider,
   and global fallback.

## Risk

Primary risk: the MCP tool handler path may not have a clean way to thread
memberId without changing tool schemas. Task 2 front-loads this -- if schema
changes leak to the external interface, that is a blocker.

## Acceptance criteria (from source issue)

- getProvider(memberId?) resolves per-member provider when set
- Fallback to global config.json when member has no preference
- 'none' provider returns structured disabled-message without errors
- Code-intel tool calls from execute_prompt pass the member context
- All tests pass: npm test
