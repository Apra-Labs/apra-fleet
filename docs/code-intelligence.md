# Code Intelligence Tools

Code-intelligence exposes symbol-level queries (`code_query`, `code_references`,
`code_definition`, `code_graph`, `code_impact`) as MCP tools backed by a pluggable
provider layer, so different fleet members can use different code-indexing backends
(or none at all) without the orchestrator or dispatch code caring which one is active.

## Provider abstraction

`CodeIntelProvider` is the interface every backend implements:

- `query(symbol, opts?)`
- `getReferences(symbol)`
- `getDefinition(symbol)`
- `getCallGraph(symbol, depth?)`
- `getImpact(symbol)`

Every method returns a `CodeIntelResult` (`{ success, data?, error? }`) synchronously
and **never throws**. A backend that can't answer a query (disabled, unconfigured,
lookup failure) reports that as `{ success: false, error: "..." }` rather than raising
an exception. This matters because these tools sit behind MCP tool-call dispatch: a
thrown error there produces an opaque failure for the calling agent, whereas a
structured `success: false` result lets the agent see *why* and decide what to do next
(e.g. fall back to grep, or just note code-intel isn't available for this member).

Two providers ship built in:

- **`NullProvider`** (`name: 'none'`) -- explicit opt-out. Every method returns a
  "disabled for this member" message. Selected when a member's `codeIntelProvider` is
  set to `'none'`.
- **`DefaultProvider`** (`name: 'default'`) -- the fallback when no specific backend is
  configured. Every method returns a "not configured" message. This is intentionally a
  placeholder, not a real indexer -- it exists so that calling any code-intel tool is
  always safe (never a hard failure) even before a real backend is wired in for a
  member.

Additional real backends (an actual indexer/call-graph engine) register themselves in
the `PROVIDERS` map under their own name; nothing else in the dispatch path needs to
change to add one.

## Per-member provider resolution

Each `Agent` record carries an optional `codeIntelProvider: string` field. `getProvider`
resolves which backend instance to use:

1. No `memberId` given -> global `DefaultProvider` (this is what makes the tools
   backward compatible with callers that don't know about per-member routing).
2. `memberId` given but the agent has no `codeIntelProvider` set -> falls back to the
   global default.
3. `memberId` given and `codeIntelProvider` names a provider not present in `PROVIDERS`
   -> falls back to the global default (never throws on an unknown/misconfigured name).
4. `memberId` given and `codeIntelProvider` matches a registered provider -> that
   provider instance is used, including `'none'` -> `NullProvider`.

Resolution always degrades to "default" rather than failing outright. This is a
deliberate trade-off: an unrecognized or missing provider name is treated as "not
configured yet" rather than an error condition, since code-intel is an enhancement to
agent capability, not something dispatch should ever block on.

## Wiring into dispatch

The MCP tool handlers for `code_query` / `code_references` / `code_definition` /
`code_graph` / `code_impact` need to know *which* fleet member is asking, but the MCP
tool-call surface itself carries no member identity parameter (it's not part of the
tool's public schema -- callers just pass `symbol`, `opts`, etc.).

The resolution strategy is a heuristic based on in-flight dispatch state: when exactly
one member currently has a prompt in flight (`inFlightAgents.size === 1`), that member
is assumed to be the caller and its `codeIntelProvider` is used. If zero or more than
one member is in flight, the member is ambiguous and the tools fall back to the global
default provider rather than guessing wrong.

This is intentionally conservative -- it only attributes a code-intel call to a specific
member when there's no ambiguity. Multi-member concurrent dispatch scenarios (more than
one member in flight at once) fall back to shared/default behavior for code-intel calls
until the tool-call surface carries explicit member identity end-to-end.

## Known gap

Setting a member's `codeIntelProvider` currently requires writing the field directly in
the agent record -- it is not yet exposed as a parameter on the member
registration/update tool schemas, so there's no end-to-end "register a member with a
specific code-intel provider" path through the public API surface yet. End-to-end
verification of per-member routing (registration through to tool dispatch) is tracked as
follow-up backlog work.
