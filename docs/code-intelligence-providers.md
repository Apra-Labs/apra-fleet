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

## Evaluating a second provider: Joern selected over SCIP and tree-sitter

Three Apache 2.0 / MIT candidates were evaluated against the same six
criteria used to qualify GitNexus's replacement: permissive license, native
code graph/relationship analysis, semantic or structured search, active
maintenance, CLI/library usability (subprocess-spawnable), and TypeScript/
JavaScript + Python support at minimum.

- **Joern** (Apache 2.0) -- selected. Joern builds a Code Property Graph
  (CPG) that merges AST, control-flow graph, program-dependence graph, and
  call graph into one queryable structure, with a query language (CPGQL) that
  supports call-graph traversal, taint/data-flow analysis, and structural
  pattern matching. This is the only one of the three candidates whose native
  capabilities map onto all seven provider methods without building a
  separate graph layer: call graph traversal and transitive expansion cover
  `graph`/`impact`; CPGQL pattern queries cover `query`; single-symbol
  expansion (parameters, return type, callers, callees) covers `context`;
  file/namespace aggregation covers `map`; the data-flow engine
  (`reachableByFlows`) covers `flow`; and caller-traversal filtered by
  test-path heuristic covers `tests` (mirroring the same heuristic the
  GitNexus provider already uses).

- **SCIP / scip-typescript** (Apache 2.0) -- rejected. SCIP indexes produce
  symbol definitions, references, and hover docs -- strong for go-to-definition
  and find-references, which covers `query` and part of `context`, but there
  is no native call graph or data-flow analysis. The remaining methods
  (`graph`, `impact`, `map`, `flow`, `tests`) would require building a
  separate graph layer on top of the raw index, which defeats the purpose of
  picking an off-the-shelf tool.

- **tree-sitter** (MIT) -- rejected. tree-sitter is an incremental parser
  producing concrete syntax trees, not a code intelligence platform. It has
  no built-in call graph, data-flow, impact analysis, or architectural
  grouping; every provider method would need to be implemented from scratch
  on top of raw AST traversals. This is effectively building a new code
  intelligence engine rather than integrating an existing one -- tree-sitter
  is better suited as a parsing layer *inside* a tool like Joern than as the
  provider itself.

### Integration approach

Joern is intended to be driven the same way the existing GitNexus provider
drives its backend: as a spawned CLI subprocess per call, writing a short
CPGQL script to a temp file, running `joern --script <file>`, and parsing the
JSON printed to stdout. Joern also exposes an HTTP server mode
(`joern --server`) that accepts CPGQL queries over POST; if per-call
subprocess spawn latency proves too high once implemented, that is the
intended fallback, mirroring the existing MCP-over-stdio pattern used
elsewhere in the fleet's code-intelligence layer.

## Current status

A `JoernProvider` class exists implementing the `CodeIntelligenceProvider`
interface, but every method is a stub that throws `not implemented`. It is
**not** registered in the `PROVIDERS` map and is not imported anywhere outside
its own test file -- it introduces no behavioral change and carries no
regression risk, but it also delivers no functionality yet. Implementing the
seven methods against a live Joern CPG, registering the provider, and
deciding whether it becomes the new default (or an opt-in alternative
alongside GitNexus) remain open work.
