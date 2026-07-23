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

## Per-member provider selection (schema and visibility done; routing not yet wired)

The `Agent` interface carries an optional `codeIntelProvider` field
(`'codebase-memory' | 'gitnexus' | 'none'`), and `register_member` /
`update_member` accept a matching `code_intel_provider` input so an
individual member's preferred provider can be set at registration time or
changed later. The intent is per-member override of the fleet-wide default
selected by `getProvider()`: a member with `codeIntelProvider: 'none'`
should be able to opt out of code intelligence entirely, and a member with
an explicit provider name should route to that provider regardless of the
global config.

The provider choice is now visible everywhere a member is inspected:
`register_member` and `update_member` success messages include a
`Code-Intel:` line whenever the field is set, and `fleet_status` (both the
compact text summary and the JSON output) lists each member's
`codeIntelProvider`, falling back to the literal string `"global default"`
when the member has no override. This fallback is deliberate: it makes the
absence of a per-member override visually distinct from an explicit
selection, so an operator scanning fleet status can immediately tell which
members are pinned to a specific provider versus inheriting whatever the
global config currently points at.

As things stand, the field is only persisted to the agent registry and
surfaced for display -- no downstream logic reads it to change behavior
yet. `getProvider()` still resolves purely from the global config file, and
no code-intel tool dispatch path consults the calling member's
`codeIntelProvider`. The routing half of this feature (resolving
`getProvider()` per-member and wiring member context into the
`code_graph`/`code_impact`/etc. tool handlers) is a separate, not-yet-built
increment. Until that lands, setting `code_intel_provider` on a member is
purely informational -- it changes what fleet_status and the register/update
success messages report, but does not change which provider actually
services that member's code-intel calls.

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
detection). The update phase has not been built yet.

## KB initialization lifecycle: init phase (first-time indexing)

`kb_setup` now doubles as the trigger for first-time code-intelligence
indexing, rather than requiring a separate explicit command. On every
`kb_setup` invocation it checks whether the repo already has a recorded
index (see per-repo config below); if not, and the provider binary is
available, it shells out to the provider's `index_repository` CLI
subcommand and records success in the repo's config file. This keeps
"set up a repo for the fleet" a single operation from the caller's
perspective instead of a multi-step dance.

The behavior is intentionally conservative on every edge:

- **Idempotent** -- if `.apra-fleet/code-intel.json` already has an
  `indexedAt` timestamp, `kb_setup` skips re-indexing entirely and reports
  that it did so. Re-running `kb_setup` on an already-indexed repo is a
  no-op for the indexing step.
- **Degrades gracefully when the provider is unavailable** -- reuses the
  pre-init phase's `detectProviderAvailability()` check; when the provider
  binary is missing, indexing is skipped with an explanatory step message
  rather than failing the whole `kb_setup` call.
- **Reports actionable failure** -- if the provider binary is present but
  indexing fails (non-zero exit, timeout), the error message includes the
  exact CLI invocation to re-run manually, since indexing is a
  potentially long-running, side-effecting operation that should not be
  silently retried by the caller.
- **Bounded runtime** -- indexing is subprocess-spawned with a generous but
  finite timeout so a hung indexer cannot hang `kb_setup` (and therefore
  the calling agent) indefinitely.

What this phase does **not** yet do: report incremental progress (files
indexed / total) during the run, or clean up a partial index on failure.
Both are still-open acceptance criteria for the init phase; the current
implementation treats indexing as an opaque, all-or-nothing subprocess
call.

### Per-repo code-intel config

Whether and when a repo has been indexed is recorded in
`.apra-fleet/code-intel.json` at the repo root, with an `enabled` flag and
an optional `indexedAt` timestamp. A small reader/writer module owns this
file: reading tolerates a missing or corrupt file by returning `null`
(callers treat "no config" as "not yet indexed" rather than raising),
and writing creates the `.apra-fleet` directory on demand.

This config file is designed to serve two purposes, only the first of
which is wired up so far:

1. **Idempotency marker for the init phase** (done) -- `kb_setup` reads it
   to decide whether to skip re-indexing, and writes it after a
   successful index.
2. **Per-repo opt-out gate for code-intel tool calls** (not yet wired) --
   the intent is for an `enabled: false` config to make code-intel tools
   (`code_graph`, `code_query`, etc.) return a structured "disabled"
   message instead of resolving a provider at all, so a repo owner can
   turn code intelligence off for a specific repo without touching the
   global provider config. As of this sprint, nothing reads the `enabled`
   flag to gate tool dispatch -- only `indexedAt` is consulted, and only
   by `kb_setup`'s own idempotency check.
