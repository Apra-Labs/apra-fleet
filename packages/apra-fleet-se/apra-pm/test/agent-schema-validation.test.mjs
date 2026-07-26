// apra-fleet-unw.21 -- CI-style drift guard: every role's Output schema example
// instance (embedded in agents/<role>.md) must validate against its own sibling
// machine-readable contract at agents/schemas/<role>-output.json. Catches prose/schema
// divergence at the source instead of discovering it live in a fleet dispatch.
//
// Also asserts every agents/schemas/*.json file is valid JSON Schema (ajv
// compiles it without error) and carries a versioned $id, per
// apra-fleet-unw.21 acceptance criteria 2 and 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

const __dir = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dir, '..', 'agents');
const schemasDir = join(agentsDir, 'schemas');

// Ajv caches compiled schemas by $id on the instance itself, so each
// ajv.compile() call below uses its own fresh instance -- otherwise
// re-compiling a schema whose $id was already registered (e.g. once in the
// "valid JSON Schema" loop and again in the "example validates" loop) throws
// "schema ... already exists" instead of exercising validation.
function freshAjv() {
  return new Ajv({ strict: false });
}

// Roles that publish a structured output contract (everyone except planner,
// whose output is the beads DAG itself -- see agents/planner.md Output schema).
const STRUCTURED_ROLES = [
  'plan-reviewer',
  'doer',
  'reviewer',
  'deployer',
  'integ-test-runner',
  'ci-watcher',
  'harvester',
];

/**
 * Extracts the first fenced ```json ... ``` block from markdown text found
 * after the "## Output schema" heading. Mirrors how a caller/model would
 * locate the example instance in the role persona.
 */
function extractOutputExample(mdText) {
  const headingIdx = mdText.indexOf('## Output schema');
  assert.ok(headingIdx >= 0, 'Expected an "## Output schema" heading');
  const afterHeading = mdText.slice(headingIdx);
  const fenceStart = afterHeading.indexOf('```json');
  assert.ok(fenceStart >= 0, 'Expected a fenced ```json block under "## Output schema"');
  const bodyStart = fenceStart + '```json'.length;
  const fenceEnd = afterHeading.indexOf('```', bodyStart);
  assert.ok(fenceEnd >= 0, 'Unterminated ```json fence under "## Output schema"');
  const body = afterHeading.slice(bodyStart, fenceEnd).trim();
  return JSON.parse(body);
}

// ---- every agents/schemas/*.json is valid JSON Schema with a versioned $id ----

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));

test('agents/schemas/ is non-empty', () => {
  assert.ok(schemaFiles.length > 0, 'Expected at least one schema file');
});

for (const file of schemaFiles) {
  test(`agents/schemas/${file} is valid JSON Schema with a versioned $id`, () => {
    const raw = readFileSync(join(schemasDir, file), 'utf-8');
    const schema = JSON.parse(raw);

    assert.equal(typeof schema.$id, 'string', `${file} must have a string $id`);
    assert.match(schema.$id, /@\d+$/, `${file}'s $id must end in a major version, e.g. "...@1" (got ${schema.$id})`);
    assert.equal(typeof schema.version, 'number', `${file} must have a numeric top-level "version" field`);

    // ajv.compile throws on an invalid schema.
    assert.doesNotThrow(() => freshAjv().compile(schema), `ajv failed to compile ${file}`);
  });
}

// ---- each structured role's .md Output schema example validates against its sibling schema ----

for (const role of STRUCTURED_ROLES) {
  test(`agents/${role}.md Output schema example validates against agents/schemas/${role}-output.json`, () => {
    const mdText = readFileSync(join(agentsDir, `${role}.md`), 'utf-8');
    const schema = JSON.parse(readFileSync(join(schemasDir, `${role}-output.json`), 'utf-8'));
    const example = extractOutputExample(mdText);

    const validate = freshAjv().compile(schema);
    const valid = validate(example);
    assert.ok(valid, `${role}.md example does not match agents/schemas/${role}-output.json: ${JSON.stringify(validate.errors)}`);
  });

  test(`agents/${role}.md points at its sibling agents/schemas/${role}-output.json`, () => {
    const mdText = readFileSync(join(agentsDir, `${role}.md`), 'utf-8');
    assert.ok(
      mdText.includes(`agents/schemas/${role}-output.json`),
      `${role}.md must reference its sibling agents/schemas/${role}-output.json as the canonical machine contract`
    );
  });
}

// ---- planner has no structured output schema, and references nothing cross-repo ----

test('agents/planner.md declares it has no structured output contract, points at plan-reviewer', () => {
  const mdText = readFileSync(join(agentsDir, 'planner.md'), 'utf-8');
  assert.ok(mdText.includes('no structured output contract'));
  assert.ok(mdText.includes('agents/schemas/plan-reviewer-output.json'));
});

test('no cross-repo application-layer references anywhere under agents/', () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  // Negative lookahead on "runner.js" avoids a false positive on legitimate
  // in-repo references like "agents/schemas/integ-test-runner-output.json" (whose
  // text contains the substring "runner.js" followed by "on").
  const forbidden = /apra-fleet-se|contracts\.mjs|apra-fleet-workflow|runner\.js(?!on)/i;
  for (const f of files) {
    const text = readFileSync(join(agentsDir, f), 'utf-8');
    assert.doesNotMatch(text, forbidden, `${f} contains a forbidden cross-repo reference`);
  }
});

// ---- input schemas (where present) are valid JSON Schema with a versioned $id ----
// (covered by the generic agents/schemas/*.json loop above, since input schemas
// live in the same directory.)
