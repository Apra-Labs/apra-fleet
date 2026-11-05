// Contract: every schema node under a role report's KB fields carries an explicit
// `type` keyword. Strict structured-output derivation (e.g. a CLI that turns the
// report schema into a constrained-decoding grammar) has a missing-type fallback
// that was never exercised, so an untyped node is a latent break. The types are
// permissive unions where the engine, not the report schema, must refuse a bad
// item (see kb-bad-capture-keeps-report and kb-capture-rubric-contract).
// Read-only: writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents', 'schemas');
const KB_FIELDS = ['kb_captures', 'kb_used', 'kb_wrong'];

const outputSchemas = readdirSync(SCHEMAS)
  .filter((f) => f.endsWith('-output.json'))
  .map((f) => [f, JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8'))]);

const typeIncludes = (node, t) => (Array.isArray(node.type) ? node.type.includes(t) : node.type === t);

/** Every untyped node under `node`, as a list of JSON-pointer-ish paths. */
function untypedNodes(node, path) {
  const missing = [];
  if (!node || typeof node !== 'object' || !('type' in node)) {
    missing.push(path);
    return missing;
  }
  if (typeIncludes(node, 'array')) {
    if (!node.items) missing.push(`${path}.items`);
    else missing.push(...untypedNodes(node.items, `${path}.items`));
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) missing.push(...untypedNodes(v, `${path}.properties.${k}`));
  }
  return missing;
}

test('the walker flags an untyped items node, item property and array items node', () => {
  const s = { type: 'array', items: { properties: { a: { type: 'array' }, b: {} } } };
  assert.deepEqual(untypedNodes(s, 'x'), ['x.items']);
  const s2 = { type: 'array', items: { type: 'object', properties: { a: { type: ['array', 'string'] }, b: {} } } };
  assert.deepEqual(untypedNodes(s2, 'x'), ['x.items.properties.a.items', 'x.items.properties.b']);
});

test('at least one output schema declares each KB field', () => {
  for (const field of KB_FIELDS) {
    assert.ok(outputSchemas.some(([, s]) => s.properties && s.properties[field]), field);
  }
});

for (const [file, schema] of outputSchemas) {
  for (const field of KB_FIELDS) {
    const node = schema.properties && schema.properties[field];
    if (!node) continue;
    test(`${file}: every node under ${field} has an explicit type`, () => {
      assert.ok(node.items, `${field} must declare an items node`);
      assert.deepEqual(untypedNodes(node, field), []);
    });
  }
}
