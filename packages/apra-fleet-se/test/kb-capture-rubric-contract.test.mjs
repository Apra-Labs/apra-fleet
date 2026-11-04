// Contract: kb_captures require a trigger (six-value enum), content is optional,
// reviewer-output accepts kb_rejects, the three capture-writing prompts reference
// the shared rubric, and none of it cites bead ids. Read-only: writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents');
const SCHEMAS = join(AGENTS, 'schemas');
const RUBRIC_REL = '_shared/KB-CAPTURE-RUBRIC.md';
const TRIGGERS = ['failed-attempt', 'review-finding', 'test-failure', 'env-quirk', 'hidden-invariant', 'design-rationale'];
const BEAD_ID_RE = /apra-fleet-[a-z0-9]+/;

const load = (f) => JSON.parse(readFileSync(join(SCHEMAS, f), 'utf8'));
const captureSchemas = readdirSync(SCHEMAS)
  .filter((f) => f.endsWith('-output.json'))
  .map((f) => [f, load(f)])
  .filter(([, s]) => s.properties && s.properties.kb_captures);

const baseCapture = {
  type: 'learning',
  title: 'A long enough title',
  summary: 'A summary that is long enough to pass.',
  trigger: 'env-quirk',
  source_files: ['a.txt'],
};

test('at least the four known roles declare kb_captures', () => {
  assert.ok(captureSchemas.length >= 4, captureSchemas.map(([f]) => f).join(','));
});

for (const [file, schema] of captureSchemas) {
  test(`${file}: kb_captures requires trigger (six values), not content`, () => {
    const item = schema.properties.kb_captures.items;
    assert.ok(item.required.includes('trigger'));
    assert.ok(!item.required.includes('content'));
    assert.deepEqual(item.properties.trigger.enum, TRIGGERS);
    assert.ok(item.properties.content.maxLength === 2000);
    assert.ok(item.properties.content.minLength >= 1);
    assert.equal(item.properties.recall_cues.type, 'array');
    assert.equal(item.properties.error_signatures.type, 'array');
  });

  test(`${file}: validator rejects capture without trigger, accepts without content`, () => {
    const validate = new Ajv({ strict: false }).compile(schema.properties.kb_captures);
    const { trigger, ...noTrigger } = baseCapture;
    assert.equal(validate([noTrigger]), false);
    assert.equal(validate([baseCapture]), true, JSON.stringify(validate.errors));
    assert.equal(validate([{ ...baseCapture, trigger: 'describes-the-change' }]), false);
    assert.equal(validate([{ ...baseCapture, content: '' }]), false);
  });
}

test('reviewer-output accepts kb_rejects [{id, reason}] and rejects a missing reason', () => {
  const schema = load('reviewer-output.json');
  const validate = new Ajv({ strict: false }).compile(schema.properties.kb_rejects);
  assert.equal(validate([{ id: 'e1', reason: 'restates the diff, fails the rubric' }]), true);
  assert.equal(validate([{ id: 'e1' }]), false);
  assert.equal(validate([{ id: 'e1', reason: 'too short' }]), false);
});

test('rubric exists with GOOD and NOT KB lists; doer, reviewer, harvester reference it', () => {
  const p = join(AGENTS, RUBRIC_REL);
  assert.ok(existsSync(p));
  const rubric = readFileSync(p, 'utf8');
  assert.match(rubric, /^## GOOD/m);
  assert.match(rubric, /^## NOT KB/m);
  for (const role of ['doer', 'reviewer', 'harvester']) {
    assert.ok(readFileSync(join(AGENTS, `${role}.md`), 'utf8').includes(RUBRIC_REL), `${role}.md must reference ${RUBRIC_REL}`);
  }
});

test('no bead id in agents/schemas or the rubric', () => {
  const files = readdirSync(SCHEMAS).map((f) => join(SCHEMAS, f)).concat(join(AGENTS, RUBRIC_REL));
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), BEAD_ID_RE, f);
});
