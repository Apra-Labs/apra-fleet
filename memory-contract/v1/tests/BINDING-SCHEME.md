# memory-contract/v1 -- MCP binding naming and ref scheme

Status: DECIDED. Sole writer of this file is T1.2.3 (this task). This file is
HAND-AUTHORED, not generated -- `contract:generate` (`memory-contract/v1/
generate-contract.mjs`) never opens this path in either its normal write mode
or its `--check` mode, so running it leaves this file byte-unchanged. That is
deliberate: everything `contract:generate` DOES emit falls under the T1.5.1
regenerate-and-diff guard, and a hand-edited file living inside generated
output would be the same two-producer hazard that moved `openapi.yaml` to a
single generated producer.

This file is NOT `memory-contract/v1/tests/GENERATOR-DECISION.md` (T1.2.1,
sole writer, covers the zod -> JSON Schema 2020-12 generator decision for
`schemas/`) and is not `README.md` (T1.1.1, sole writer). Do not add binding
content to either of those.

## 1. Where bindings live

One file per inventoried tool, under:

```
memory-contract/v1/bindings/mcp/<tool>.json
```

`<tool>` is the exact tool name from `INVENTORY.md` section 1/2 (e.g.
`kb_capture`, `code_graph`) -- 23 files today (16 `kb_*` + 7 `code_*`), one per
tool, no more and no fewer. `INVENTORY.md` remains the arbiter of the count;
this scheme does not re-derive it.

`bindings/openapi/` (the sibling directory named in `README.md`'s four-layer
model) was out of this task's original scope. It has since landed under
T1.3.3: `contract:generate` now also emits
`bindings/openapi/openapi.yaml` (JSON text with a `.yaml` extension), the RFC
9457 Problem Details projection of `taxonomy.json`'s closed error-code set. It
declares zero paths (no route surface) and is a separate generated artifact
from the per-tool `bindings/mcp/<tool>.json` documents this section describes;
see `generate-contract.mjs`'s `openapi.yaml` builder for its shape.

## 2. Binding document shape

```json
{
  "$id": "https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/bindings/mcp/<tool>.json#",
  "name": "<tool>",
  "description": "<registration description, byte-exact from src/services/tool-registry.ts, reproduced in INVENTORY.md Appendix A>",
  "request": { "$ref": "https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas/<tool>.request.json#" },
  "response": { "$ref": "https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas/<tool>.response.json#" },
  "errors": [
    { "$ref": "https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/taxonomy.json#/groups/<group>/codes/<index>" }
  ]
}
```

Key order is fixed (`$id`, `name`, `description`, `request`, `response`,
`errors`) and `JSON.stringify(doc, null, 2)` with a trailing newline is the
exact serialization -- this is what keeps two consecutive `contract:generate`
runs byte-identical (the idempotency criterion this task's acceptance depends
on).

### 2.5 The `errors` key (T1.3.3 addition)

`errors` is a fixed-order array of bare `{ "$ref" }` pointers (same
no-inlined-body convention as `request`/`response`) at `taxonomy.json` entries
for every PROJECTABLE code this tool's `raising_methods` name it under. A tool
that raises no projectable code still gets the key, as an empty array, so
every binding document shares the same key set and `--check`'s byte-diff
stays meaningful. Order follows `taxonomy.json`'s own group/array order, never
the `DESCRIPTIONS`/roster order, so re-ordering `KB_MODULES`/`CODE_EXPORTS`
can never change this array's content. See `generate-contract.mjs`'s
`buildBindingDoc`/`taxonomyCodeRef`.

### 2.1 No inlined schema bodies

`request` and `response` are ALWAYS a bare `{ "$ref": "..." }` pointing at the
already-committed `schemas/<tool>.request.json` / `schemas/<tool>.response.json`
(T1.2.2's output). A binding definition never inlines a `type`/`properties`
body of its own -- that would create a second place the same shape could drift
from its source of truth.

### 2.2 Ref value = target's own `$id`, not a relative filesystem path

The `$ref` string is the FULL GitHub URL that equals the target schema
document's own `$id` field exactly (byte for byte, including the trailing
`#`). This was chosen over a relative path (e.g. `../../schemas/<tool>.
request.json`) for two reasons:

1. It reuses the SAME `$id` URI base decision `README.md` already made for
   `schemas/` (`https://github.com/.../memory-contract/v1/schemas/...`) rather
   than inventing a second resolution mechanism.
2. A ref that is byte-identical to its target's `$id` is directly checkable:
   `binding.request.$ref === schema.$id` is exactly the "one bindings/mcp
   definition <-> one request/response schema pair" parity clause, so the
   check does not need to parse or resolve a relative path at all.

The bindings themselves get their own `$id` too, under a distinct base:
`https://github.com/.../memory-contract/v1/bindings/mcp/<tool>.json#` -- a
binding is a citable artifact in its own right, not just a wrapper.

### 2.3 Why no `$schema` on the binding document

Unlike `schemas/<tool>.{request,response}.json`, a binding document is
deliberately NOT declared as a JSON Schema instance (no `$schema` key). It
does not validate anything itself -- it is a manifest that points at the two
documents that do. Stamping a 2020-12 dialect on it would claim a validation
role it does not have.

### 2.4 Description provenance

`description` is the tool's registration description string exactly as
passed to `server.tool(name, description, ...)` in
`src/services/tool-registry.ts`, reproduced in `INVENTORY.md` Appendix A
("captured from the runtime registration dump so it is byte-exact"). The
generator hardcodes these strings in a `DESCRIPTIONS` map inside
`generate-contract.mjs` rather than importing `tool-registry.ts` at generation
time -- the same "no runtime dependency on a file owned by another lane"
convention already used there for the `KB_MODULES`/`CODE_EXPORTS` roster. A
future drift between the two is a signal the roster or `INVENTORY.md` needs
re-checking, exactly like that existing convention's own comment says.

## 3. Three-way parity and the `--check` mechanism

Acceptance requires parity in all three directions: registered tool <->
exactly one `bindings/mcp` definition <-> one request/response schema pair.
This is exposed as `node memory-contract/v1/generate-contract.mjs --check`
(`npm run contract:check`):

- Computes every schema document AND every binding document in memory, using
  the exact same code path as a normal `contract:generate` run -- it never
  writes anything in this mode.
- Compares each computed document byte-for-byte against what is already
  committed at its path; a missing file or a byte-differing file is a
  mismatch.
- Additionally scans `schemas/` and `bindings/mcp/` for any file NOT among the
  set generation would produce (an "extra" file, e.g. a stale binding left
  over from a renamed or removed tool) -- a parity violation just as much as a
  missing one ("no extras, no gaps").
- Prints every mismatch found (not just the first) and exits non-zero if
  `MISMATCHES` is non-empty; exits 0 and prints an OK summary line
  (`<N> tools, <N*2> schema files, <N> binding files, all match`) otherwise.

Because the same 23-tool roster (`KB_MODULES` + `CODE_EXPORTS`) drives both
the schema pair count and the binding count in one loop iteration per tool,
"registered tool" and "one binding, one schema pair" can never structurally
diverge from each other in this script's output -- the `--check` scan exists
to catch the THIRD direction: drift between what generation would produce now
and what is actually committed on disk.

`tests/memory-contract-parity.test.ts` (T1.5.1) is expected to shell out to
this `--check` mode (or invoke `main()` directly) rather than reimplement the
comparison; it is not created by this task.

T1.3.3 extended `--check` with a fourth parity direction, taxonomy-to-projection:
every taxonomy.json PROJECTABLE code must appear in at least one
`bindings/mcp/*.json` `errors` array, and every ref cited in an `errors` array
must resolve to a real projectable code in `taxonomy.json` -- a mismatch either
way is reported the same as a byte-diff. `--check` also compares the committed
`bindings/openapi/openapi.yaml` byte-for-byte against what generation would
produce now, on the same "no extras, no gaps" basis as `schemas/` and
`bindings/mcp/`.

## 4. Determinism

Same guarantee as `schemas/` (`GENERATOR-DECISION.md` section 5's
determinism note, extended to bindings): no `Date`/`Math.random`/env read
feeds binding output, the `DESCRIPTIONS` map and the `$id`/`$ref` bases are
static, and object key order is fixed in `buildBindingDoc`. Two consecutive
`npm run contract:generate` runs produce a byte-identical `bindings/mcp/`
directory, and `npm run contract:check` immediately after a generate run
exits 0.
