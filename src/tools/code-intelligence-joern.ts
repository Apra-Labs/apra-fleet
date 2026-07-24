// ---------------------------------------------------------------------------
// Code Intelligence Provider: Joern (Code Property Graph)
// ---------------------------------------------------------------------------
//
// DEPRECATED: This provider has been superseded by CodebaseMemoryProvider.
// See code-intelligence-codebase-memory.ts for the active implementation.
//
// Tool:     Joern (https://github.com/joernio/joern)
// Version:  v4.x (latest stable as of 2026-07)
// License:  Apache 2.0
//
// NOTE: This provider has been evaluated against codebase-memory-mcp and
// superseded. The implementation remains in source for historical reference.
// See evaluation summary below.
//
// ---------------------------------------------------------------------------
// Evaluation: codebase-memory-mcp vs Joern (5 comparison dimensions)
// ---------------------------------------------------------------------------
//
// DECISION: codebase-memory-mcp selected; Joern superseded.
//
// Both tools were evaluated across 5 comparison dimensions. The evaluation
// determined that codebase-memory-mcp is the superior choice.
//
// 1. EASE OF INTEGRATION
//    - Joern: Requires JVM + Scala REPL + custom subprocess scripting; no
//      native MCP support. High friction.
//    - codebase-memory-mcp: Native MCP transport (stdio, JSON-RPC 2.0); same
//      pattern as existing GitNexusProvider. Seamless integration.
//    - WINNER: codebase-memory-mcp
//
// 2. DEPENDENCY WEIGHT
//    - Joern: JVM (300+ MB) + Scala runtime + joern binary (~150 MB).
//      Significant deployment footprint.
//    - codebase-memory-mcp: Single static binary (~40 MB), no runtime
//      dependencies. Minimal footprint.
//    - WINNER: codebase-memory-mcp
//
// 3. LANGUAGE BREADTH
//    - Joern: ~10 languages (JS/TS, Python, C/C++, Java, Go, PHP, Ruby,
//      Kotlin, Swift)
//    - codebase-memory-mcp: 158 languages via tree-sitter AST coverage.
//    - WINNER: codebase-memory-mcp (15x broader)
//
// 4. ANALYSIS DEPTH
//    - Joern: Deeper control-flow and data-flow analysis (CPG merges AST,
//      CFG, PDG, call graph). Stronger at taint tracking and semantic
//      pattern matching.
//    - codebase-memory-mcp: Broader structural analysis (graph-based,
//      BFS traversal, change detection, architecture mapping). Strong on
//      relational queries and codebase-wide patterns.
//    - WINNER: Joern for depth, codebase-memory-mcp for breadth
//    - DECISION: Breadth is higher priority than maximum depth for this
//      codebase's requirements.
//
// 5. MCP TOOL COVERAGE
//    - codebase-memory-mcp provides 15 MCP tools with direct coverage for
//      all 7 CodeIntelligenceProvider methods:
//      * graph()    <- search_graph, trace_path
//      * impact()   <- detect_changes
//      * query()    <- query_graph, search_code
//      * context()  <- get_code_snippet, search_graph
//      * map()      <- get_architecture
//      * flow()     <- trace_path
//      * tests()    <- search_graph (test patterns)
//    - Joern: No native MCP tools; requires custom CLI subprocess pattern.
//    - WINNER: codebase-memory-mcp
//
// RATIONALE: Superior ease of integration, minimal dependencies, broad
// language support, and native MCP alignment outweigh Joern's deeper
// control-flow analysis. The codebase benefits more from breadth and
// maintainability than maximum semantic depth.
//
// ---------------------------------------------------------------------------
// Research summary -- 3 candidates evaluated
// ---------------------------------------------------------------------------
//
// 1. Joern (Apache 2.0) -- SELECTED
//    - Code Property Graph (CPG) platform: merges AST, CFG, PDG, and call
//      graph into a single queryable graph.
//    - Rich query language (Joern Query Language / CPGQL) over the Scala REPL
//      or via the joern-cli batch mode, enabling call graph traversal, data
//      flow analysis, impact analysis, and semantic pattern matching.
//    - Multi-language: JavaScript/TypeScript (via js2cpg / jssrc2cpg),
//      Python (pysrc2cpg), plus C/C++, Java, Go, PHP, Ruby, Kotlin, Swift.
//    - Actively maintained: frequent commits, multiple releases per year.
//    - Usable as CLI subprocess: `joern --script <file>` runs a CPGQL script
//      and prints JSON to stdout, or `joern-parse` generates a CPG that
//      `joern-export` can dump. Both are spawnable as child processes.
//    - Strongest match to all 7 CodeIntelligenceProvider methods -- native
//      call graphs, data-flow / taint tracking, and graph queries.
//
// 2. SCIP / scip-typescript (Apache 2.0) -- Rejected
//    - Sourcegraph Code Intelligence Protocol: produces SCIP index files
//      with symbol definitions, references, and hover documentation.
//    - Good for symbol navigation (go-to-definition, find-references) which
//      maps to query() and parts of context().
//    - Weakness: no native call graph or data-flow analysis. Cannot produce
//      impact analysis, process flows, or architectural communities without
//      building a separate graph layer on top of the raw SCIP index.
//    - Multi-language via separate indexers (scip-typescript, scip-python,
//      scip-java, etc.).
//    - Usable as CLI: `scip-typescript index` produces an SCIP file.
//    - Rejected because it covers only 2-3 of the 7 methods natively; the
//      remaining methods would require substantial custom graph construction.
//
// 3. tree-sitter (MIT) -- Rejected
//    - Incremental parsing library producing concrete syntax trees (CSTs).
//    - Extremely fast, widely adopted, supports 100+ languages via grammars.
//    - Weakness: it is a parser, not a code intelligence platform. It
//      produces ASTs but has no built-in call graph, data-flow, impact
//      analysis, community detection, or process-flow extraction. All 7
//      provider methods would need to be built from scratch on top of raw
//      AST traversals.
//    - Multi-language: excellent grammar coverage for TS/JS and Python.
//    - Usable as CLI (`tree-sitter parse`) or as a Node.js native module.
//    - Rejected because the integration effort is equivalent to building a
//      new code intelligence engine; it is better suited as a parsing layer
//      inside a higher-level tool like Joern or SCIP rather than as the
//      provider itself.
//
// ---------------------------------------------------------------------------
// Method mapping to Joern capabilities
// ---------------------------------------------------------------------------
//
// 1. graph(symbol)   -> CPGQL: `cpg.method.name("<symbol>").callee.l` and
//                       `cpg.method.name("<symbol>").caller.l` with transitive
//                       expansion up to depth N. Returns call graph nodes.
//
// 2. impact(target, direction) -> CPGQL: upstream = `cpg.method.name("<target>")
//                       .caller.repeat(_.caller)(_.maxDepth(N)).l`;
//                       downstream = `.callee.repeat(_.callee)(_.maxDepth(N)).l`.
//                       Joern also supports PDG-based data-flow impact via
//                       `reachableBy` / `reachableByFlows`.
//
// 3. query(query)    -> CPGQL: `cpg.method.name(".*<pattern>.*").l` for symbol
//                       search; `cpg.method.fullName(".*<pattern>.*").l` for
//                       qualified names; free-form CPGQL for structured queries.
//
// 4. context(name)   -> CPGQL: `cpg.method.name("<name>").l` for the symbol
//                       itself, `.caller.l` for direct callers, `.callee.l`
//                       for direct callees, `.parameter.l` for params,
//                       `.methodReturn.l` for return type.
//
// 5. map(top)        -> CPGQL: file-level or namespace-level aggregation:
//                       `cpg.method.groupBy(_.filename).map { case (f, ms) =>
//                       (f, ms.size) }.toList.sortBy(-_._2).take(N)`. Community
//                       detection can be approximated by grouping methods by
//                       file/package and counting cross-group call edges.
//
// 6. flow(from, to, name) -> CPGQL: `cpg.method.name("<from>")
//                       .repeat(_.callee)(_.until(_.name("<to>"))).path.l`
//                       traces execution paths. Joern's data-flow engine
//                       (`sink.reachableByFlows(source)`) provides precise
//                       step-by-step flow with file + line info.
//
// 7. tests(symbol)   -> CPGQL: upstream caller traversal filtered by test-path
//                       heuristic (same approach as gitnexus provider):
//                       `cpg.method.name("<symbol>").caller
//                       .repeat(_.caller)(_.maxDepth(2)).filter(m =>
//                       isTestPath(m.filename)).l`.
//
// ---------------------------------------------------------------------------
// Installation / spawning approach
// ---------------------------------------------------------------------------
//
// Joern is distributed as a standalone CLI package:
//   - Install: `curl -L https://github.com/joernio/joern/releases/latest/download/joern-install.sh | bash`
//     or via the joern npm wrapper / Docker image.
//   - Parse a project: `joern-parse <repo-path>` produces a `cpg.bin` file.
//   - Query via CLI subprocess: `joern --script query.sc --param name=<value>`
//     prints JSON to stdout. Each provider method will write a short CPGQL
//     script to a temp file and spawn `joern --script <file>` as a child
//     process, parsing stdout as JSON.
//   - Alternative: Joern exposes an HTTP server (`joern --server`) that
//     accepts CPGQL queries via POST. This could be used instead of per-call
//     subprocess spawning for lower latency, similar to the MCP transport
//     used by the gitnexus provider.
//
// Chosen approach: CLI subprocess per call (same as the existing gitnexus
// provider's MCP-over-stdio pattern). If latency becomes a concern, the
// implementation can switch to the HTTP server mode.
// ---------------------------------------------------------------------------

import type { CodeIntelligenceProvider } from './code-intelligence.js';

export class JoernProvider implements CodeIntelligenceProvider {
  async graph(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.graph() not implemented');
  }

  async impact(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.impact() not implemented');
  }

  async query(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.query() not implemented');
  }

  async context(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.context() not implemented');
  }

  async map(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.map() not implemented');
  }

  async flow(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.flow() not implemented');
  }

  async tests(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('JoernProvider.tests() not implemented');
  }
}
