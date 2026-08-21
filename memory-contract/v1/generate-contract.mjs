// contract:generate -- deterministic JSON Schema 2020-12 emit for every
// inventoried tool in the v1 memory contract (T1.2.2).
//
// Wires the generation path decided and proven in
// memory-contract/v1/tests/GENERATOR-DECISION.md:
//
//   zod-to-json-schema@3.25.1 { target: 'jsonSchema7', definitionPath: '$defs' }
//   -> postprocessTo2020_12 (memory-contract/v1/tests/postprocess-2020-12.mjs)
//
// This script does not edit postprocess-2020-12.mjs or GENERATOR-DECISION.md
// (both are sole-owned by T1.2.1) -- it only imports and calls them.
//
// Usage:
//   npm run build && npm run contract:generate
//
// Writes memory-contract/v1/schemas/<tool>.request.json and
// memory-contract/v1/schemas/<tool>.response.json for all 23 tools (16 kb_*
// + 7 code_*, per INVENTORY.md section 1). Every emitted document is
// validated against the draft-2020-12 metaschema before being written; the
// script fails loudly (nonzero exit) rather than commit an invalid file.
//
// Determinism: this script performs no Date/Math.random/env reads that feed
// into output content, and both the request source (the real zod schemas
// under dist/tools/, built from src/tools/) and the response source
// (response-schemas.mjs, authored in this same directory) are static. Running
// `npm run contract:generate` twice therefore produces a byte-identical
// schemas/ directory -- `git diff --stat memory-contract/v1/schemas` is zero
// after a second run, which is the idempotency criterion this task's
// acceptance depends on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import Ajv2020 from 'ajv/dist/2020.js';
import { postprocessTo2020_12 } from './tests/postprocess-2020-12.mjs';
import { responseSchema } from './response-schemas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_TOOLS_DIR = path.join(REPO_ROOT, 'dist', 'tools');
const SCHEMAS_DIR = path.join(__dirname, 'schemas');

// $id base per README.md's "$id URI Base Decision" -- repo-rooted, anchored
// at main, so a schema consumer can resolve the definition straight off
// GitHub. The base is fixed here, never derived from a generator default.
const ID_BASE = 'https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas';

// Same 23-tool roster the probe in tests/probe-generator-2020-12.mjs reads,
// reproduced here rather than imported so this script has no runtime
// dependency on a file owned by T1.2.1. Any drift between the two lists is
// itself a signal INVENTORY.md's tool count (section 1) needs re-checking.
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
const EXPECTED_TOOL_COUNT = KB_MODULES.length + CODE_EXPORTS.length; // 23, per INVENTORY.md section 1

// x-invariant stamping (GENERATOR-DECISION.md section 4): this is the "only
// code that knows which tool a given document came from", so it is this
// script's job -- not postprocess-2020-12.mjs's -- to apply the id -> tool
// mapping from the Applies-to column of that table.
const REQUEST_INVARIANTS = {
  kb_capture: ['INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-07'],
  kb_import: ['INV-05'],
  kb_stats: ['INV-05'],
  kb_setup: ['INV-06'],
  // INV-08's second half is a request-side guard: "at least one of query, tag
  // or flagged_only MUST be supplied; the handler throws when all three are
  // absent" (src/tools/kb-query.ts). Nothing in the zod schema can express
  // that (D5: no .refine/.superRefine/.transform anywhere in the surface), so
  // it is annotated on the request document too, not just the response.
  kb_query: ['INV-08'],
};
// INV-09 ("no tool declares a response zod schema; shapes are OBSERVED, not
// authoritative") applies to every response document. INV-08 (kb_query's two
// mutually exclusive response shapes) additionally applies to kb_query's.
const RESPONSE_INVARIANTS_EXTRA = { kb_query: ['INV-08'] };

const ajv = new Ajv2020({ strict: false, validateSchema: true });

function validateOrThrow(tool, kind, doc) {
  const ok = ajv.validateSchema(doc);
  if (!ok) {
    const errors = (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw new Error(`${tool}.${kind}: emitted document is not metaschema-valid draft-2020-12: ${errors}`);
  }
}

/**
 * Emit one schema document: zod -> jsonSchema7+$defs -> postprocess to
 * 2020-12 -> stamp $id and x-invariant -> validate -> stringify.
 *
 * $defs dedupe, stated explicitly rather than left implicit: zod-to-json-
 * schema's `definitionPath: '$defs'` factors a sub-schema into `$defs` when
 * the SAME zod object (by reference) is visited more than once within one
 * `zodToJsonSchema()` call -- e.g. the recursive-entry case proved in
 * GENERATOR-DECISION.md section 2. `kbScopeFields` (repo_path/repo_remote_url,
 * INVENTORY.md 2.1's scope-field note), the one shape genuinely shared across
 * 15 of the 16 kb_* request schemas, is mixed in via OBJECT SPREAD at each
 * call site in src/tools/*.ts, not by re-using one shared zod object
 * reference. Spread produces 15 structurally-identical but reference-distinct
 * sub-schemas, so there is no single shared sub-schema for the dedupe
 * mechanism to find -- each tool's request document legitimately inlines its
 * own copy. This is a property of how the source schemas are authored, not a
 * gap in this generator: any tool whose zod schema DOES reference the same
 * sub-schema object more than once (recursive shapes, or a future refactor
 * that shares an object reference instead of spreading) is deduped into
 * $defs automatically, with no change needed here.
 */
function buildDoc(tool, kind, zodSchema) {
  const name = `v1-${tool}-${kind}`;
  const raw = zodToJsonSchema(zodSchema, { target: 'jsonSchema7', definitionPath: '$defs', name });
  const normalised = postprocessTo2020_12(raw);
  const { $schema, ...rest } = normalised;

  const invariants =
    kind === 'request'
      ? REQUEST_INVARIANTS[tool] ?? []
      : ['INV-09', ...(RESPONSE_INVARIANTS_EXTRA[tool] ?? [])];

  // Fixed key order: $schema, $id, [x-invariant], then the rest of the
  // postprocessed document (unchanged order) -- this is what keeps two
  // consecutive runs byte-identical.
  const doc = { $schema, $id: `${ID_BASE}/${tool}.${kind}.json#` };
  if (invariants.length > 0) doc['x-invariant'] = invariants;
  Object.assign(doc, rest);

  validateOrThrow(tool, kind, doc);
  return doc;
}

function writeDoc(tool, kind, doc) {
  mkdirSync(SCHEMAS_DIR, { recursive: true });
  const filePath = path.join(SCHEMAS_DIR, `${tool}.${kind}.json`);
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return filePath;
}

async function loadRequestSchemas() {
  const entries = [];
  for (const [tool, file, exportName] of KB_MODULES) {
    const modUrl = pathToFileURL(path.join(DIST_TOOLS_DIR, file)).href;
    const mod = await import(modUrl);
    entries.push([tool, mod[exportName]]);
  }
  const codeUrl = pathToFileURL(path.join(DIST_TOOLS_DIR, 'code-intelligence.js')).href;
  const code = await import(codeUrl);
  for (const [tool, exportName] of CODE_EXPORTS) entries.push([tool, code[exportName]]);
  return entries;
}

async function main() {
  const entries = await loadRequestSchemas();
  if (entries.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `expected ${EXPECTED_TOOL_COUNT} tools per INVENTORY.md, loaded ${entries.length} -- ` +
        'did the tool roster change without updating this script and INVENTORY.md together?',
    );
  }

  let written = 0;
  for (const [tool, zodRequestSchema] of entries) {
    if (!zodRequestSchema) {
      throw new Error(`${tool}: request schema export missing from dist/tools -- run "npm run build" first`);
    }
    const requestDoc = buildDoc(tool, 'request', zodRequestSchema);
    writeDoc(tool, 'request', requestDoc);
    written += 1;

    const responseDoc = buildDoc(tool, 'response', responseSchema(tool));
    writeDoc(tool, 'response', responseDoc);
    written += 1;
  }

  console.log(`contract:generate: wrote ${written} schema files (${entries.length} tools x 2) to ${SCHEMAS_DIR}`);
}

main().catch((err) => {
  console.error('contract:generate failed:', err);
  process.exitCode = 1;
});
