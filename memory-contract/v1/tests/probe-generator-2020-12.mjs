// Generator bake-off probe for the v1 memory contract.
//
// Reproduces every conformance claim in GENERATOR-DECISION.md (this
// directory). It is a plain .mjs module, NOT a *.test.ts, on purpose:
// vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts, so a test file placed here would silently
// never run. Run it explicitly:
//
//   npm run build && node memory-contract/v1/tests/probe-generator-2020-12.mjs
//
// The build step is required because the probe reads the REAL request schemas
// from dist/tools/*.js (the surface is authored in TypeScript). Exit code 0
// means the chosen generation path produces metaschema-valid draft-2020-12 for
// all 23 inventoried tools plus the hard constructs; nonzero means it does not.

import { z } from 'zod';
import * as z4 from 'zod/v4';
import { zodToJsonSchema } from 'zod-to-json-schema';
import Ajv2020 from 'ajv/dist/2020.js';
import { postprocessTo2020_12, DIALECT_2020_12 } from './postprocess-2020-12.mjs';

// NOTE for the contract:generate wiring: zod-to-json-schema@3.25.1 resolves
// today as a TRANSITIVE dependency (via the MCP SDK), not a declared one. It
// must be promoted to a direct dependency in package.json before
// contract:generate depends on it. This task's write scope is
// memory-contract/v1/tests/ only, so the promotion is not done here.

const DIST = '../../../dist/tools';

// The base emit configuration the decision note selects. Callers of the
// generator must use exactly this, then post-process.
const BASE_EMIT = { target: 'jsonSchema7', definitionPath: '$defs' };

const ajv = new Ajv2020({ strict: false, validateSchema: true });

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  [FAIL] ${msg}`); };
const pass = (msg) => { console.log(`  [OK] ${msg}`); };

/** Validate a schema document against the draft-2020-12 metaschema. */
function conforms(doc) {
  const ok = ajv.validateSchema(doc);
  return { ok, errors: ok ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) };
}

function emit(schema, opts = {}) {
  return zodToJsonSchema(schema, { ...BASE_EMIT, ...opts });
}

// ---------------------------------------------------------------------------
// Section 1 -- candidate A: zod-native z.toJSONSchema against the real surface
// ---------------------------------------------------------------------------
async function probeNativeAgainstV3() {
  console.log('\n1. zod native (zod/v4 toJSONSchema) vs the v3-authored surface');
  const { kbCaptureSchema } = await import(`${DIST}/kb-capture.js`);
  try {
    z4.toJSONSchema(kbCaptureSchema, { target: 'draft-2020-12' });
    fail('native accepted a v3 schema -- the decision note is stale, re-run the bake-off');
  } catch (err) {
    pass(`native rejects the v3-authored kbCaptureSchema: ${err.constructor.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Section 2 -- candidate A on v4 re-declarations, for the v2 migration case
// ---------------------------------------------------------------------------
function probeNativeOnV4Redeclarations() {
  console.log('\n2. zod native on v4 RE-DECLARATIONS (migration reference, not today\'s path)');
  const cases = {
    'discriminated union': z4.discriminatedUnion('audn_decision', [
      z4.object({ audn_decision: z4.literal('add'), id: z4.string() }),
      z4.object({ audn_decision: z4.literal('none') }),
    ]),
    'closed enum': z4.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']),
    'optional vs nullable': z4.object({ a: z4.string().optional(), b: z4.string().nullable() }),
    'exclusive numeric bound': z4.object({ top: z4.number().int().positive() }),
  };
  for (const [label, schema] of Object.entries(cases)) {
    let doc;
    try {
      doc = z4.toJSONSchema(schema, { target: 'draft-2020-12' });
    } catch (err) {
      console.log(`  [INFO] native could not emit ${label}: ${err.message}`);
      continue;
    }
    const { ok, errors } = conforms(doc);
    const dialect = doc.$schema === DIALECT_2020_12 ? 'declares 2020-12' : `dialect=${doc.$schema}`;
    console.log(`  [INFO] ${label}: metaschema-valid=${ok} ${dialect} ${errors.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Section 3 -- the two zod-to-json-schema targets, compared
// ---------------------------------------------------------------------------
function probeTargetRegression() {
  console.log('\n3. zod-to-json-schema targets: jsonSchema2020-12 is a regression vs jsonSchema7');
  const s = z.object({ top: z.number().int().positive().optional() });
  const d7 = zodToJsonSchema(s, { target: 'jsonSchema7' });
  const d2020 = zodToJsonSchema(s, { target: 'jsonSchema2020-12' });

  if (d7.$schema && !d2020.$schema) {
    pass("target 'jsonSchema2020-12' emits NO $schema at all, while 'jsonSchema7' does");
  } else {
    fail('$schema emission differs from the recorded finding');
  }
  const boundIs2020 = d2020.properties.top.exclusiveMinimum;
  const boundIs7 = d7.properties.top.exclusiveMinimum;
  if (boundIs2020 === true && boundIs7 === 0) {
    pass("target 'jsonSchema2020-12' emits the draft-04 boolean exclusiveMinimum; 'jsonSchema7' emits the numeric 2020-12 form");
  } else {
    fail(`exclusive-bound finding is stale: 2020-12 target gave ${JSON.stringify(boundIs2020)}, draft-07 target gave ${JSON.stringify(boundIs7)}`);
  }
  // The boolean form is not merely ugly: the metaschema rejects it.
  const boolDoc = { $schema: DIALECT_2020_12, ...d2020 };
  if (!conforms(boolDoc).ok) {
    pass('the draft-2020-12 metaschema REJECTS the boolean-form output');
  } else {
    fail('metaschema accepted the boolean form -- evidence for the fallback path is gone');
  }
}

// ---------------------------------------------------------------------------
// Section 4 -- the hard constructs, on the chosen path
// ---------------------------------------------------------------------------
function probeHardConstructs() {
  console.log('\n4. hard constructs on the chosen path (jsonSchema7 emit + postprocess)');

  // 4a. Discriminated union -- AUDN capture outcome, shaped from INVENTORY.md
  // section 2.1 (kb_capture returns {id, audn_decision, confidence_clamped}).
  const audn = z.discriminatedUnion('audn_decision', [
    z.object({ audn_decision: z.literal('add'), id: z.string() }),
    z.object({ audn_decision: z.literal('update'), id: z.string(), supersedes: z.string() }),
    z.object({ audn_decision: z.literal('flagged'), id: z.string(), pair: z.string() }),
    z.object({ audn_decision: z.literal('none') }),
  ]);
  const audnDoc = postprocessTo2020_12(emit(audn));
  const audnRes = conforms(audnDoc);
  if (audnRes.ok && Array.isArray(audnDoc.anyOf) && audnDoc.anyOf.length === 4) {
    pass('discriminated union -> 4-branch anyOf, metaschema-valid (discriminator keyword is DROPPED -- see the degradation table)');
  } else {
    fail(`discriminated union: valid=${audnRes.ok} ${audnRes.errors.join('; ')}`);
  }
  const branchConsts = audnDoc.anyOf.map((b) => b.properties.audn_decision.const);
  if (branchConsts.join(',') === 'add,update,flagged,none') {
    pass(`each branch pins its discriminant with const: ${branchConsts.join(', ')}`);
  } else {
    fail(`branch discriminants unexpected: ${branchConsts.join(', ')}`);
  }

  // 4b. Closed enums -- the criterion is "closed lists, never open strings".
  const enumCases = {
    confidence: z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']),
    scope: z.enum(['project', 'global']),
    direction: z.enum(['upstream', 'downstream']),
    'capture type': z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive']),
  };
  for (const [label, schema] of Object.entries(enumCases)) {
    const doc = postprocessTo2020_12(emit(schema));
    const closed = Array.isArray(doc.enum) && doc.enum.length === schema.options.length;
    const res = conforms(doc);
    if (closed && res.ok) pass(`enum ${label} -> closed list of ${doc.enum.length}: ${JSON.stringify(doc.enum)}`);
    else fail(`enum ${label} did not emit a closed list: ${JSON.stringify(doc)}`);
  }

  // 4c. optional vs nullable vs nullish -- must stay distinguishable.
  const optNull = z.object({
    opt: z.string().optional(),
    nul: z.string().nullable(),
    nullish: z.string().nullish(),
  });
  const onDoc = postprocessTo2020_12(emit(optNull));
  const optAbsent = !(onDoc.required ?? []).includes('opt');
  const nulRequired = (onDoc.required ?? []).includes('nul');
  const nulTyped = JSON.stringify(onDoc.properties.nul.type) === '["string","null"]';
  const nullishAbsent = !(onDoc.required ?? []).includes('nullish');
  if (optAbsent && nulRequired && nulTyped && nullishAbsent && conforms(onDoc).ok) {
    pass('optional -> absent from required; nullable -> required with type ["string","null"]; nullish -> both. Distinguishable.');
  } else {
    fail(`optional/nullable collapsed: ${JSON.stringify(onDoc)}`);
  }

  // 4d. Recursive / entry-reference shape -- a KB entry that refines another.
  const Entry = z.lazy(() => z.object({ id: z.string(), refines: Entry.optional() }));
  const recDoc = postprocessTo2020_12(emit(Entry, { name: 'v1-kb-entry' }));
  const recRes = conforms(recDoc);
  const selfRef = recDoc.$defs?.['v1-kb-entry']?.properties?.refines?.$ref;
  if (recRes.ok && selfRef === '#/$defs/v1-kb-entry') {
    pass('recursive entry-reference -> $defs anchor with a self $ref (#/$defs/v1-kb-entry), metaschema-valid');
  } else {
    fail(`recursive shape: valid=${recRes.ok} selfRef=${selfRef} ${recRes.errors.join('; ')}`);
  }

  // 4e. Tuple -- not present in today's surface, but it is the construct the
  // postprocess prefixItems fix exists for, so it is exercised rather than
  // left as dead code.
  const tupleRaw = emit(z.tuple([z.string(), z.number()]));
  if (!conforms({ ...tupleRaw, $schema: DIALECT_2020_12 }).ok) {
    pass('raw tuple emit (array-form items) is REJECTED by the 2020-12 metaschema');
  } else {
    fail('array-form items unexpectedly passed the metaschema');
  }
  const tupleDoc = postprocessTo2020_12(tupleRaw);
  if (conforms(tupleDoc).ok && Array.isArray(tupleDoc.prefixItems) && tupleDoc.items === false) {
    pass('postprocess converts it to prefixItems + items:false, metaschema-valid');
  } else {
    fail(`tuple postprocess: ${JSON.stringify(tupleDoc)}`);
  }
}

// ---------------------------------------------------------------------------
// Section 5 -- the postprocess module's determinism guarantees
// ---------------------------------------------------------------------------
function probeDeterminism() {
  console.log('\n5. postprocess determinism');
  const raw = emit(z.object({ top: z.number().int().positive(), name: z.string() }), { name: 'v1-thing' });
  const frozenInput = JSON.stringify(raw);
  const once = postprocessTo2020_12(raw);
  if (JSON.stringify(raw) === frozenInput) pass('input object is not mutated');
  else fail('postprocess mutated its input');

  const twice = postprocessTo2020_12(once);
  if (JSON.stringify(twice) === JSON.stringify(once)) pass('idempotent: f(f(x)) === f(x)');
  else fail('postprocess is not idempotent');

  const again = postprocessTo2020_12(emit(z.object({ top: z.number().int().positive(), name: z.string() }), { name: 'v1-thing' }));
  if (JSON.stringify(again) === JSON.stringify(once)) pass('byte-identical across runs for the same input');
  else fail('output is not stable across runs');

  if (Object.keys(once)[0] === '$schema' && once.$schema === DIALECT_2020_12) {
    pass('$schema is the first key and declares exactly draft-2020-12');
  } else {
    fail(`dialect declaration wrong: ${JSON.stringify(Object.keys(once).slice(0, 2))}`);
  }
}

// ---------------------------------------------------------------------------
// Section 6 -- the full inventoried surface: all 23 tools
// ---------------------------------------------------------------------------
const KB_MODULES = [
  ['kb_capture', 'kb-capture.js', 'kbCaptureSchema'],
  ['kb_invalidate', 'kb-invalidate.js', 'kbInvalidateSchema'],
  ['kb_context', 'kb-context.js', 'kbContextSchema'],
  ['kb_session_prime', 'kb-session-prime.js', 'kbSessionPrimeSchema'],
  ['kb_query', 'kb-query.js', 'kbQuerySchema'],
  ['kb_list', 'kb-list.js', 'kbListSchema'],
  ['kb_harvest', 'kb-harvest.js', 'kbHarvestSchema'],
  ['kb_promote', 'kb-promote.js', 'kbPromoteSchema'],
  ['kb_freshness_sweep', 'kb-freshness-sweep.js', 'kbFreshnessSweepSchema'],
  ['kb_import', 'kb-import.js', 'kbImportSchema'],
  ['kb_resolve_contradiction', 'kb-resolve-contradiction.js', 'kbResolveContradictionSchema'],
  ['kb_reconcile_prefilter', 'kb-reconcile-prefilter.js', 'kbReconcilePrefilterSchema'],
  ['kb_setup', 'kb-setup.js', 'kbSetupSchema'],
  ['kb_export', 'kb-export.js', 'kbExportSchema'],
  ['kb_stats', 'kb-stats.js', 'kbStatsSchema'],
  ['kb_feedback', 'kb-feedback.js', 'kbFeedbackSchema'],
];
const CODE_EXPORTS = [
  ['code_graph', 'codeGraphSchema'],
  ['code_impact', 'codeImpactSchema'],
  ['code_query', 'codeQuerySchema'],
  ['code_context', 'codeContextSchema'],
  ['code_map', 'codeMapSchema'],
  ['code_flow', 'codeFlowSchema'],
  ['code_tests', 'codeTestsSchema'],
];

async function probeWholeSurface() {
  console.log('\n6. the whole inventoried surface (16 kb_* + 7 code_* = 23 tools)');
  const entries = [];
  for (const [tool, file, exportName] of KB_MODULES) {
    const mod = await import(`${DIST}/${file}`);
    entries.push([tool, mod[exportName]]);
  }
  const code = await import(`${DIST}/code-intelligence.js`);
  for (const [tool, exportName] of CODE_EXPORTS) entries.push([tool, code[exportName]]);

  if (entries.length === 23) pass('23 request schemas loaded, matching the INVENTORY.md tool count');
  else fail(`expected 23 schemas, loaded ${entries.length}`);

  let rawBad = 0;
  let fixedBad = 0;
  for (const [tool, schema] of entries) {
    if (!schema) { fail(`${tool}: schema export missing from dist -- rebuild`); continue; }
    const raw = emit(schema, { name: `v1-${tool}` });
    if (!conforms({ ...raw, $schema: DIALECT_2020_12 }).ok) rawBad += 1;
    const fixed = postprocessTo2020_12(raw);
    const res = conforms(fixed);
    if (!res.ok) { fixedBad += 1; fail(`${tool}: ${res.errors.join('; ')}`); }
  }
  // rawBad counts documents that stay metaschema-INVALID even if you cheat the
  // dialect string in by hand, i.e. those needing a structural fix. Zero is the
  // expected answer for today's surface: every one of the 23 still needs the
  // postprocess for its DIALECT DECLARATION, since the draft-07 emit declares
  // draft-07, and the criterion is 2020-12 exactly.
  if (fixedBad === 0) pass(`all 23 tools emit metaschema-valid draft-2020-12 after postprocess (${rawBad} of 23 also needed a structural fix)`);

  // The single real-surface field that forces the fallback path.
  const codeMapRaw = zodToJsonSchema(code.codeMapSchema, { target: 'jsonSchema2020-12' });
  const bound = codeMapRaw.properties.top.exclusiveMinimum;
  if (bound === true) {
    pass("code_map.top (z.number().int().positive(), src/tools/code-intelligence.ts) is the real field that breaks the 2020-12 target: exclusiveMinimum=true");
  } else {
    fail(`code_map.top no longer reproduces the boolean bound (got ${JSON.stringify(bound)})`);
  }

  // Open-string fields that are closed enums by DESIGN at the handler, not the
  // schema. These must be x-invariant annotations, never "fixed" in the schema.
  const capture = postprocessTo2020_12(emit(entries.find(([t]) => t === 'kb_capture')[1]));
  if (capture.properties.role?.type === 'string' && !capture.properties.role.enum) {
    pass('kb_capture.role emits an OPEN string, as designed (the Author list is enforced in the handler) -- recorded as x-invariant INV-07');
  } else {
    fail('kb_capture.role shape changed; re-check the closed-enum claim in the note');
  }
  for (const field of ['type', 'confidence', 'scope']) {
    const prop = capture.properties[field];
    if (Array.isArray(prop?.enum)) pass(`kb_capture.${field} emits a closed enum of ${prop.enum.length}`);
    else fail(`kb_capture.${field} is not a closed enum: ${JSON.stringify(prop)}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('memory-contract/v1 generator bake-off probe');
  console.log(`base emit: zod-to-json-schema ${JSON.stringify(BASE_EMIT)} + postprocessTo2020_12`);
  await probeNativeAgainstV3();
  probeNativeOnV4Redeclarations();
  probeTargetRegression();
  probeHardConstructs();
  probeDeterminism();
  await probeWholeSurface();
  console.log(`\n${failures === 0 ? 'PROBE PASSED' : `PROBE FAILED (${failures} failing check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
