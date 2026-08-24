// Response body schemas for the v1 memory contract's 23 inventoried tools.
//
// WHY THIS FILE EXISTS
// INVENTORY.md section 3 records the decision rule for responses: no tool in
// the real surface (src/tools/*.ts) declares a response zod schema (see the
// CONFIRMED KB finding this repeats: x-invariant annotation and response
// authoring were never anyone else's job, they are this task's, T1.2.2's).
// So the response side of the contract has no zod source to import from
// dist/ the way the request side does -- it has to be authored here, from the
// OBSERVED top-level shapes INVENTORY.md section 2 already verified against
// the real handlers.
//
// DECISION RULE (INVENTORY.md section 3, reproduced for callers of this
// module): every tool response is modelled as a minimal text-content
// envelope, `{ content: [ { type: "text", text: string } ] }`, plus one of:
//   - Body known   -- the 16 kb_* tools, whose handler stringifies an object
//     with an observable top-level shape. Modelled field-for-field below.
//   - Body opaque  -- the 7 code_* tools, whose handler proxies an
//     unconstrained provider payload (Promise<unknown>). Modelled as
//     z.unknown(), which is a deliberate permissive schema, not a stand-in for
//     a shape nobody has verified.
//
// Field-level types below are the OBSERVED top-level keys from INVENTORY.md
// 2.1 and the provider method table in section 4.1; nested/complex payloads
// (KB entries, query hits) are typed z.unknown() rather than guessed, since
// no zod schema for them exists anywhere in this repo to cite as evidence.
//
// ENVELOPE WIDTH (my-beads-db-27m.33): the envelope below was originally
// pinned to exactly one un-annotated content block, but the real wrapTool
// (src/services/tool-registry.ts lines 94-115) builds up to THREE content
// blocks -- an onboarding preamble, the payload, and a nudge suffix -- stamps
// `annotations: {audience, priority}` on the preamble/suffix blocks, and
// returns `structuredContent` as a sibling of `content` whenever the handler
// produced it.
//
// CORRECTED CLAIM (the first version of this comment got this wrong): none of
// that -- extra blocks, annotations, or structuredContent -- is reachable by
// any of the 23 kb_*/code_* tools this contract inventories. tool-registry.ts
// :99-101 computes `isJson = isJsonResponse(result)`; every inventoried
// handler returns `JSON.stringify(...)`, so isJson is always true, which
// nulls both the preamble (`getOnboardingPreamble` returns null when isJson)
// and the suffix (`isJson ? null : getOnboardingNudge(...)`).
// `structuredContent` is only produced for handlers returning
// `{text, structuredContent}`, which in this tree is `execute_command`/
// `execute_prompt` only, neither inventoried. So a genuine captured envelope
// from an inventoried tool never actually failed the old narrow schema on
// these grounds -- the widening below documents wrapTool's GENERAL contract
// (the shape ANY wrapTool-registered tool may emit), not a bug the
// inventoried 23 trip over today. Fixed here on the SCHEMA side only, per
// this task's acceptance criteria -- no harness/validator was loosened, and
// the width is not justified against the inventoried tool set. `parsed`
// (added by responseSchema() below) was untouched by THIS task; it was later
// made optional-but-typed by my-beads-db-27m.47 (see that function's own
// doc comment) for an unrelated reason -- the wire never carries it, so
// requiring it made every recorded fixture fail its own schema.

import { z } from 'zod';

/**
 * A single MCP text content block. `annotations` is optional and, when
 * present, carries the `{audience, priority}` shape wrapTool actually stamps
 * on its preamble/nudge blocks (never on the payload block itself, but the
 * schema does not need to distinguish which block carries it -- any block MAY
 * carry it).
 */
const toolTextContentItem = z.object({
  type: z.literal('text'),
  text: z.string(),
  annotations: z
    .object({
      audience: z.array(z.enum(['user', 'assistant'])).optional(),
      priority: z.number().optional(),
    })
    .optional(),
});

/**
 * The shared MCP text-content envelope every one of the 23 handlers uses.
 * 1..3 content items (onboarding preamble + payload + nudge suffix, in that
 * order, preamble/suffix optional), plus an optional `structuredContent`
 * sibling (wrapTool returns it whenever the handler's raw return value was
 * `{text, structuredContent}` rather than a bare string).
 */
export const toolTextEnvelope = z.object({
  content: z.array(toolTextContentItem).min(1).max(3),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

// --- kb_* observed response bodies (INVENTORY.md 2.1) -----------------------

const KB_RESPONSE_BODIES = {
  kb_capture: z.object({
    id: z.string(),
    audn_decision: z.enum(['add', 'update', 'flagged', 'none']),
    confidence_clamped: z.boolean(),
  }),
  kb_invalidate: z.object({
    invalidated: z.number(),
    files: z.array(z.string()),
  }),
  // F-10 (my-beads-db-27m.9, caught by the live round-trip harness): `fresh`
  // and `stale` are NOT string arrays. src/tools/kb-context.ts:32-33 filters
  // the provider's result objects (`{file, status, reason, entry_id}`) and
  // ships them whole; only `missing` is mapped down to file names
  // (kb-context.ts:34). The committed fixture kb_context/happy.json shows the
  // object form too, so the previous z.array(z.string()) contradicted both the
  // implementation and the corpus. Element shape stays z.unknown() per this
  // file's standing rule -- no zod schema for a context result exists anywhere
  // in this repo to cite, and guessing one is what produced this defect.
  kb_context: z.object({
    fresh: z.array(z.unknown()),
    stale: z.array(z.unknown()),
    missing: z.array(z.string()),
  }),
  kb_session_prime: z.object({
    session_warm: z.boolean(),
    stale_files: z.array(z.string()),
    top_entries: z.array(z.unknown()),
    fresh_summaries: z.array(z.unknown()),
    recommended_code_calls: z.array(z.unknown()),
    token_estimate: z.number(),
  }),
  // F-8: kb_query returns one of two mutually exclusive shapes, keyed by
  // whether the request set flagged_only. related_claims is ABSENT (not
  // null) unless expand_related was requested, hence .optional() not
  // .nullable().
  kb_query: z.union([
    z.object({
      l1_results: z.array(z.unknown()),
      l2_expanded: z.array(z.unknown()),
      related_claims: z.array(z.unknown()).optional(),
    }),
    z.object({
      flagged_entries: z.array(z.unknown()),
      total: z.number(),
      note: z.string(),
    }),
  ]),
  kb_list: z.object({
    results: z.array(z.unknown()),
    total: z.number(),
  }),
  kb_harvest: z.object({
    entries_captured: z.number(),
    entries_updated: z.number(),
    entries_skipped: z.number(),
    entries_rejected: z.number(),
  }),
  kb_promote: z.object({
    id: z.string(),
    previous_confidence: z.string(),
    new_confidence: z.string(),
  }),
  kb_freshness_sweep: z.object({
    checked: z.number(),
    staled: z.number(),
    unstaled: z.number(),
  }),
  kb_import: z.object({
    imported: z.number(),
    skipped: z.number(),
    linked: z.number(),
    flagged: z.number(),
    rejected: z.number(),
    sweep: z.object({
      checked: z.number(),
      staled: z.number(),
      unstaled: z.number(),
    }),
  }),
  kb_resolve_contradiction: z.object({
    winnerId: z.string(),
    loserId: z.string(),
  }),
  kb_reconcile_prefilter: z.object({
    pairs: z.number(),
    resolved: z.array(z.unknown()),
    left_for_agent: z.array(z.unknown()),
    // F-11 (my-beads-db-27m.9, caught by the live round-trip harness): a COUNT
    // of directive pairs skipped, not a flag -- src/services/knowledge/
    // sqlite-provider.ts:1635 declares `skipped_directive: number` and :1650
    // increments it. kb_reconcile_prefilter/happy.json records 0, so the
    // previous z.boolean() contradicted the implementation and the corpus.
    skipped_directive: z.number(),
  }),
  kb_setup: z.object({
    success: z.boolean(),
    steps: z.array(z.unknown()),
  }),
  kb_export: z.object({
    exported: z.number(),
    path: z.string(),
    scope: z.enum(['project', 'global']),
    committed: z.boolean(),
  }),
  // F-9: kb_stats spreads ProviderStats (whose supported/reason/coverage are
  // only present for a provider that cannot compute stats at all) and adds
  // bible. Nested aggregates have no zod shape anywhere to cite, so they stay
  // z.unknown() rather than a guessed structure.
  kb_stats: z.object({
    supported: z.boolean().optional(),
    reason: z.string().optional(),
    totals: z.unknown(),
    stale: z.unknown(),
    flagged: z.unknown(),
    superseded: z.unknown(),
    retrieval: z.unknown(),
    promote_ratio: z.number(),
    coverage: z.unknown().optional(),
    bible: z.unknown(),
  }),
  kb_feedback: z.object({
    id: z.string(),
    stale: z.boolean(),
    flagged_for_review: z.boolean(),
    confidence: z.string(),
  }),
};

const CODE_TOOLS = [
  'code_graph',
  'code_impact',
  'code_query',
  'code_context',
  'code_map',
  'code_flow',
  'code_tests',
];

/**
 * The response schema for one inventoried tool: the shared text envelope plus
 * a `parsed` key holding the documented (or, for code_*, deliberately
 * unconstrained) parsed body. See the decision rule in this file's header and
 * in INVENTORY.md section 3.
 *
 * `parsed` IS OPTIONAL (my-beads-db-27m.47), never required: no handler
 * (src/services/tool-registry.ts's wrapTool) ever puts a literal `parsed` key
 * on the wire -- every response is JSON.stringify()'d into a single text
 * content block -- so the RECORDED envelope genuinely never carries one. The
 * shape stays fully typed under `properties.parsed` (INVENTORY.md section 3's
 * "the generated response schema is the text envelope PLUS the documented
 * parsed-body object" still holds -- the body is documented, just not
 * mandated on every instance): a raw recorded envelope ({content} only)
 * validates as-is, and a decoded one ({...envelope, parsed: JSON.parse(...)},
 * the shape memory-contract/v1/tests/roundtrip-harness.mjs's decodeEnvelope()
 * produces) validates too, because `additionalProperties: false` only forbids
 * an UNDECLARED key, not an absent optional one. Before this change `parsed`
 * was required, which made every one of the 32 recorded response fixtures
 * fail its own schema when read as committed (ajv: "must have required
 * property 'parsed'") -- see tests/memory-contract-fixture-response-schema.
 * test.ts and memory-contract/v1/tests/DEGRADATION.md D-4.
 *
 * @param {string} tool
 * @returns {import('zod').ZodTypeAny}
 */
export function responseSchema(tool) {
  if (tool in KB_RESPONSE_BODIES) {
    return toolTextEnvelope.extend({ parsed: KB_RESPONSE_BODIES[tool].optional() });
  }
  if (CODE_TOOLS.includes(tool)) {
    return toolTextEnvelope.extend({ parsed: z.unknown().optional() });
  }
  throw new Error(`response-schemas.mjs: no response body registered for tool "${tool}"`);
}
