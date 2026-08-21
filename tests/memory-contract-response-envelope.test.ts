// Regression coverage for my-beads-db-27m.33: the emitted response schemas
// under memory-contract/v1/schemas/*.response.json must accept the ENVELOPE
// SHAPE wrapTool actually produces (src/services/tool-registry.ts, ~lines
// 94-115) -- up to three content blocks (onboarding preamble + payload +
// nudge suffix), an optional `annotations: {audience, priority}` on any
// content item, and an optional `structuredContent` sibling of `content` --
// not the narrower "exactly one un-annotated text block" shape the schemas
// used to pin.
//
// This file lives under the repo's top-level tests/ (not
// memory-contract/v1/tests/) because vitest.config.ts only discovers
// tests/**/*.test.ts and packages/*/tests/**/*.test.ts -- a *.test.ts placed
// alongside the generator would never run (same reasoning already recorded
// in tests/memory-contract-postprocess-2020-12.test.ts).
//
// This test validates the ALREADY-COMMITTED, generator-emitted schema file
// on disk (not a copy re-declared in this test), so it fails exactly when
// the fix it guards is reintroduced-as-a-regression: if maxItems on
// `content` reverts to 1, if a content item's `additionalProperties: false`
// stops allowing `annotations`, or if the document root's
// `additionalProperties: false` stops allowing `structuredContent`, the
// realistic envelope below is rejected and this test fails.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_PATH = path.join(__dirname, '..', 'memory-contract', 'v1', 'schemas', 'kb_capture.response.json');

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/**
 * A REAL wrapTool envelope shape for kb_capture, reproducing exactly what
 * src/services/tool-registry.ts's wrapTool builds when an onboarding
 * preamble and nudge suffix both fire and the handler returned
 * structuredContent: three content blocks in order (preamble, payload,
 * suffix), `annotations: {audience: ['user'], priority}` on the preamble and
 * suffix blocks only, and a `structuredContent` sibling of `content`.
 */
function realWrapToolEnvelope() {
  return {
    content: [
      {
        type: 'text',
        text: '<apra-fleet-display>\nRun kb_session_prime at the start of every session.\n</apra-fleet-display>',
        annotations: { audience: ['user'], priority: 1 },
      },
      {
        type: 'text',
        text: JSON.stringify({ id: 'kb-1', audn_decision: 'add', confidence_clamped: false }),
      },
      {
        type: 'text',
        text: '<apra-fleet-display>\nCaptured. Run kb_query to confirm it is retrievable.\n</apra-fleet-display>',
        annotations: { audience: ['user'], priority: 0.8 },
      },
    ],
    structuredContent: { id: 'kb-1', audn_decision: 'add', confidence_clamped: false },
    parsed: { id: 'kb-1', audn_decision: 'add', confidence_clamped: false },
  };
}

describe('kb_capture.response.json accepts the real wrapTool envelope (my-beads-db-27m.33)', () => {
  it('validates a three-block envelope (preamble + payload + nudge suffix) with annotations and structuredContent', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const ok = validate(realWrapToolEnvelope());

    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('still rejects a content item of the wrong type (annotations does not make the item schema permissive)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad = realWrapToolEnvelope();
    (bad.content[0] as any).type = 'image';

    expect(validate(bad)).toBe(false);
  });

  it('still rejects a content item carrying an unrecognized key alongside annotations', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad = realWrapToolEnvelope();
    (bad.content[0] as any).unexpectedKey = 'nope';

    expect(validate(bad)).toBe(false);
  });

  it('still rejects an unrecognized key at the document root (structuredContent alone is not a wildcard)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad: any = realWrapToolEnvelope();
    bad.unexpectedRootKey = 'nope';

    expect(validate(bad)).toBe(false);
  });

  it('regression guard: the schema declares content minItems 1 / maxItems 3, not maxItems 1', () => {
    const schema = loadSchema();
    const contentSchema = schema.$defs['v1-kb_capture-response'].properties.content;

    expect(contentSchema.minItems).toBe(1);
    expect(contentSchema.maxItems).toBe(3);
  });

  it('regression guard: a content item permits an optional annotations object, not just type/text', () => {
    const schema = loadSchema();
    const itemSchema = schema.$defs['v1-kb_capture-response'].properties.content.items;

    expect(itemSchema.properties.annotations).toBeDefined();
    expect(itemSchema.required).toEqual(['type', 'text']);
  });

  it('regression guard: the document root permits an optional structuredContent sibling of content', () => {
    const schema = loadSchema();
    const root = schema.$defs['v1-kb_capture-response'];

    expect(root.properties.structuredContent).toBeDefined();
    expect(root.required).toEqual(['content', 'parsed']);
  });
});
