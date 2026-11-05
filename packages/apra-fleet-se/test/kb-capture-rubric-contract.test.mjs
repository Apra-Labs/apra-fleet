// Contract: kb_captures document their rules in description text (the six
// triggers, the length limits) and the report schema enforces none of them, so a
// bad capture can never fail the whole report; reviewer-output accepts kb_rejects,
// the three capture-writing prompts reference the shared rubric, and none of it
// cites bead ids. Read-only: writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  KB_MIN_CAPTURE_TITLE, KB_MAX_CAPTURE_TITLE, KB_MIN_CAPTURE_SUMMARY, KB_MAX_CAPTURE_SUMMARY,
  KB_MIN_CAPTURE_CONTENT, KB_MAX_CAPTURE_CONTENT,
} from '../fleet-sprint/kb.mjs';

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
  test(`${file}: kb_captures states the rules a role must follow, in description text`, () => {
    const p = schema.properties.kb_captures.items.properties;
    assert.deepEqual(p.trigger.examples, TRIGGERS);
    assert.match(p.trigger.description, /^REQUIRED/);
    assert.match(p.title.description, new RegExp(`${KB_MIN_CAPTURE_TITLE} to ${KB_MAX_CAPTURE_TITLE} characters`));
    assert.match(p.summary.description, new RegExp(`${KB_MIN_CAPTURE_SUMMARY} to ${KB_MAX_CAPTURE_SUMMARY} characters`));
    assert.match(p.content.description, new RegExp(`^Optional.* ${KB_MIN_CAPTURE_CONTENT} to ${KB_MAX_CAPTURE_CONTENT} characters`));
    assert.match(p.source_files.description, /^REQUIRED/);
    assert.ok(p.recall_cues.description && p.error_signatures.description);
  });

  test(`${file}: the report schema fails on no capture, however bad`, () => {
    const validate = new Ajv({ strict: false }).compile(schema.properties.kb_captures);
    const { trigger, ...noTrigger } = baseCapture;
    for (const bad of [
      noTrigger,
      { ...baseCapture, trigger: 'describes-the-change' },
      { ...baseCapture, content: 'short' },
      { ...baseCapture, content: 'c'.repeat(KB_MAX_CAPTURE_CONTENT + 1) },
      { ...baseCapture, content: 42 },
      { ...baseCapture, title: 't' },
      { ...baseCapture, title: 't'.repeat(KB_MAX_CAPTURE_TITLE + 1) },
      { ...baseCapture, summary: 's' },
      { ...baseCapture, type: 'nonsense' },
      { ...baseCapture, source_files: [] },
      { ...baseCapture, source_files: 'a.txt' },
      { ...baseCapture, recall_cues: 'not an array' },
      {},
      'not even an object',
    ]) {
      assert.equal(validate([bad]), true, `${JSON.stringify(bad)}: ${JSON.stringify(validate.errors)}`);
    }
  });
}

test('the rubric states the same length limits the engine enforces', () => {
  const rubric = readFileSync(join(AGENTS, RUBRIC_REL), 'utf8');
  assert.ok(rubric.includes(`title ${KB_MIN_CAPTURE_TITLE} to ${KB_MAX_CAPTURE_TITLE} characters`), 'title limits');
  assert.ok(rubric.includes(`summary ${KB_MIN_CAPTURE_SUMMARY} to ${KB_MAX_CAPTURE_SUMMARY}`), 'summary limits');
  assert.ok(rubric.includes(`content ${KB_MIN_CAPTURE_CONTENT} to ${KB_MAX_CAPTURE_CONTENT}`), 'content limits');
});

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
