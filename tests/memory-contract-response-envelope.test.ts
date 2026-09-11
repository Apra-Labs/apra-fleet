// Regression coverage for my-beads-db-27m.33: the emitted response schemas
// under memory-contract/v1/schemas/*.response.json must accept the FULL
// wrapTool ENVELOPE CONTRACT (src/services/tool-registry.ts, ~lines 94-115)
// -- up to three content blocks (onboarding preamble + payload + nudge
// suffix), an optional `annotations: {audience, priority}` on any content
// item, and an optional `structuredContent` sibling of `content` -- not the
// narrower "exactly one un-annotated text block" shape the schemas used to
// pin.
//
// CORRECTED SCOPE (the first version of this file got this wrong): no real
// captured envelope from any of the 23 kb_*/code_* tools this contract
// inventories can actually reach the three-block/annotated/structuredContent
// shape. tool-registry.ts:99-101's `isJson = isJsonResponse(result)` is true
// for every inventoried handler (all 16 kb_* handlers and all 7 code_*
// call sites JSON.stringify their result), which nulls both the preamble
// (`getOnboardingPreamble` returns null when isJson) and the suffix
// (`isJson ? null : getOnboardingNudge(...)`); `structuredContent` is only
// produced for handlers returning `{text, structuredContent}`, which in this
// tree is `execute_command`/`execute_prompt` only, neither inventoried. So
// this file validates the committed, generator-emitted kb_capture.
// response.json against TWO fixtures, each labelled for exactly what it is:
//   (a) THE SHAPE INVENTORIED TOOLS ACTUALLY EMIT TODAY -- one content item,
//       no annotations, no structuredContent. This is the shape T1.4.1's
//       round-trip harness will actually feed.
//   (b) A CONSTRUCTED WIDER SHAPE covering wrapTool's general contract --
//       built directly from wrapTool's literal branches (lines 106-114), NOT
//       claimed to be captured from, or reachable by, any specific
//       inventoried or non-inventoried tool.
// Neither fixture is described as a real/captured kb_* envelope; wrapTool
// itself is an unexported closure inside registerTools and is never invoked
// here, and no fake/mock server object is introduced to reach it (this repo
// forbids mocks/stubs/fake classes).
//
// This file lives under the repo's top-level tests/ (not
// memory-contract/v1/tests/) because vitest.config.ts only discovers
// tests/**/*.test.ts and packages/*/tests/**/*.test.ts -- a *.test.ts placed
// alongside the generator would never run (same reasoning already recorded
// in tests/memory-contract-postprocess-2020-12.test.ts).
//
// This test validates the ALREADY-COMMITTED, generator-emitted schema file
// on disk (not a copy re-declared in this test), so it fails exactly when
// the fix it guards is reintroduced as a regression: if maxItems on
// `content` reverts to 1, if a content item's `additionalProperties: false`
// stops allowing `annotations`, or if the document root's
// `additionalProperties: false` stops allowing `structuredContent`, either
// fixture below is rejected and this test fails.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_PATH = path.join(__dirname, '..', 'memory-contract', 'v1', 'schemas', 'kb_capture.response.json');

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/**
 * (a) THE ONLY SHAPE REACHABLE THROUGH THE 23 INVENTORIED TOOLS: exactly one
 * content item {type: text, text: a JSON string}, no annotations, no
 * structuredContent, plus parsed. Reachability, not preference: kb_capture's
 * handler (src/tools/kb-capture.ts) returns JSON.stringify(...), so
 * isJsonResponse is true, which short-circuits both the onboarding preamble
 * and the nudge suffix at src/services/tool-registry.ts:99-101, and
 * kb_capture never returns {text, structuredContent}.
 */
function reachableInventoriedEnvelope() {
  const parsed = { id: 'kb-1', audn_decision: 'add', confidence_clamped: false };
  return {
    content: [{ type: 'text', text: JSON.stringify(parsed) }],
    parsed,
  };
}

/**
 * (b) A CONSTRUCTED shape covering wrapTool's general contract -- three
 * content blocks in order (preamble, payload, suffix), `annotations`
 * matching wrapTool's own literal values on the preamble/suffix blocks only,
 * and a `structuredContent` sibling of `content`. Built directly from
 * src/services/tool-registry.ts:106-114 (the `content.push(...)` calls and
 * the `structuredContent ? { content, structuredContent } : { content }`
 * return). This is NOT a claim that kb_capture, or any other specific
 * inventoried or non-inventoried tool, reaches this exact shape -- that
 * would require a separate multi-condition reachability argument (an active
 * tool, a non-JSON payload, a matching getOnboardingNudge branch, an unspent
 * milestone) this task does not make.
 */
function constructedWiderEnvelope() {
  const parsed = { id: 'kb-1', audn_decision: 'add', confidence_clamped: false };
  return {
    content: [
      {
        type: 'text',
        text: '<apra-fleet-display>\nRun kb_session_prime at the start of every session.\n</apra-fleet-display>',
        annotations: { audience: ['user'], priority: 1 },
      },
      {
        type: 'text',
        text: JSON.stringify(parsed),
      },
      {
        type: 'text',
        text: '<apra-fleet-display>\nCaptured. Run kb_query to confirm it is retrievable.\n</apra-fleet-display>',
        annotations: { audience: ['user'], priority: 0.8 },
      },
    ],
    structuredContent: parsed,
    parsed,
  };
}

describe('kb_capture.response.json accepts wrapTool\'s full envelope contract (my-beads-db-27m.33)', () => {
  it('validates the shape inventoried tools actually emit today (one un-annotated block, no structuredContent)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const ok = validate(reachableInventoriedEnvelope());

    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('validates a constructed three-block envelope with annotations and structuredContent (wrapTool general contract, not a captured kb_* envelope)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const ok = validate(constructedWiderEnvelope());

    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('still rejects a content item of the wrong type (annotations does not make the item schema permissive)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad = constructedWiderEnvelope();
    (bad.content[0] as any).type = 'image';

    expect(validate(bad)).toBe(false);
  });

  it('still rejects a content item carrying an unrecognized key alongside annotations', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad = constructedWiderEnvelope();
    (bad.content[0] as any).unexpectedKey = 'nope';

    expect(validate(bad)).toBe(false);
  });

  it('still rejects an unrecognized key at the document root (structuredContent alone is not a wildcard)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const bad: any = constructedWiderEnvelope();
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
    // `parsed` is intentionally NOT required (my-beads-db-27m.47): no handler
    // ever puts a literal `parsed` key on the wire, so a raw recorded
    // envelope ({content} only) must validate as-is. The body stays fully
    // typed under properties.parsed (checked below) -- only its presence on
    // any single instance is optional.
    expect(root.required).toEqual(['content']);
  });

  it('regression guard (my-beads-db-27m.47): parsed stays fully typed under properties even though it is optional', () => {
    const schema = loadSchema();
    const root = schema.$defs['v1-kb_capture-response'];

    expect(root.properties.parsed).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        audn_decision: { type: 'string', enum: ['add', 'update', 'flagged', 'none'] },
        confidence_clamped: { type: 'boolean' },
      },
      required: ['id', 'audn_decision', 'confidence_clamped'],
      additionalProperties: false,
    });
  });

  it('a raw recorded envelope with no parsed key validates (my-beads-db-27m.47: the wire never carries one)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(loadSchema());

    const raw = { content: [{ type: 'text', text: JSON.stringify({ id: 'kb-1', audn_decision: 'add', confidence_clamped: false }) }] };

    expect(validate(raw)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });
});
