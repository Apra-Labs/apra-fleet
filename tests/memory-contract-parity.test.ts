// T1.5.1 (my-beads-db-27m.10): cross-document referential-parity guard.
//
// Distinct from tests/memory-contract-drift-guard.test.ts (T1.5.1's other
// file): that test asks "does regenerating produce a byte-identical tree"
// (drift) and "did a hand-authored source document silently shrink"
// (deletion); this test asks "do the generated documents point at each
// other consistently" (referential integrity), independently RE-COMPUTED
// from the committed files on disk rather than by re-invoking
// generate-contract.mjs's own --check codepath -- re-running the same
// function under test would only prove the generator agrees with itself,
// not that its output is actually correct.
//
// Two parity relations, both asserted in BOTH directions per the acceptance
// criteria ("no X without Y, no Y without X"):
//
//   1. registered tool <-> exactly one bindings/mcp/<tool>.json definition
//      <-> its request/response schema pair (the U6 binding-parity check).
//      NOTE: this deliberately does not re-assert "registered tool set ==
//      generator roster set == emitted schema tool set" -- that specific
//      three-way set-equality is tests/memory-contract-roster-guard.test.ts
//      (my-beads-db-27m.39)'s own assertion; duplicating it here would be
//      the reciprocal-scope overlap that bead's cross-reference note warns
//      against. This test instead checks the bindings/mcp/*.json layer
//      roster-guard does not touch: that each binding file's request/
//      response $ref actually resolves to that tool's own schema pair (not
//      just that a same-named binding file exists).
//   2. every PROJECTABLE taxonomy.json code <-> the bindings/mcp/*.json
//      `errors` arrays <-> bindings/openapi/openapi.yaml's
//      `x-error-catalog` -- a projection drifting from taxonomy.json (an
//      added, removed, or mis-grouped code) fails here.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const V1_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'memory-contract', 'v1');
const SCHEMAS_DIR = path.join(V1_DIR, 'schemas');
const BINDINGS_MCP_DIR = path.join(V1_DIR, 'bindings', 'mcp');
const OPENAPI_PATH = path.join(V1_DIR, 'bindings', 'openapi', 'openapi.yaml');

const ID_BASE = 'https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas';
const TAXONOMY_ID_BASE = 'https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/taxonomy.json';

type CodeEntry = { code: string; meaning: string; surfaced: 'thrown' | 'response-field' | 'silent' };
type Taxonomy = { groups: Record<string, { codes: CodeEntry[] }> };

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(...segments), 'utf8')) as T;
}

/**
 * Independently recomputed PROJECTABLE code-ref set -- same allowlist rule
 * as generate-contract.mjs's loadProjectableCodes (surfaced is 'thrown' or
 * 'response-field'), reimplemented here rather than imported so a bug in
 * the generator's own filter cannot also hide from this check.
 */
function projectableRefs(taxonomy: Taxonomy): Set<string> {
  const refs = new Set<string>();
  for (const [group, body] of Object.entries(taxonomy.groups)) {
    body.codes.forEach((entry, index) => {
      if (entry.surfaced === 'thrown' || entry.surfaced === 'response-field') {
        refs.add(`${TAXONOMY_ID_BASE}#/groups/${group}/codes/${index}`);
      }
    });
  }
  return refs;
}

function bindingToolNames(): string[] {
  return readdirSync(BINDINGS_MCP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

function schemaToolNames(): Set<string> {
  return new Set(
    readdirSync(SCHEMAS_DIR)
      .filter((f) => f.endsWith('.request.json'))
      .map((f) => f.slice(0, -'.request.json'.length)),
  );
}

describe('memory-contract binding parity: tool <-> bindings/mcp <-> schema pair (my-beads-db-27m.10)', () => {
  const tools = bindingToolNames();

  it('has at least one binding definition (sanity: the directory is not empty/misconfigured)', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('every bindings/mcp/<tool>.json request $ref resolves to that same tool\'s own request schema', () => {
    for (const tool of tools) {
      const binding = readJson<{ request: { $ref: string } }>(BINDINGS_MCP_DIR, `${tool}.json`);
      expect(binding.request.$ref, `${tool}: request $ref`).toBe(`${ID_BASE}/${tool}.request.json#`);
    }
  });

  it('every bindings/mcp/<tool>.json response $ref resolves to that same tool\'s own response schema', () => {
    for (const tool of tools) {
      const binding = readJson<{ response: { $ref: string } }>(BINDINGS_MCP_DIR, `${tool}.json`);
      expect(binding.response.$ref, `${tool}: response $ref`).toBe(`${ID_BASE}/${tool}.response.json#`);
    }
  });

  it('no bindings/mcp/<tool>.json exists without a matching schema pair on disk', () => {
    const emitted = schemaToolNames();
    for (const tool of tools) {
      expect(emitted.has(tool), `${tool}: bindings/mcp/${tool}.json exists, no ${tool}.request.json/${tool}.response.json`).toBe(true);
    }
  });

  it('no schema pair exists without a matching bindings/mcp definition', () => {
    const bindingSet = new Set(tools);
    for (const tool of schemaToolNames()) {
      expect(bindingSet.has(tool), `${tool}: schema pair exists, no bindings/mcp/${tool}.json`).toBe(true);
    }
  });
});

describe('memory-contract taxonomy-to-projection parity, both directions (my-beads-db-27m.10)', () => {
  const taxonomy = readJson<Taxonomy>(V1_DIR, 'taxonomy.json');
  const expectedRefs = projectableRefs(taxonomy);

  const bindingErrorRefs = new Set<string>();
  for (const tool of bindingToolNames()) {
    const binding = readJson<{ errors: { $ref: string }[] }>(BINDINGS_MCP_DIR, `${tool}.json`);
    for (const e of binding.errors) bindingErrorRefs.add(e.$ref);
  }

  const openapi = readJson<{ 'x-error-catalog': { type: string }[] }>(OPENAPI_PATH);
  const catalogRefs = new Set(openapi['x-error-catalog'].map((e) => e.type));

  it('has at least one projectable code (sanity: the allowlist filter is not vacuous)', () => {
    expect(expectedRefs.size).toBeGreaterThan(0);
  });

  it('projects every projectable taxonomy.json code into at least one bindings/mcp/*.json errors array', () => {
    for (const ref of expectedRefs) {
      expect(bindingErrorRefs.has(ref), `${ref}: missing from every bindings/mcp/*.json errors array`).toBe(true);
    }
  });

  it('cites no bindings/mcp/*.json errors ref absent from the projectable taxonomy.json set', () => {
    for (const ref of bindingErrorRefs) {
      expect(expectedRefs.has(ref), `${ref}: cited by a bindings/mcp/*.json errors array, not a projectable taxonomy.json code`).toBe(true);
    }
  });

  it('projects every projectable taxonomy.json code into bindings/openapi/openapi.yaml x-error-catalog', () => {
    for (const ref of expectedRefs) {
      expect(catalogRefs.has(ref), `${ref}: missing from bindings/openapi/openapi.yaml x-error-catalog`).toBe(true);
    }
  });

  it('cites no x-error-catalog entry absent from the projectable taxonomy.json set', () => {
    for (const ref of catalogRefs) {
      expect(expectedRefs.has(ref), `${ref}: x-error-catalog cites this, not a projectable taxonomy.json code`).toBe(true);
    }
  });
});
