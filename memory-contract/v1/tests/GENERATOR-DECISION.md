# memory-contract/v1 -- zod -> JSON Schema generator decision

Status: DECIDED. Sole writer of this file is T1.2.1 (the generator bake-off).
The binding naming/ref scheme is NOT here -- it lives in `BINDING-SCHEME.md`
(T1.2.3) in this same directory.

Tree probed: branch `u1_contract_v1_skeleton`. Reproduce every claim below with:

```
npm run build && node memory-contract/v1/tests/probe-generator-2020-12.mjs
```

Exit 0 = all claims still hold. The probe reads the REAL 23 request schemas from
`dist/tools/*.js` (the surface is TypeScript, so a build is required first) and
checks each emitted document against the draft-2020-12 **metaschema** using
`Ajv2020` -- not against eyeballing.

## 1. Decision

**Chosen: `zod-to-json-schema@3.25.1` with `{ target: 'jsonSchema7',
definitionPath: '$defs' }`, followed by the deterministic post-processing module
`postprocess-2020-12.mjs` in this directory.**

This is the documented FALLBACK path ("take the closest output and add a
deterministic post-processing step owned in memory-contract/v1/tests/"). It is
taken because neither candidate emits clean 2020-12 on its own:

| Candidate | Verdict | Evidence |
|---|---|---|
| zod-native `z.toJSONSchema` (`zod/v4`, zod 3.25.76) | **Unusable today** | Throws on every schema in the surface: `TypeError: Cannot read properties of undefined (reading 'def')` on the real `kbCaptureSchema`. Every schema in `src/tools/` is authored against the zod **v3** API (`import { z } from 'zod'`), and the v4 emitter only walks v4 internals. Making it usable means migrating all 23 schemas in `src/`, which is outside this task's write scope. |
| `zod-to-json-schema@3.25.1`, `target: 'jsonSchema2020-12'` | **Rejected** | Its 2020-12 mode is a net REGRESSION versus its own draft-07 mode -- see 1.1. |
| `zod-to-json-schema@3.25.1`, `target: 'jsonSchema7'` + postprocess | **Chosen** | Closest raw output; all 23 tools are metaschema-valid 2020-12 after a purely mechanical normalisation. |

### 1.1 Why the library's own `jsonSchema2020-12` target is not used

Diffing the two targets over the same schema, the 2020-12 target differs from
the draft-07 target in exactly two ways, and both are wrong for us:

1. It emits **no `$schema` at all**, so the document declares no dialect. The
   criterion is 2020-12 *exactly* (the OpenAPI 3.1 binding depends on it), and
   an undeclared dialect fails that by omission.
2. It rewrites exclusive numeric bounds into the **draft-04 boolean form**:
   `z.number().int().positive()` becomes `{type:'integer', exclusiveMinimum:
   true, minimum: 0}`, where draft-07 correctly gives `{type:'integer',
   exclusiveMinimum: 0}`. In 2020-12 `exclusiveMinimum` MUST be a number; the
   metaschema rejects the boolean form outright
   (`/properties/top/exclusiveMinimum must be number`).

It also does NOT do the things a 2020-12 target would be expected to do: it
keeps the draft-07 array-form `items` for tuples (2020-12 requires
`prefixItems`) and it does not move `definitions` to `$defs` (that is the
separate `definitionPath` option).

This is not hypothetical: **`code_map.top`** in `src/tools/code-intelligence.ts`
is `z.number().int().positive()`, so one field of the real inventoried surface
already triggers the boolean-bound bug.

### 1.2 zod-native, for the record (the v2 migration case)

Run against v4 **re-declarations** of the same four hard constructs, the native
emitter is correct on all of them: it declares
`https://json-schema.org/draft/2020-12/schema`, uses `$defs`, and emits numeric
exclusive bounds. Its disqualification is purely that the surface is v3-authored.
If the surface is ever migrated to the zod v4 API, revisit this decision: native
would remove the need for `postprocess-2020-12.mjs` entirely.

## 2. Conformance evidence, per hard construct

All rows are on the chosen path (`jsonSchema7` emit + postprocess) and
"metaschema-valid" means `Ajv2020.validateSchema` returned true.

| Hard construct | Probed as | Emitted 2020-12 | Valid |
|---|---|---|---|
| Discriminated union | 4-branch AUDN capture outcome (`add`/`update`/`flagged`/`none`), shaped from the `kb_capture` response in `INVENTORY.md` 2.1 | `anyOf` of 4 object schemas, each pinning its discriminant with `const` (`add`, `update`, `flagged`, `none`) | yes |
| Closed enums | `confidence`, `scope`, `direction`, capture `type` | `{"type":"string","enum":[...]}` -- closed lists of 3 / 2 / 2 / 5 respectively, e.g. `["CONFIRMED","INFERRED","UNVERIFIED"]` | yes |
| Optional vs nullable | `z.string().optional()` vs `.nullable()` vs `.nullish()` | optional -> omitted from `required`; nullable -> present in `required` with `type:["string","null"]`; nullish -> both. All three stay distinguishable. | yes |
| Recursive / entry-reference | `Entry = z.lazy(() => z.object({id, refines: Entry.optional()}))` | `$defs` anchor plus a self `$ref` of `#/$defs/v1-kb-entry` | yes |
| Whole surface | all 23 real request schemas (16 `kb_*` + 7 `code_*`, matching the `INVENTORY.md` count) | one document per tool | yes, all 23 |
| Tuple (`prefixItems`) | `z.tuple([string, number])` -- absent from today's surface, probed because the postprocess carries a fix for it | raw emit is REJECTED by the metaschema (array-form `items`); postprocess converts it to `prefixItems` + `items: false`, which validates | yes, after postprocess |

**Enums are closed, proven.** Every `z.enum` in the surface emits a bounded
`enum` array, never a bare `{"type":"string"}`. The one field that emits an open
string is `kb_capture.role`, and that is **deliberate, not a defect**: the closed
`Author` list lives in `AUTHOR_VALUES` in `src/tools/kb-capture.ts` and is
enforced in the handler, because an invalid role hint must degrade to `'unknown'`
rather than reject the whole capture call. Do not "fix" it in the schema; it is
recorded as INV-07 below. The probe asserts both halves (role stays open, and
`type`/`confidence`/`scope` stay closed), so a silent change either way fails.

## 3. Degradations

| # | Construct | What is lost | Where the rule now lives |
|---|---|---|---|
| D1 | Discriminated union | The `discriminator` hint. `anyOf` is valid 2020-12 but an OpenAPI 3.1 `discriminator` requires `oneOf`, so the mapping from discriminant value to branch is not machine-readable in the emitted schema. | `x-invariant: INV-09`; the binding-side handling of this is T1.2.3's call in `BINDING-SCHEME.md`. |
| D2 | Dialect declaration | The draft-07 base emit declares draft-07. | Fixed mechanically by `postprocessTo2020_12` (fix 1). Not an open degradation. |
| D3 | Tuple encoding | draft-07 array-form `items`. | Fixed mechanically (fix 4). No tuple exists in the surface today. |
| D4 | `definitions` vs `$defs` | draft-07 keyword name. | Set via `definitionPath: '$defs'`; the postprocess also renames defensively (fix 2). |
| D5 | Cross-field / conditional rules | Everything in section 4. **Note: there is no `.refine`, `.superRefine` or `.transform` anywhere in the 23 request schemas** -- so nothing is lost at the zod level. These rules were never in zod to begin with; they live only in handler code and prose, which is exactly why they must be annotated rather than assumed. | `x-invariant` annotations, section 4. |
| D6 | Response shapes | Nothing to degrade: no tool in this surface declares a response zod schema (`INVENTORY.md` section 3), so there is no response type to generate from. The AUDN-outcome union in section 2 is a probe of the SHAPE the responses have, not of a declared schema. | `x-invariant: INV-08`; declaring response schemas is downstream work, not this task's. |

## 4. x-invariant list (input to T7, complete as-is)

Rules JSON Schema cannot express for this surface. Each is to be annotated on
the emitted schema as `x-invariant` and points at a `spec.md` **section name** as
a forward reference. `spec.md` does not exist yet -- T1.3.1 creates it and
T1.3.1/T1.3.2 are its only writers. Nothing here creates, stubs or edits it.

**Who applies the annotation:** not this task and not
`postprocess-2020-12.mjs`. The postprocess module applies exactly the four
dialect fixes listed in section 5 and writes no `x-invariant` key. This table IS
the deliverable -- the authoritative id -> invariant -> spec.md-section mapping,
complete enough to hand to T7 as-is. Stamping each `x-invariant` onto the
emitted document belongs to T1.2.2's `contract:generate` wiring, which is the
only code that knows which tool a given document came from; the mapping it must
apply is the `Id` / `Applies to` columns below.

| Id | Applies to | Invariant | Source anchor | spec.md section |
|---|---|---|---|---|
| INV-01 | `kb_capture` | `source_file` is only meaningful when `type = 'context-cache'`; a content hash is computed only for that pair, and `type='context-cache'` without `source_file` silently stores no hash. | `src/tools/kb-capture.ts` (`if (input.type === 'context-cache' && input.source_file)`) | Freshness and content hashing |
| INV-02 | `kb_capture` | Confidence is CLAMPED: an incoming `CONFIRMED` is downgraded to `INFERRED`, `confidence_clamped` is returned true and a bracketed note is appended to content. `CONFIRMED` is minted only by `kb_promote`. The schema still accepts `CONFIRMED` as an input value. | `src/tools/kb-capture.ts` (clamp block), `src/tools/kb-promote.ts` | Capture provenance and confidence clamp |
| INV-03 | `kb_capture` | `type='user-directive'` forces `scope='project'` regardless of the requested scope, and the entry is stored as a PENDING PROPOSAL (UNVERIFIED + flagged + `directive:pending`) at the `SqliteProvider.capture()` choke point. No MCP-reachable route can mint an active directive. | `src/tools/kb-capture.ts`, `src/services/knowledge/sqlite-provider.ts` | Directive quarantine |
| INV-04 | `kb_capture` | `supersedes` retires the named entry ONLY if AUDN independently matches it as a same-topic candidate (same type, overlapping symbols and source_files); otherwise it is ignored. It cannot retire an arbitrary id. | `src/tools/kb-capture.ts` field description, AUDN service | Superseding and AUDN matching |
| INV-05 | `kb_import`, `kb_stats` | `repo` and `repo_path` are an ALIAS PAIR and `repo` wins (`input.repo ?? input.repo_path`). Both names must survive into the generated binding: zod strips an unknown key silently, so a binding that keeps only one name fails by reporting an empty/zeroed KB rather than erroring. | `src/tools/kb-stats.ts`, `src/tools/kb-import.ts` | Scope resolution and repo aliasing |
| INV-06 | `kb_setup` | Its `repo_path` carries NO scope semantics -- it only locates a `.git` directory for hook installation, and the tool writes one global config. It is the only one of the 16 `kb_*` schemas that does not spread `kbScopeFields`. A generated binding must not infer project-KB resolution from the presence of the field. | `src/tools/kb-setup.ts`, `src/services/knowledge/kb-scope-input.ts`, `INVENTORY.md` 2.1 scope note | Scope resolution and repo aliasing |
| INV-07 | `kb_capture` | `role` is intentionally an OPEN string in the schema. The closed `Author` enum (`doer`, `reviewer`, `planner`, `plan-reviewer`, `kb-agent`, `kb-reconciler`, `harvest`, `pm`, `user`) is enforced server-side; anything outside it -- including an absent hint -- stamps the literal `unknown`. `source` is derived from the validated role/type and is never accepted from the caller. | `AUTHOR_VALUES` / `validateAuthor` in `src/tools/kb-capture.ts` | Capture provenance and confidence clamp |
| INV-08 | `kb_query` | Two mutually exclusive response shapes keyed by the request: `flagged_only: true` returns `{flagged_entries, total, note}`, otherwise `{l1_results, l2_expanded, related_claims?}`. Additionally at least one of `query`, `tag` or `flagged_only` MUST be supplied; the handler throws when all three are absent. | `src/tools/kb-query.ts` (guard throw and the `flagged_only` branch) | Query modes |
| INV-09 | all response shapes | No tool declares a response zod schema, so no generated response schema is authoritative; the shapes in `INVENTORY.md` section 2 are OBSERVED, and an AUDN-style outcome union loses its `discriminator` mapping when emitted as `anyOf`. | `INVENTORY.md` section 3, `src/services/tool-registry.ts` | Query modes |

**Sections T1.3.1 must therefore create in `spec.md`** (this is a hand-off list,
not a set of loose pointers -- every `x-invariant` above resolves into one of
these six, and no invariant points anywhere else):

1. Scope resolution and repo aliasing (INV-05, INV-06)
2. Capture provenance and confidence clamp (INV-02, INV-07)
3. Directive quarantine (INV-03)
4. Superseding and AUDN matching (INV-04)
5. Freshness and content hashing (INV-01)
6. Query modes (INV-08, INV-09)

## 5. The fallback post-processing step, and how T1.2.2 wires it

Committed as `memory-contract/v1/tests/postprocess-2020-12.mjs` -- a plain
module, deliberately NOT a `*.test.ts`, because `vitest.config.ts` only includes
`tests/**/*.test.ts` and `packages/*/tests/**/*.test.ts`, so a test file placed
here would silently never run.

API for the `contract:generate` wiring (T1.2.2 wires the call; that task must not
edit this file or `GENERATOR-DECISION.md`):

```js
import { postprocessTo2020_12, DIALECT_2020_12 } from './postprocess-2020-12.mjs';

const doc = postprocessTo2020_12(zodToJsonSchema(schema, {
  target: 'jsonSchema7',      // NOT 'jsonSchema2020-12' -- see 1.1
  definitionPath: '$defs',
  name: `v1-${toolName}`,     // optional
}));
```

- `postprocessTo2020_12(schema: unknown) -> unknown` -- takes the raw generator
  output object, returns a normalised deep copy. A non-object input is returned
  unchanged.
- `DIALECT_2020_12` -- the exact dialect string written to `$schema`.

Fixes applied, in this fixed order:

1. Root `$schema` set to `https://json-schema.org/draft/2020-12/schema`
   (replacing draft-07 or injecting when absent).
2. `definitions` -> `$defs`, and any `#/definitions/...` `$ref` repointed to
   `#/$defs/...`.
3. Boolean exclusive bounds -> numeric:
   `{minimum: N, exclusiveMinimum: true}` -> `{exclusiveMinimum: N}` (same for
   the maximum pair). An already-numeric bound is untouched.
4. Array-form `items` (tuple) -> `prefixItems`, with a redundant `maxItems`
   equal to the tuple length replaced by `items: false`.

**Determinism** (asserted by section 5 of the probe): pure function, no `Date` /
`Math.random` / env / IO; input is never mutated; idempotent
(`f(f(x)) === f(x)`); byte-identical across runs for the same input; key order
follows the input, with `$schema` written first at the root. This is what lets
the drift guard treat any diff as a real contract change rather than generator
noise.

## 6. Open item T1.2.2 must handle (not fixable from this task's write scope)

`zod-to-json-schema@3.25.1` resolves today as a **transitive** dependency (pulled
in via the MCP SDK; see `package-lock.json`), not a declared one. Before
`contract:generate` depends on it, it must be promoted to a direct entry in
`package.json` `dependencies` -- otherwise generation breaks the moment the SDK
drops or bumps it. This task's acceptance criteria forbid writing any file
outside `memory-contract/v1/tests/`, so the promotion is deliberately NOT done
here and is recorded as T1.2.2's precondition instead. The same applies to `ajv`
(used by the probe for metaschema validation), which is also transitive today.
