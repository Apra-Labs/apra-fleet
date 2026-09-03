// bindings/openapi/openapi.yaml is emitted through the same JSON emit() path
// as every other memory-contract generated artifact (deliberate, for
// byte-stable idempotence with schemas/ and bindings/mcp/), relying on JSON
// being valid YAML 1.2 flow syntax. Nothing else in the repo proves a real
// YAML parser accepts the emitted file -- this test is that consumer-side
// proof: parse it with the `yaml` package and assert the parsed document
// round-trips to the same object as JSON.parse would produce.
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/)
// because vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts -- the same reason as every other
// memory-contract test at this path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

const OPENAPI_PATH = fileURLToPath(
  new URL('../memory-contract/v1/bindings/openapi/openapi.yaml', import.meta.url),
);

describe('bindings/openapi/openapi.yaml is real, parseable YAML', () => {
  const raw = readFileSync(OPENAPI_PATH, 'utf8');

  it('parses with a YAML parser without throwing', () => {
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('round-trips to the same object a JSON parse would produce', () => {
    const viaYaml = parseYaml(raw);
    const viaJson = JSON.parse(raw);
    expect(viaYaml).toEqual(viaJson);
  });

  it('carries the top-level keys the openapi.yaml builder is expected to emit', () => {
    const doc = parseYaml(raw);
    expect(Object.keys(doc)).toEqual(['openapi', 'info', 'paths', 'components', 'x-error-catalog']);
  });

  it('declares zero paths and a non-empty error catalog', () => {
    const doc = parseYaml(raw);
    expect(doc.paths).toEqual({});
    expect(Array.isArray(doc['x-error-catalog'])).toBe(true);
    expect(doc['x-error-catalog'].length).toBeGreaterThan(0);
  });
});
