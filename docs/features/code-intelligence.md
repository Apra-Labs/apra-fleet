# Code intelligence: provider abstraction and per-member routing

## What it is

Apra Fleet exposes seven MCP tools -- `code_graph`, `code_impact`, `code_query`,
`code_context`, `code_map`, `code_flow`, `code_tests` -- that let an agent trace
call graphs, find upstream/downstream callers, search symbols, and map
codebase structure without falling back to grep or ad-hoc file reads. These
tools are backed by a pluggable `CodeIntelligenceProvider` interface rather
than a single hard-wired backend, so the underlying indexing engine can be
swapped per-fleet or per-member.

## Provider abstraction

`CodeIntelligenceProvider` (defined in `src/tools/code-intelligence.ts`)
declares one async method per tool (`graph`, `impact`, `query`, `context`,
`map`, `flow`, `tests`), each taking a params object and returning an MCP-shaped
result (`{ content: [...], isError }`). Three concrete providers implement it,
registered in a `PROVIDERS` map keyed by name:

- `gitnexus` -- wraps the `gitnexus` MCP server as a child process over
  stdio.
- `codebase-memory` -- wraps `codebase-memory-mcp`, selected over Joern
  after evaluation (see the code's evaluation notes for the comparison);
  Joern's own provider file is kept but superseded, not deleted.
- `none` -- `NullProvider`, returns a structured "disabled" result
  (`isError: false`, explanatory text) for every method instead of throwing
  or being unreachable. This makes "code intelligence off" a normal,
  well-typed response path rather than a special-cased error.

Both real providers follow the same lifecycle pattern independently: a
shared singleton MCP client connected lazily over `StdioClientTransport`,
`onclose`/`onerror` handlers that null out the cached client/promise so the
*next* call reconnects from scratch (no manual restart needed), and a
pre-flight check that returns a structured "no index found" result without
ever spawning the child process when the repo has never been indexed. This
duplication is intentional: the two providers wrap genuinely different CLI
tools with different persistence locations and error semantics, so sharing
a base class would obscure more than it would save.

Supporting concerns are split into single-purpose modules rather than folded
into the providers themselves, specifically to avoid circular imports (the
providers import `CodeIntelligenceProvider` as a type from
`code-intelligence.ts`, so any shared helper `code-intelligence.ts` also
needs must live outside it):

- `code-intelligence-freshness.ts` -- pure comparison function that produces
  a "your index is behind HEAD" note; no IO, fully unit-testable in
  isolation.
- `code-intelligence-reindex.ts` -- decides when to kick off a background
  re-index after a freshness divergence is detected.
- `code-intelligence-telemetry.ts` -- lightweight usage/latency recording.
- `code-intelligence-tests.ts` -- `isTestPath()`, a shared heuristic both
  providers use to classify test files.

## Per-member provider resolution

Each `Agent` may carry an optional `codeIntelProvider: 'codebase-memory' |
'gitnexus' | 'none'` field (nullable/unset means "use the fleet-wide
default"), settable through `register_member` and `update_member` via a
`code_intel_provider` input parameter.

`getProvider(memberId?)` is the single resolution point every tool handler
calls before delegating:

1. If a `memberId` is supplied and that agent has `codeIntelProvider` set,
   use that provider.
2. Otherwise, fall back to the fleet-wide `config.json` provider setting
   under the code-intelligence data directory (defaults to
   `codebase-memory` if the file is absent or unreadable).
3. If the resolved provider key doesn't match a registered provider, throw
   -- this is a configuration error (unlike "no memberId" or "provider is
   none", which are both normal, expected paths).

The `memberId` a tool handler receives is *not* part of its Zod input
schema -- it is threaded separately through the MCP `extra` parameter that
`wrapTool` passes to every handler (`extra?._meta?.memberId`). Direct/manual
MCP tool calls have no `_meta.memberId` and silently get the fleet-wide
default; calls dispatched through `execute_prompt` carry the calling
member's ID and get that member's per-member override. This is the same
`extra._meta` threading pattern other context-aware tools use -- new
per-member-aware tools should follow it rather than inventing a parallel
mechanism (e.g. an explicit `member_id` field in the public schema, which
would let a caller impersonate a different member's provider choice).

**Non-obvious pitfall**: registering a tool with `wrapTool('name', (input) =>
handler(input))` (dropping the `extra` parameter) silently breaks per-member
resolution -- the handler always receives `memberId === undefined` and
falls through to the fleet-wide default, with no type error and no runtime
error, only wrong provider selection. Every code-intel tool registration
must forward `extra` and read `extra?._meta?.memberId` explicitly.
