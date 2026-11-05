// Contract: every role output schema declares the optional kb_used [{id, how}]
// and kb_wrong [{id, reason}] fields. A report with well-formed items, with none,
// and with MALFORMED items all validate: the engine, not the report schema, logs
// and drops a bad item, so one bad item never costs the whole report. Iterates
// the schemas dir, so a new role schema without the fields fails here.
// Read-only: writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents');
const SCHEMAS = join(AGENTS, 'schemas');

const outputSchemas = readdirSync(SCHEMAS)
  .filter((f) => f.endsWith('-output.json'))
  .map((f) => [f, JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8'))]);

/**
 * The full report schema with only its top-level `required` list dropped, so
 * one validator per role checks the kb_used/kb_wrong fields exactly as a real
 * report would be checked, without hand-building every role's verdict fields.
 */
function reportValidator(schema) {
  const { required: _required, ...rest } = schema;
  return new Ajv({ strict: false }).compile(rest);
}

const WELL_FORMED = {
  kb_used: [{ id: 'e-1', how: 'Followed its rule for the retry budget.' }],
  kb_wrong: [{ id: 'e-2', reason: 'The flag it names was removed.' }],
};

const MALFORMED = [
  ['a bare string item', { kb_used: ['e-1'], kb_wrong: ['e-2'] }],
  ['an item missing reason / how', { kb_used: [{ id: 'e-1' }], kb_wrong: [{ id: 'e-2' }] }],
  ['a numeric id', { kb_used: [{ id: 7, how: 'x' }], kb_wrong: [{ id: 7, reason: 'x' }] }],
  ['an empty object item', { kb_used: [{}], kb_wrong: [{}] }],
  ['a malformed item next to a well-formed one', { kb_wrong: ['e-9', { id: 'e-2', reason: 'stale' }] }],
];

test('the schemas dir holds every known role output schema', () => {
  assert.ok(outputSchemas.length >= 11, outputSchemas.map(([f]) => f).join(','));
});

for (const [file, schema] of outputSchemas) {
  test(`${file}: declares optional kb_used and kb_wrong arrays`, () => {
    const p = schema.properties || {};
    for (const field of ['kb_used', 'kb_wrong']) {
      assert.ok(p[field], `${file} must declare ${field}`);
      assert.equal(p[field].type, 'array');
      assert.ok(!(schema.required || []).includes(field), `${field} must stay optional`);
    }
    assert.ok(p.kb_used.items.properties.id && p.kb_used.items.properties.how);
    assert.ok(p.kb_wrong.items.properties.id && p.kb_wrong.items.properties.reason);
  });

  test(`${file}: accepts a report with well-formed kb_used/kb_wrong and one without them`, () => {
    const validate = reportValidator(schema);
    assert.equal(validate(WELL_FORMED), true, JSON.stringify(validate.errors));
    assert.equal(validate({ kb_used: [], kb_wrong: [] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({}), true, JSON.stringify(validate.errors));
  });

  test(`${file}: accepts a report whose kb_used/kb_wrong hold malformed items`, () => {
    const validate = reportValidator(schema);
    for (const [name, report] of MALFORMED) {
      assert.equal(validate(report), true, `${name}: ${JSON.stringify(validate.errors)}`);
    }
  });
}

test('every role prompt tells the role to report kb_used/kb_wrong and that not querying is only logged', () => {
  const prompts = readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
  assert.ok(prompts.length >= 11, prompts.join(','));
  for (const f of prompts) {
    const text = readFileSync(join(AGENTS, f), 'utf8');
    assert.match(text, /^## Reporting KB use$/m, f);
    assert.ok(text.includes('`kb_used`') && text.includes('`kb_wrong`'), f);
    assert.match(text, /Not querying the KB is allowed: it is only logged, never blocked\./, f);
  }
});
