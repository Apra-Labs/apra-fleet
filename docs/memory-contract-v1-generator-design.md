# Memory Contract v1: Schema Generation Design

This note captures the design of the `contract:generate` pipeline that emits
`memory-contract/v1/schemas/*.json` from the real `kb_*`/`code_*` tool
surface, and records what that pipeline does and does not prove. See
`memory-contract/v1/README.md` for the four-layer model and `docs/memory-contract-v1-inventory-notes.md`
for inventory-level findings (tool count, provider divergences, scope
aliasing). This file is generator/schema-level, not inventory-level.

## Generation path: zod-to-json-schema + a deterministic postprocess, not a native emitter

The contract's request schemas are zod objects authored against the zod v3
API. Two more direct paths were considered and rejected before landing on the
one described below:

- A native zod-to-JSON-Schema emitter that targets 2020-12 directly is not
  usable against this surface: it only understands zod v4 internals, and the
  surface's schemas are v3-authored. Migrating all tool schemas to v4 to use
  it is out of scope for a schema-generation task and would be a much larger,
  separate change.
- The `zod-to-json-schema` package's own "2020-12 target" mode is
  a net regression versus its plain draft-07 mode for this surface: it omits
  `$schema` entirely (an undeclared dialect, which fails a "declare 2020-12
  exactly" requirement by omission) and it emits exclusive numeric bounds in
  the old boolean form (`exclusiveMinimum: true` alongside `minimum`), which
  the 2020-12 metaschema rejects outright (2020-12 requires the bound itself
  to carry the number).

The chosen path is therefore: emit with `zod-to-json-schema`'s plain (draft-07-like)
target and `$defs` as the definitions path, then run every document through a
small, pure, deterministic postprocessing module that mechanically fixes up
exactly four things:

1. Set the root `$schema` to the 2020-12 dialect URI (replacing or injecting
   it).
2. Rename the `definitions` container to `$defs`, and repoint any `$ref` that
   pointed into `definitions`.
3. Convert draft-04-style boolean exclusive bounds (`{minimum: N,
   exclusiveMinimum: true}`) to the 2020-12 numeric form (`{exclusiveMinimum:
   N}`).
4. Convert draft-07 array-form tuple `items` to 2020-12 `prefixItems` (plus
   `items: false` to close the tuple), for any tuple that appears in the
   surface in the future -- none exists in the surface as of this writing.

This postprocess is a plain pure function: no `Date`/`Math.random`/env/IO,
input never mutated, idempotent (running it twice on its own output is a
no-op), and byte-identical across repeated runs on the same input. That
purity is what lets a drift guard treat any future diff in a committed schema
file as a real contract change rather than generator noise -- if the
generator or postprocess itself were nondeterministic, "the committed schema
differs from freshly generated output" would stop being a meaningful signal.

If the tool surface is ever migrated to the zod v4 API, the native emitter
becomes usable and the postprocess module could be retired entirely -- that
tradeoff should be re-evaluated at that point, not assumed to still hold.

## Container-aware, not string-replace, `$ref` rewriting

Renaming `definitions` to `$defs` cannot be done as a blind string
replacement inside `$ref` pointers, because a JSON Pointer segment named
"definitions" can mean two different things depending on where it appears:
a schema *container keyword* (`#/definitions/Foo`, which must become
`#/$defs/Foo`) versus an ordinary *data key* one level under `properties`
that happens to be named "definitions" (`#/properties/definitions/...`,
which must NOT be rewritten -- it's someone's field name, not a schema
container).

The fix walks each `$ref`'s pointer segment-by-segment with a small state
machine that tracks whether the next segment is "a container keyword" or "an
opaque name belonging to the container just entered" (a property name, a
regex pattern, or a `$defs`/`definitions` entry name). Only segments in the
"expecting a container keyword" state get rewritten; a segment immediately
following one of the container keywords (`properties`, `patternProperties`,
`$defs`, `definitions`) is always passed through untouched, because it is
data, not schema structure, regardless of what string it contains. This
generalizes safely to nested cases (e.g. a property that is itself named
`properties`).

## Every emitted document is validated before it is written

The generator validates each emitted request/response document against the
2020-12 metaschema before writing it to disk, and fails the whole run
(nonzero exit, nothing written for that document) rather than commit an
invalid schema. This means "a file exists under `memory-contract/v1/schemas/`"
already implies "it is a syntactically valid 2020-12 schema" -- that
guarantee does not, however, extend to whether the schema is *semantically
correct* against what the tool actually returns (see the known gap below).

## Idempotency is a checked property, not an assumption

Because both the request source (the real zod schemas, compiled) and the
response source (a hand-authored companion module, since no tool declares a
response zod schema anywhere in the surface) are static with no
nondeterministic inputs, running the generator twice in a row produces a
byte-identical `schemas/` directory. This is the mechanism a CI drift guard
would rely on: regenerate, diff against the committed tree, fail the build on
any difference. As of this writing that guard does not exist in CI -- the
generator proves it *would* produce a stable signal if wired up, but nothing
currently enforces that the committed schemas stay in sync with the source
zod schemas on every change.

## Annotating rules JSON Schema cannot express (`x-invariant`)

Some real behavioral rules in the handlers cannot be expressed as JSON Schema
constraints at all -- cross-field conditionals, confidence clamping,
alias-pair resolution, discriminated-union shapes losing their discriminator
mapping when emitted as `anyOf` instead of `oneOf`, and so on. None of the
tool schemas in this surface use zod's `.refine`/`.superRefine`/`.transform`,
so none of these rules were ever expressible at the zod level to begin with
-- they only exist in handler code and prose. Rather than silently losing
them, each is recorded as a stable `x-invariant` id stamped onto the affected
schema document(s), with a documented source anchor (which file/function
encodes the real behavior) and a forward reference to the prose section that
is expected to spell it out in full. The mapping of invariant id to affected
tool is intentionally centralized in the generator step (the only code that
already knows which tool a given document belongs to), not scattered across
the modules that determined *which* invariants exist.

## Known gap: published response schemas do not match the real MCP response envelope

The response schemas emitted by this pipeline model every tool's response as
a single fixed-shape text envelope (exactly one `content` array entry of
type `text`). The real MCP response wrapper used by every registered tool
can emit up to three content blocks in one response (an onboarding preamble,
the actual result, and an onboarding nudge), each block optionally carrying
`annotations`, plus an optional top-level `structuredContent` field for tools
that return machine-readable data alongside the display text. A schema that
pins the content array to exactly one entry, omits `annotations` entirely,
and forbids additional root properties will reject a real response that
happens to include a display preamble or nudge -- which is a normal,
expected occurrence, not an edge case.

This means the schemas as currently authored describe an *idealized*
response shape rather than the shape the transport can actually produce.
Closing this gap requires a real round-trip validator that exercises live
responses against the published schemas end-to-end; until such a validator
exists and is run in anger, the response schemas should be treated as
declarative-but-unverified against reality, not as a proven, load-bearing
contract.

## What "the skeleton exists" does and does not mean

A directory or file existing under `memory-contract/v1/` (e.g. `fixtures/`,
`bindings/mcp/`, `bindings/openapi/` as empty stub directories) is not the
same as that layer being *populated and owned*. The four-layer model this
directory follows treats "present or explicitly stubbed with a named owner"
as the bar for a layer being considered handled at all -- an empty directory
with no owner recorded anywhere is neither. When evaluating whether a
contract-skeleton effort is complete, check for content and a named owner
per layer, not just directory presence.
