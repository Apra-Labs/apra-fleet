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
  for (const body of Object.values(taxonomy.groups)) {
    for (const entry of body.codes) {
      if (entry.surfaced === 'thrown' || entry.surfaced === 'response-field') {
        refs.add(`${TAXONOMY_ID_BASE}#${entry.code}`);
      }
    }
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

// Taxonomy refs must be stable under insertion (taxonomy.json _meta.ref_rule):
// projections reference a code BY ID (its $anchor, which equals its code), so
// inserting, removing or reordering codes can never make an existing ref name
// a different code. A positional JSON Pointer (#/groups/<g>/codes/<i>) would
// silently shift meaning on a mid-array insertion -- these tests fail if one
// ever reappears, or if an anchor stops matching the code it labels.
describe('memory-contract taxonomy refs are by id, stable under insertion', () => {
  type AnchoredEntry = { code: string; $anchor?: string };
  const taxonomy = readJson<{
    groups: Record<string, { codes: AnchoredEntry[] }>;
    excluded_from_closed_set: { codes: AnchoredEntry[] };
  }>(V1_DIR, 'taxonomy.json');
  const groupCodes = new Set(Object.values(taxonomy.groups).flatMap((g) => g.codes.map((c) => c.code)));

  function allProjectionRefs(): string[] {
    const refs: string[] = [];
    for (const tool of bindingToolNames()) {
      const binding = readJson<{ errors: { $ref: string }[] }>(BINDINGS_MCP_DIR, `${tool}.json`);
      refs.push(...binding.errors.map((e) => e.$ref));
    }
    const openapi = readJson<{ 'x-error-catalog': { type: string }[] }>(OPENAPI_PATH);
    refs.push(...openapi['x-error-catalog'].map((e) => e.type));
    return refs;
  }

  it('gives every groups code a $anchor equal to its code string', () => {
    for (const body of Object.values(taxonomy.groups)) {
      for (const entry of body.codes) {
        expect(entry.$anchor, `${entry.code}: $anchor`).toBe(entry.code);
      }
    }
  });

  it('gives no excluded_from_closed_set code an anchor (directive-activation absence)', () => {
    for (const entry of taxonomy.excluded_from_closed_set.codes) {
      expect(entry.$anchor, `${entry.code}: excluded code must not be addressable`).toBeUndefined();
    }
  });

  it('references every code by id, never by a positional pointer, and every id resolves to a groups code', () => {
    const refs = allProjectionRefs();
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith(`${TAXONOMY_ID_BASE}#`), `${ref}: not a taxonomy.json ref`).toBe(true);
      const fragment = ref.slice(TAXONOMY_ID_BASE.length + 1);
      expect(fragment.includes('/'), `${ref}: positional JSON Pointer -- shifts meaning on insertion`).toBe(false);
      expect(groupCodes.has(fragment), `${ref}: fragment names no taxonomy.json groups code`).toBe(true);
    }
  });

  it('a ref keeps naming the same code when a code is inserted at the head of every group', () => {
    // Resolve each ref against the real taxonomy and against a copy with a
    // new code inserted mid-array everywhere; by-id resolution must agree.
    const resolve = (groups: Record<string, { codes: AnchoredEntry[] }>, fragment: string): string | undefined =>
      Object.values(groups).flatMap((g) => g.codes).find((c) => c.$anchor === fragment)?.code;
    const shifted: Record<string, { codes: AnchoredEntry[] }> = {};
    for (const [group, body] of Object.entries(taxonomy.groups)) {
      shifted[group] = { codes: [{ code: `E-INSERTED-${group}`, $anchor: `E-INSERTED-${group}` }, ...body.codes] };
    }
    for (const ref of allProjectionRefs()) {
      const fragment = ref.slice(TAXONOMY_ID_BASE.length + 1);
      expect(resolve(shifted, fragment), `${ref}: meaning changed under insertion`).toBe(resolve(taxonomy.groups, fragment));
    }
  });
});
