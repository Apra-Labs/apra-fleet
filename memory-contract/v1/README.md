# memory-contract/v1 -- Contract definitions for memory and code-intelligence tools

## Overview

This directory contains the canonical v1 contract definitions for the memory-bank (kb_*) and code-intelligence (code_*) tool surface. The structure follows a four-layer model:

1. **INVENTORY.md** - Authoritative inventory of the tool surface (tool count, request/response shapes, provider methods)
2. **schemas/** - Zod schema definitions (source of truth)
3. **bindings/mcp/** - MCP binding stubs generated from schemas
4. **bindings/openapi/** - OpenAPI binding stubs generated from schemas
5. **fixtures/** - Round-trip test corpus for schema validation
6. **tests/** - Generator, validation, and drift test suite

## Source of Truth

**Zod is the source of truth.** All schema definitions originate from Zod schemas in `schemas/`. Generated artifacts (JSON Schema, OpenAPI, type bindings) are derived from and committed as versioned snapshots. Generated schemas are COMMITTED ARTIFACTS and versioned together with their source Zod definitions.

When a source schema changes:
1. Regenerate all bindings and schemas via `contract:generate`
2. Commit the regenerated artifacts in the same commit as the Zod schema change
3. A generated file that differs from its last committed state is a contract violation

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
