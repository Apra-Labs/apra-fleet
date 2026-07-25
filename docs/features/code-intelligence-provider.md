<!-- llm-context: Describes the per-member code-intelligence provider abstraction -- the Agent field, the getProvider() resolution rules, and the NullProvider/DefaultProvider fallback behavior. Read when working on code-intel tool dispatch, member registration, or adding a new code-intelligence backend. -->
<!-- keywords: codeIntelProvider, CodeIntelProvider, getProvider, NullProvider, DefaultProvider, PROVIDERS, code intelligence, gitnexus, codebase-memory -->
<!-- see-also: ../architecture.md (LLM provider abstraction, the parallel pattern this follows), ../../src/types.ts (Agent interface), ../../src/tools/code-intelligence.ts -->

# Code-Intelligence Provider Abstraction

## Overview

Each registered member (Agent) can specify which code-intelligence backend it wants to
use for symbol lookups, call-graph tracing, and impact analysis, instead of being locked
to a single fleet-wide choice. A member can also opt out of code intelligence entirely.

This mirrors the existing per-member LLM provider abstraction (see "Provider Abstraction"
in `docs/architecture.md`): a generic interface, a resolver function, and a registry
keyed by provider name.

## Data Model

`Agent.codeIntelProvider?: 'codebase-memory' | 'gitnexus' | 'none'`

- Optional and backward compatible -- omitted for existing members, who keep prior
  (fleet-wide) behavior.
- Accepted by both member registration and member update; the schema on both is kept
  identical so a member's code-intel choice can be set at creation or changed later.
- `'none'` explicitly disables code intelligence for that member.

## Resolution Rules (`getProvider`)

`getProvider(memberId?: string): CodeIntelProvider` resolves the provider to use for a
given call site:

1. No `memberId` supplied -> the global default provider (preserves the pre-abstraction
   behavior for any caller that hasn't been updated to pass member context yet).
2. `memberId` supplied but the agent is not found, or the agent has no
   `codeIntelProvider` set -> falls back to the global default provider.
3. `memberId` supplied and `codeIntelProvider` is a recognized name in the provider
   registry -> that provider instance.
4. `memberId` supplied with an unrecognized provider name -> falls back to the global
   default provider (fail open to "not configured", never throw).

The resolver never throws and never returns `undefined` -- every call site gets a usable
`CodeIntelProvider` instance.

## Provider Contract

Every backend implements `CodeIntelProvider`: `query`, `getReferences`, `getDefinition`,
`getCallGraph`, `getImpact`. Every method returns a `CodeIntelResult`
(`{ success, data?, error? }`) rather than throwing, so callers can treat "disabled" and
"not configured" as ordinary data rather than exceptional control flow.

Two built-in providers exist purely as safe fallbacks, not as functioning backends:

- **`DefaultProvider`** (`name: 'default'`) -- returned when no member-specific choice
  applies. Every method reports "no code intelligence provider configured."
- **`NullProvider`** (`name: 'none'`) -- returned when a member explicitly opts out.
  Every method reports "code intelligence disabled for this member," distinguishing an
  intentional opt-out from an unconfigured fleet.

## Current Limitation: registry has fallback providers only

The `codeIntelProvider` schema accepts `'codebase-memory'` and `'gitnexus'` as forward-looking
values, but the provider registry that `getProvider()` looks up by name currently only
contains `'none'` and `'default'`. Setting a member's `codeIntelProvider` to
`'codebase-memory'` or `'gitnexus'` today is accepted by validation but silently resolves
to the default (not-configured) provider at call time, because rule 4 above treats any
unrecognized name as a safe fallback rather than an error.

This is intentional groundwork, not a bug: the field, the resolver, and the registry
pattern are in place so that wiring in the real `codebase-memory` and `gitnexus` backends
-- and threading member context through the `execute_prompt` dispatch path so tool calls
actually pass a `memberId` -- can be done as a registry addition plus dispatch-path change,
without touching the resolution contract or any existing caller.

## Extending with a New Backend

To add a real backend: implement `CodeIntelProvider`, register an instance under its name
in the `PROVIDERS` map, and ensure the value matches one of the accepted
`codeIntelProvider` enum values in the registration/update schemas. No changes to
`getProvider()`'s resolution logic are needed.
