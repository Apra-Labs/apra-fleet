// bd my-beads-db-27m.47: reconcile the `parsed` key requirement between the
// emitted response schemas and the recorded fixture corpus.
//
// THE MISMATCH (as found)
// ------------------------
// memory-contract/v1/response-schemas.mjs's responseSchema() used to require
// both `content` and `parsed` on every response document (INVENTORY.md
// section 3: "the generated response schema is the text envelope PLUS the
// documented parsed-body object"). But no handler
// (src/services/tool-registry.ts's wrapTool) ever emits a literal `parsed`
// key on the wire -- every response is JSON.stringify()'d into a single text
// content block -- so the RECORDED fixture corpus
// (memory-contract/v1/fixtures/**) faithfully stores only `{content}`.
// Validating a raw fixture.response directly against its own schema
// therefore used to fail 25 of the 32 response fixtures with "must have
// required property 'parsed'" (verified with ajv 8.18, 2020 dialect).
//
// THE RESOLUTION (the side that moved)
// -------------------------------------
// Fixtures are never hand-doctored to add a `parsed` key (T1.4.1's exit
// criterion forbids authoring recorded envelopes). Instead the SCHEMA side
// moved: response-schemas.mjs now declares `parsed` as OPTIONAL (still fully
// typed under `properties.parsed` -- the documented body shape is untouched,
// only its mandatory presence on every instance is dropped), and
// memory-contract/v1/schemas/kb_*.response.json were regenerated
// (`npm run contract:generate`) to match. A raw recorded envelope
// (`{content}` only) now validates as-is; a LIVE or fixture-decoded envelope
// (`{...envelope, parsed: JSON.parse(...)}`, the shape
// roundtrip-harness.mjs's decodeEnvelope() produces) still validates too,
// because `additionalProperties: false` only forbids an UNDECLARED key, never
// an absent optional one.
//
// This file proves both halves of that claim over the WHOLE committed
// corpus, not just the live round-trip scenario's incidental coverage:
//   1. every raw (undecoded) response fixture validates as recorded -- 0 of
//      32 failures, reversing the 25/32 this bead's description measured;
//   2. every fixture, decoded the way any real consumer decodes it, also
//      validates -- 0 of 32 failures, so parsed staying optional never
//      silently drops schema coverage on the decoded shape either.
// Non-vacuity for both is proven with a scratch-mutated schema/envelope
// (never a real committed fixture) that DOES still fail, so an accidental
// no-op validator (e.g. `ajv.compile()` never actually invoked) cannot pass
// silently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { listFixtureKeys, loadFixture, decodeEnvelope } from '../memory-contract/v1/tests/roundtrip-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1', 'schemas');

function loadResponseSchema(tool: string) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, `${tool}.response.json`), 'utf8'));
}

/** Every `<tool>/<case>` fixture key whose committed fixture carries a `response` (not a thrown `error`). */
function responseFixtureKeys(): string[] {
  return listFixtureKeys().filter((key) => {
    const [tool, caseName] = key.split('/');
    return Boolean(loadFixture(tool, caseName).response);
  });
}

function compileAll(keys: string[]) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const compiled = new Map<string, ReturnType<InstanceType<typeof Ajv2020>['compile']>>();
  const validatorFor = (tool: string) => {
    let validate = compiled.get(tool);
    if (!validate) {
      validate = ajv.compile(loadResponseSchema(tool));
      compiled.set(tool, validate);
    }
    return validate;
  };
  return validatorFor;
}

describe('memory-contract/v1 recorded response fixtures validate against their schemas (my-beads-db-27m.47)', () => {
  it('every RAW (undecoded) recorded response fixture validates as committed, with no parsed key', () => {
    const keys = responseFixtureKeys();
    const validatorFor = compileAll(keys);
    const failures: string[] = [];

    for (const key of keys) {
      const [tool, caseName] = key.split('/');
      const fixture = loadFixture(tool, caseName);
      const validate = validatorFor(tool);
      if (!validate(fixture.response)) {
        failures.push(`${key}: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
      }
    }

    // Non-vacuous: this is the same 32-fixture population the bead's own ajv
    // sweep measured (48 committed fixtures total, 16 carry `error` instead).
    expect(keys.length).toBe(32);
    expect(failures).toEqual([]);
  });

  it('every recorded response fixture, decoded the way any consumer decodes it, ALSO validates against schemas/<tool>.response.json', () => {
    const keys = responseFixtureKeys();
    const validatorFor = compileAll(keys);
    const failures: string[] = [];

    for (const key of keys) {
      const [tool, caseName] = key.split('/');
      const fixture = loadFixture(tool, caseName);

      let decoded;
      try {
        decoded = decodeEnvelope(fixture.response);
      } catch (err) {
        failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const validate = validatorFor(tool);
      if (!validate(decoded)) {
        failures.push(`${key}: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
      }
    }

    expect(keys.length).toBe(32);
    expect(failures).toEqual([]);
  });

  it('proves the checks above are not vacuous: a scratch-mutated fixture (bad content[].type, never a real committed one) still fails', () => {
    // kb_capture, deliberately -- its `parsed` body (KB_RESPONSE_BODIES in
    // response-schemas.mjs) is a fully-typed, additionalProperties:false
    // object, unlike the 7 code_* tools' deliberately permissive
    // z.unknown(). Using a code_* fixture here would make the "wrong parsed
    // shape" probe below pass by accident (unknown accepts anything), which
    // would make this whole test vacuous for the wrong reason.
    const tool = 'kb_capture';
    const caseName = 'happy';
    const key = `${tool}/${caseName}`;
    expect(responseFixtureKeys()).toContain(key);
    const real = loadFixture(tool, caseName);
    const validatorFor = compileAll([key]);
    const validate = validatorFor(tool);

    // A committed fixture's own response, real and unmutated, must pass.
    expect(validate(real.response)).toBe(true);

    // The SAME response with `content[0].type` corrupted must fail -- proves
    // the validator actually inspects content, not just presence of the key.
    const mutated = JSON.parse(JSON.stringify(real.response));
    mutated.content[0].type = 'not-text';
    expect(validate(mutated)).toBe(false);

    // A decoded envelope whose `parsed` body is the wrong shape must also
    // fail -- proves `parsed`, though optional, is still fully typed when
    // present (not widened to z.unknown() as a side effect of this bead).
    const decoded = decodeEnvelope(real.response);
    const badParsed = { ...decoded, parsed: { unexpected_key: 'nope' } };
    expect(validate(badParsed)).toBe(false);
  });
});
