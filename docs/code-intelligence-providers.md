# Code Intelligence Providers

## Abstraction

Code intelligence (call graphs, impact analysis, structured/semantic search,
symbol context, architectural mapping, execution-flow tracing, and test
discovery) is exposed to the fleet through a single `CodeIntelligenceProvider`
interface (`src/tools/code-intelligence.ts`):

```ts
interface CodeIntelligenceProvider {
  graph(params): Promise<unknown>;
  impact(params): Promise<unknown>;
  query(params): Promise<unknown>;
  context(params): Promise<unknown>;
  map(params): Promise<unknown>;
  flow(params): Promise<unknown>;
  tests(params): Promise<unknown>;
}
```

The seven methods are the fixed contract every provider must implement, and
they correspond one-to-one with the fleet's `code_graph`, `code_impact`,
`code_query`, `code_context`, `code_map`, `code_flow`, and `code_tests` MCP
tools. A `PROVIDERS` registry maps provider names to instances; the active
provider is selected via a config file rather than being hardcoded, so a
second implementation can be added and switched to without touching the tool
handlers.

Rationale for the abstraction: the fleet's code intelligence today depends on
a single third-party tool (GitNexus). GitNexus is not Apache 2.0 / MIT / BSD
licensed, which is a constraint for downstream distribution. The provider
interface exists so an alternative, permissively-licensed backend can be
swapped in as the default without changing any call site -- every consumer
goes through `PROVIDERS[name]`, never through a concrete class directly.

## Evaluating a second provider: codebase-memory-mcp selected over Joern

Two Apache 2.0 / MIT candidates were evaluated as the permissively-licensed
replacement for GitNexus, across five dimensions: ease of integration,
dependency weight, language breadth, analysis depth, and MCP tool coverage
against the seven provider methods.

- **codebase-memory-mcp** (MIT) -- selected. It speaks the MCP protocol
  natively over stdio (JSON-RPC 2.0), the same transport the fleet already
  uses for GitNexus, so integration follows an identical client-lifecycle
  pattern with no custom subprocess scripting. It ships as a single static
  binary with no JVM or other runtime dependency, covers 158 languages via
  tree-sitter (versus Joern's roughly 10), and its 15 MCP tools map directly
  onto all seven provider methods (`search_graph` + `trace_path` for `graph`;
  `detect_changes` for `impact`; `query_graph`/`search_code` for `query`;
  `get_code_snippet` + `search_graph` for `context`; `get_architecture` for
  `map`; `trace_path` for `flow`; `search_graph` filtered to test paths for
  `tests`).

- **Joern** (Apache 2.0) -- rejected as the default, despite deeper
  control-flow and data-flow analysis (its Code Property Graph merges AST,
  CFG, PDG, and call graph, and supports taint tracking that
  codebase-memory-mcp does not attempt). Joern requires a JVM plus a Scala
  REPL and has no native MCP transport, meaning every call would need custom
  CLI-subprocess scripting; its narrower language coverage and heavier
  deployment footprint (JVM + Scala runtime versus a single ~40 MB binary)
  outweighed its analytical depth for this codebase's needs. Breadth,
  operational simplicity, and native MCP alignment were prioritized over
  maximum semantic depth.

The comparison is recorded in the source alongside the deprecated Joern
provider file, so the rationale stays discoverable at the point future
contributors would otherwise wonder why a second, unused provider exists.

## Current status

`CodebaseMemoryProvider` (`src/tools/code-intelligence-codebase-memory.ts`)
is registered in the `PROVIDERS` map and is the default provider returned by
`getProvider()` when no config file selects another one. It follows the same
MCP client lifecycle as `GitNexusProvider`: a shared singleton client, a
`StdioClientTransport` over stdio, identity-guarded `onclose`/`onerror`
handlers that reset the cached client/connection-promise so the next call
reconnects from scratch, and a failure-reset path on a rejected connect.

Two guards run before the child process is ever touched:
- A pre-flight check verifies `~/.cache/codebase-memory-mcp/` exists and is
  non-empty (i.e. some project has been indexed); if not, the provider
  returns a structured "no index" result instructing the caller to index the
  project, instead of spawning the binary.
- Any connection failure or dead-client error is converted into a structured
  "offline" result (same MCP content-array shape, `isError: true`) rather
  than an unhandled throw, and the shared connection state is reset so the
  next call attempts a fresh connect.

`GitNexusProvider` remains registered and selectable via the `gitnexus` key
in the provider config, but is no longer the default. The `JoernProvider`
file remains in source with a deprecation notice and the evaluation summary
above; it was never registered in `PROVIDERS` and carries no runtime
behavior.

## Per-member provider selection

The `Agent` interface carries an optional `codeIntelProvider` field
(`'codebase-memory' | 'gitnexus' | 'none'`), and `register_member` /
`update_member` accept a matching `code_intel_provider` input so an
individual member's preferred provider can be set at registration time or
changed later. `getProvider(memberId?)` resolves this per-member override
ahead of the fleet-wide default: when the calling member has
`codeIntelProvider` set, that provider wins; otherwise `getProvider()`
falls back to the global config file exactly as before. A member with
`codeIntelProvider: 'none'` resolves to a `NullProvider` -- an
implementation of `CodeIntelligenceProvider` whose seven methods each
return a structured "disabled for this member" result (`isError: false`,
same MCP content-array shape as every other provider) instead of throwing
or silently falling through to the default. This keeps opt-out
indistinguishable, from the caller's perspective, from a normal tool
response -- callers never need special-case handling for a member who has
turned code intelligence off.

Member context reaches the code-intel tool handlers (`code_graph`,
`code_impact`, `code_query`, `code_context`, `code_map`, `code_flow`,
`code_tests`) through a resolver that inspects which member's
`execute_prompt` dispatch is currently in flight. This is a heuristic, not
an explicit parameter on the tool schema: an MCP tool call carries no
caller identity of its own, so the dispatch layer infers it from
process-wide in-flight state. When exactly one member's `execute_prompt`
is in flight, that member's id is used to resolve the provider. When zero
or more than one member is in flight at the same time, the resolution is
ambiguous and the call falls back to the global config, the same as if no
member context were available at all. This means concurrent dispatch to
multiple members currently loses per-member code-intel routing for the
duration of the overlap -- a known limitation of inferring identity from
shared process state rather than threading it explicitly through the MCP
call. If concurrent multi-member dispatch becomes common, the fix is to
thread member identity through the MCP tool call itself (e.g. as an
out-of-band header or session key) rather than inferring it from
in-flight set cardinality.

Unit coverage exercises `getProvider(memberId)` resolution (member
override, `none` -> `NullProvider`, fallback to global config, unknown
member id), the `NullProvider` contract (all seven methods return the
disabled message and never throw), and the handler functions that thread
`memberId` through to `getProvider()`. End-to-end verification of the
full dispatch path -- confirming `execute_prompt` for a real member
actually reaches its configured provider through the running MCP
server, not just through directly-called handler functions -- is still
outstanding follow-on work.

## KB initialization lifecycle: pre-init phase

Before a repo is indexed for code intelligence, a pre-init phase gathers
the information needed to show the user an informed opt-in prompt rather
than silently indexing (or silently failing) on first use. Two pure,
best-effort helpers back this phase:

- **Provider availability detection** -- checks whether the code-intel
  provider binary is installed and executable by invoking it with a
  version flag. It never throws: any spawn failure (binary missing,
  non-zero exit, timeout) degrades to a structured "not available" result
  carrying the underlying error message, rather than raising an exception
  that would need to be caught by every caller.

- **Index size estimation** -- walks a repo's file tree to project file
  count, total byte size, and an estimated indexing time, so the opt-in
  prompt can tell the user roughly what indexing will cost before they
  agree to it. The walk respects `.gitignore` patterns (a minimal glob
  matcher, not a full gitignore spec implementation, but covering the
  common anchored/unanchored/wildcard cases repos actually use) plus a
  fixed set of default excludes (`node_modules`, `.git`, `dist`, `build`,
  `out`, `coverage`, `.cache`, `vendor`) that are never meaningful to
  index regardless of gitignore content. Like provider detection, it never
  throws -- any walk failure degrades to a zeroed or partial estimate
  rather than propagating. Note the glob matcher does not implement
  negation patterns (`!pattern`); a gitignore that re-includes a path under
  an otherwise-excluded directory will still have that path excluded from
  the estimate. This is acceptable for a rough pre-init size estimate, but
  the init phase's actual file-selection logic (not yet built) should not
  assume this matcher's semantics are gitignore-complete.

This pre-init phase is scaffolding for the init phase (first-time repo
indexing with a progress-reporting opt-in prompt) and the update phase
(incremental re-indexing on code changes triggered by staleness
detection). Neither the init nor the update phase has been built yet, so
the pre-init helpers are not currently invoked from any call path -- they
exist ahead of their consumer, with unit test coverage locking in their
contract so the init-phase implementation can build on a stable interface.
