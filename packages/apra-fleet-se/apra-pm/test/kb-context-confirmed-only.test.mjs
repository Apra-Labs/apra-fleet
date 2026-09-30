import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Owner rule, shared with the fleet-sprint engine: only CONFIRMED KB entries
// outside any unresolved contradiction are injected into a role prompt. The
// workflow is not importable (top-level await/return), so buildKBContext and
// its predicate are extracted from the source text and evaluated in isolation,
// the same technique bd-json-warning-tolerance.test.mjs uses for BD_JSON.

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8',
);

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in auto-sprint.js`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} must end with a column-0 closing brace`);
  return src.slice(start, end + 2);
}

const buildKBContext = Function(
  `const KB_CHAR_BUDGET = 4000;\n${extractFunction('isInjectableKbEntry')}\n${extractFunction('buildKBContext')}\nreturn buildKBContext;`,
)();

const entry = (title, confidence, extra = {}) => ({ title, summary: `${title} summary`, confidence, ...extra });

test('buildKBContext renders CONFIRMED, undisputed entries only', () => {
  const block = buildKBContext({
    entries: [
      entry('confirmedmarker one', 'CONFIRMED'),
      entry('inferredmarker', 'INFERRED'),
      entry('unverifiedmarker', 'UNVERIFIED'),
      entry('flaggedmarker', 'CONFIRMED', { flagged_for_review: true }),
      entry('contradictionmarker', 'CONFIRMED', { contradiction_of: 'abc' }),
      entry('notiermarker', undefined),
      entry('confirmedmarker two', 'CONFIRMED', { contradiction_of: null, flagged_for_review: false }),
    ],
  });
  assert.ok(block.includes('confirmedmarker one'));
  assert.ok(block.includes('confirmedmarker two'));
  for (const m of ['inferredmarker', 'unverifiedmarker', 'flaggedmarker', 'contradictionmarker', 'notiermarker']) {
    assert.ok(!block.includes(m), `${m} must not be injected`);
  }
  assert.match(block, /Project Knowledge Bank \(2 entries\)/, 'the count reflects what is rendered');
});

test('buildKBContext header drops the INFERRED guidance', () => {
  const block = buildKBContext({ entries: [entry('x', 'CONFIRMED')] });
  assert.doesNotMatch(block, /INFERRED/);
  assert.match(block, /Only CONFIRMED entries are included/);
});

test('buildKBContext is empty when nothing is CONFIRMED', () => {
  assert.equal(buildKBContext({ entries: [entry('a', 'INFERRED'), entry('b', 'CONFIRMED', { flagged_for_review: true })] }), '');
  assert.equal(buildKBContext({ entries: [] }), '');
  assert.equal(buildKBContext(null), '');
});

test('the KB primer relays the dispute markers the filter reads', () => {
  const schemaStart = src.indexOf('const KB_PRIMER_SCHEMA = {');
  const schema = src.slice(schemaStart, src.indexOf('\n};\n', schemaStart));
  assert.match(schema, /flagged_for_review:/);
  assert.match(schema, /contradiction_of:/);
  assert.match(src, /For each entry return: title, summary, confidence, flagged_for_review, contradiction_of,/);
});
