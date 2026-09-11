# memory-contract/v1 -- Contract definitions for memory and code-intelligence tools

## Overview

This directory contains the canonical v1 contract definitions for the memory-bank (kb_*) and code-intelligence (code_*) tool surface. The structure has six items:

1. **INVENTORY.md** - Authoritative inventory of the tool surface (tool count, request/response shapes, provider methods)
2. **schemas/** - GENERATED JSON Schema documents, derived from the Zod source of truth in `src/tools/*.ts`
3. **bindings/mcp/** - Generated MCP tool-definition bindings (owning task: T1.2.3)
4. **bindings/openapi/** - Generated OpenAPI binding (`openapi.yaml`, JSON text with a `.yaml` extension): the RFC 9457 Problem Details projection of `taxonomy.json`'s closed error-code set, emitted by `contract:generate` (landed under T1.3.3, commit d27eb0eb)
5. **fixtures/** - Recorded round-trip request/response corpus for schema validation, one directory per tool with named scenario files (happy path, refusals, edge cases) (landed under T1.4.1, commit f230c530). **NOT byte-reproducible across recordings** (my-beads-db-27m.50): entry ids are fresh UUIDs, `created_at` timestamps are wall-clock, and result order can differ between two recordings of the same scenario (e.g. `kb_list/happy.json` flipped its two entries' order between commits f230c530 and 8d6a5e00, same two entries, same total). Re-running `record-fixtures.mjs` therefore always produces a diff even when nothing about the tools' behaviour changed -- this is expected, not drift, and `contract:check`-style byte comparison is never applied here. Any consumer that needs to compare two recordings of the same fixture semantically should normalise those fields first (`normalizeVolatileFixtureFields` in `tests/roundtrip-harness.mjs`); `T1.4.2`'s round-trip validator itself never byte-compares recorded fixtures against anything -- it validates each one against its JSON Schema (order/id-agnostic by construction) and, for its one true string-equality check (a refusal's error message), already normalises via its own `normalizeMessage`.
6. **tests/** - Generator, validation, and drift test suite

## Source of Truth

**Zod is the source of truth.** All schema definitions originate from Zod schemas in `src/tools/*.ts`, and `generate-contract.mjs` imports them from `dist/tools/` to emit the JSON Schema documents committed under `schemas/`. Generated artifacts (JSON Schema, OpenAPI, type bindings) are derived from and committed as versioned snapshots. Generated schemas are COMMITTED ARTIFACTS and versioned together with their source Zod definitions.

When a source schema changes:
1. Regenerate all bindings and schemas via `contract:generate`
2. Commit the regenerated artifacts in the same commit as the Zod schema change
3. A generated file under `schemas/` or `bindings/` that differs from its last committed state is a contract violation (this is what `npm run contract:check` enforces)

**This rule is scoped to `schemas/` and `bindings/` only -- it does NOT extend to `fixtures/`.** See the `fixtures/` note under "Structure" (item 5) below: the recorded corpus is not byte-reproducible, so no regenerate-and-diff drift guard is, or should ever be, pointed at it.

## Version Bump Policy

The v1 contract evolves according to these rules:

- **Additive extensions** (new tools, new optional request fields, new response keys, new provider methods) = **MINOR version bump** (e.g., v1.0 -> v1.1)
- **Breaking changes** (tool removal, required field removal, response key removal, provider method signature change) = **MAJOR version bump with a changelog entry** (e.g., v1.x -> v2.0, documented in CHANGELOG.md)

Rationale: additive changes are backward compatible and allow consumers to upgrade in place. Breaking changes require explicit changelog entries so all stakeholders see the migration cost upfront.

## $id URI Base Decision

The `$id` URI used to anchor JSON Schema definitions is a deliberate, explicit repo-rooted decision:

```
$id: https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas/<SCHEMA_NAME>.json#
```

For example, the kb_capture request schema uses:
```
$id: https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas/kb_capture.request.json#
```

The `$id` base is NOT left to generator defaults (which would typically be a tool name or an auto-generated relative path). By pinning it to the repo's canonical main-branch URL, we ensure:

1. Schema consumers can resolve the definition from GitHub directly
2. Schema versioning is tied to repo commits (anchored via `blob/main`)
3. Schema identity is stable across deployments and tool changes
4. The contract is self-documenting: a consumer seeing `$id=...` knows exactly where to find the source

This decision is recorded here so any future schema-generation tooling inherits the constraint.
