// Contract: every schema node under a role report's KB fields carries the FULL
// type union, explicitly. The union admits any JSON value, so a wrong JSON type
// in one capture can never void the role's report; the engine refuses it per
// item (see kb-bad-capture-keeps-report and kb-capture-rubric-contract). The
// keyword stays explicit because strict structured-output derivation (e.g. a CLI
// that turns the report schema into a constrained-decoding grammar) has a
// missing-type fallback that was never exercised.
// Read-only: writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents', 'schemas');
const KB_FIELDS = ['kb_captures', 'kb_used', 'kb_wrong'];
const FULL_UNION = ['array', 'boolean', 'null', 'number', 'object', 'string'];

const outputSchemas = readdirSync(SCHEMAS)
  .filter((f) => f.endsWith('-output.json'))
  .map((f) => [f, JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8'))]);

const hasFullUnion = (node) => Array.isArray(node.type) && [...node.type].sort().join() === FULL_UNION.join();

/** Every node under `node` that lacks the full union, as JSON-pointer-ish paths. */
function narrowNodes(node, path) {
  const missing = [];
  if (!node || typeof node !== 'object' || !hasFullUnion(node)) missing.push(path);
  if (!node || typeof node !== 'object') return missing;
  if (node.items) missing.push(...narrowNodes(node.items, `${path}.items`));
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) missing.push(...narrowNodes(v, `${path}.properties.${k}`));
  }
  return missing;
}

test('the walker flags a narrow items node, item property and array items node', () => {
  const type = [...FULL_UNION];
  const s = { type, items: { type: 'object', properties: { a: { type }, b: {} } } };
  assert.deepEqual(narrowNodes(s, 'x'), ['x.items', 'x.items.properties.b']);
  const s2 = { type, items: { type, properties: { a: { type, items: { type: 'string' } }, b: { type: ['string', 'null'] } } } };
  assert.deepEqual(narrowNodes(s2, 'x'), ['x.items.properties.a.items', 'x.items.properties.b']);
  assert.deepEqual(narrowNodes({ type, items: { type } }, 'x'), []);
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
    test(`${file}: every node under ${field} carries the full type union`, () => {
      assert.ok(node.items, `${field} must declare an items node`);
      assert.deepEqual(narrowNodes(node, field), []);
    });
  }
  const captures = schema.properties && schema.properties.kb_captures;
  if (captures) {
    test(`${file}: the capture array fields declare their items`, () => {
      for (const f of ['symbols', 'source_files', 'recall_cues', 'error_signatures']) {
        assert.ok(captures.items.properties[f].items, f);
      }
    });
  }
}
