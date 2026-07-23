# Code Intelligence Providers

## What this is

Fleet members can query a codebase through a small set of MCP tools --
`code_graph`, `code_impact`, `code_query`, `code_context`, `code_map`,
`code_flow`, `code_tests` -- without knowing which underlying tool actually
answers the question. The `CodeIntelligenceProvider` interface abstracts
away the specific engine (a symbol-graph tool, a semantic-memory tool, or
none at all) behind those seven methods, so the MCP tool surface stays
stable even as the backing implementation changes per repo or per member.

## Why per-member selection, not just a global setting

A single global code-intelligence provider is too coarse for a fleet: some
members work in repos where indexing is undesirable (privacy, cost, repo
size), others benefit from it heavily. Rather than force one choice for the
whole fleet, each `Agent` carries an optional `codeIntelProvider` field
(`'codebase-memory' | 'gitnexus' | 'none'`). Leaving it unset preserves prior
behavior: the member falls back to the fleet's global `config.json`
selection, so existing installs don't need to change anything.

## Resolution order

`getProvider(memberId?)` resolves in this order:

1. If a `memberId` is given and that agent has `codeIntelProvider` set to a
   value with a registered implementation, use it.
2. Otherwise (no memberId, no per-member preference, or the preference names
   a provider that isn't registered), fall back to the global provider
   selection read from the on-disk `config.json`.
3. If neither resolves to a registered provider, the call throws rather than
   silently guessing -- callers are expected to run the install flow to set
   up a provider.

This means a member can only opt in or opt out relative to the fleet
default; there is no way to force a provider that isn't installed.

## Opting out entirely: NullProvider

Setting a member's `codeIntelProvider` to `'none'` resolves to a
`NullProvider`. Every method on `NullProvider` returns a structured
"disabled for this member" result instead of throwing or returning an
error. This distinction matters: a member that has opted out should see a
clear, calm signal that the capability is turned off, not a tool-call
failure that looks like something broke. Callers (including automated
agents) can treat "disabled" and "error" differently.

## Threading member context without touching tool schemas

Code-intel MCP tools are registered once, globally, on the server -- they
are not re-registered per member. To resolve the right provider per call
without adding a `memberId` parameter to every tool's public schema (which
would leak fleet-internal plumbing into the LLM-facing contract), the
dispatch path sets a module-level "active member" marker immediately before
invoking a member's turn, and clears it in a `finally` block afterward. The
code-intel tool wrapper reads that marker at call time and forwards it to
the handler.

Consequences of this design worth knowing:

- Direct MCP tool calls made with no active member (e.g. manual testing,
  tools invoked outside a member dispatch) fall back to the global provider,
  which preserves backward compatibility.
- The marker is a single shared module-level value, not a per-request
  context. Two members dispatched concurrently can clobber each other's
  active-member marker, causing a code-intel call to resolve the wrong
  member's provider. This is a known limitation to fix by moving to a
  request-scoped context mechanism (e.g. `AsyncLocalStorage`) rather than a
  shared mutable variable -- fleets that never run concurrent member
  dispatches are unaffected today.

## Extending with a new provider

Adding a new engine means implementing the seven `CodeIntelligenceProvider`
methods and registering the implementation under a new key in the provider
map, then allowing that key as a value for `codeIntelProvider`. No changes
to the MCP tool schemas or the dispatch wiring are needed -- the abstraction
boundary is exactly the seven-method interface.
