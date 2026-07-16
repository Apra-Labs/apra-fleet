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
