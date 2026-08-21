// contract:generate -- deterministic JSON Schema 2020-12 emit for every
// inventoried tool in the v1 memory contract (T1.2.2), plus (T1.2.3) one MCP
// binding definition per tool under bindings/mcp/.
//
// Wires the generation path decided and proven in
// memory-contract/v1/tests/GENERATOR-DECISION.md:
//
//   zod-to-json-schema@3.25.1 { target: 'jsonSchema7', definitionPath: '$defs' }
//   -> postprocessTo2020_12 (memory-contract/v1/tests/postprocess-2020-12.mjs)
//
// This script does not edit postprocess-2020-12.mjs or GENERATOR-DECISION.md
// (both are sole-owned by T1.2.1) -- it only imports and calls them. It also
// does not edit memory-contract/v1/tests/BINDING-SCHEME.md (T1.2.3, this
// task's own hand-authored artifact recording the binding naming/ref scheme)
// -- a hand-edited file must never live inside this script's generated
// output, so BINDING-SCHEME.md is read by humans, not by this script, and
// this script's --check mode never touches it.
//
// Usage:
//   npm run build && npm run contract:generate
//   npm run build && npm run contract:check     (--check mode, see below)
//
// Writes memory-contract/v1/schemas/<tool>.request.json and
// memory-contract/v1/schemas/<tool>.response.json for all 23 tools (16 kb_*
// + 7 code_*, per INVENTORY.md section 1), plus one
// memory-contract/v1/bindings/mcp/<tool>.json binding definition per tool
// (T1.2.3), each ref-ing its own request/response schema pair by $id rather
// than inlining any shape. Every emitted schema document is validated against
// the draft-2020-12 metaschema before being written; the script fails loudly
// (nonzero exit) rather than commit an invalid file.
//
// --check mode: pass --check to compute every document in-memory (schemas
// AND bindings) without writing anything, and compare byte-for-byte against
// what is already committed. Exits nonzero and prints every mismatch (missing
// file, content diff, or an extra/untracked file under schemas/ or
// bindings/mcp/) -- this is the three-way parity mechanism the acceptance
// criteria require (registered tool <-> exactly one bindings/mcp definition
// <-> one request/response schema pair), demonstrable in one command.
// tests/memory-contract-parity.test.ts (T1.5.1) wraps this mode; it is not
// created by this task.
//
// Determinism: this script performs no Date/Math.random/env reads that feed
// into output content, and both the request source (the real zod schemas
// under dist/tools/, built from src/tools/) and the response source
// (response-schemas.mjs, authored in this same directory) are static. Running
// `npm run contract:generate` twice therefore produces a byte-identical
// schemas/ and bindings/mcp/ directory -- `git diff --stat memory-contract/v1`
// is zero after a second run, which is the idempotency criterion this task's
// acceptance depends on.

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
const BINDINGS_MCP_DIR = path.join(__dirname, 'bindings', 'mcp');

// --check: compute and compare, write nothing. See BINDING-SCHEME.md for the
// full contract this mode enforces.
const CHECK_MODE = process.argv.includes('--check');

// $id base per README.md's "$id URI Base Decision" -- repo-rooted, anchored
// at main, so a schema consumer can resolve the definition straight off
// GitHub. The base is fixed here, never derived from a generator default.
const ID_BASE = 'https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/schemas';
// Same decision, applied to the bindings/mcp layer this task adds (T1.2.3).
// Recorded in memory-contract/v1/tests/BINDING-SCHEME.md.
const BINDINGS_ID_BASE = 'https://github.com/Apra-Labs/apra-fleet/blob/main/memory-contract/v1/bindings/mcp';

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

// Registration description text, byte-exact from src/services/tool-registry.ts
// (verified against INVENTORY.md Appendix A, which states it was "captured
// from the runtime registration dump so it is byte-exact"). Reproduced here
// rather than imported so this script has no runtime dependency on
// tool-registry.ts -- same rationale as KB_MODULES/CODE_EXPORTS above. This is
// the "registration description text captured in INVENTORY.md" this task's
// binding definitions embed per its acceptance criteria.
const DESCRIPTIONS = {
  kb_capture:
    'Capture a learning, fact, or file summary into the knowledge bank. Confidence is capped at INFERRED: any CONFIRMED passed here is downgraded to INFERRED (result carries confidence_clamped:true). CONFIRMED is minted ONLY via kb_promote. Returns {id, audn_decision, confidence_clamped}. audn_decision: add=new entry, none=duplicate skipped, update=same-topic predecessor linked (refines; both entries stay live), flagged=contradiction flagged for review. Pass supersedes:<id> to retire that entry instead (only takes effect if AUDN independently matched it).',
  kb_invalidate:
    'Mark context-cache entries stale for the given file paths. Call after modifying files to ensure the KB reflects the current state.',
  kb_context:
    'Check freshness of files against the knowledge bank. Returns {fresh, stale, missing} -- fresh files can be skipped, stale/missing files must be re-read.',
  kb_session_prime:
    'Prime a session with KB context. Returns session_warm status, stale files needing re-read, top KB entries, and recommended GitNexus calls.',
  kb_query:
    'Two-level knowledge bank search. L1: FTS5 on title+summary (up to 20 results). L2: full content for top 5 hits (max 800 tokens each). Excludes stale/superseded by default. Optional tag filter (exact match) ANDs alongside other filters without touching FTS/OR-join logic, and may be used alone (no query) to list all entries carrying the tag. Pass flagged_only: true to list all contradiction-flagged entry pairs for resolution. Pass expand_related: true to also receive related_claims -- entries joined to the top hits by a refines or contradiction_of edge. Those record the KB own judgements about its contents (there is a newer framing of this; something disputes this) and cannot be reached by a text match. shares_file/shares_symbol edges are deliberately not traversed, since FTS over those same fields already surfaces them. Default false, in which case related_claims is absent and the result shape is unchanged.',
  kb_list:
    'List KB entries by confidence/type/module/symbol/tag -- audit the CONFIRMED set (or any tier) without touching FTS ranking or use_count telemetry. Excludes superseded/stale entries. Returns {results, total} with each entry as {id, type, confidence, title, summary, symbols, source_files}.',
  kb_harvest:
    'Scan a session transcript for learnings and capture them into the KB. Returns {entries_captured, entries_updated, entries_skipped}. Extracted entries are UNVERIFIED and author=harvest, source=harvest.',
  kb_promote:
    'Upgrade KB entry confidence: UNVERIFIED -> INFERRED -> CONFIRMED. Appends promotion note to content as evidence trail. CONFIRMED entries are no-op.',
  kb_freshness_sweep:
    'Bounded full-KB bidirectional freshness sweep: re-hash every entry that has a stored per-file basis against the CURRENT worktree, mark mismatches stale, and revive stale entries whose full basis matches again (superseded, feedback-downvoted, and invalidated entries stay retired). This is the branch-switch revival surface kb_session_prime cannot be (prime excludes stale entries). Returns {checked, staled, unstaled}.',
  kb_import:
    'Import a merged bible (.fleet/kb-canonical.json) into the warm local KB -- the post-merge write path (the prime-time cold-seed is output-only). Reads the repo-resolved bible, or an explicit --path file. Each entry routes through the AUDN choke point (duplicate -> skipped, refinement -> linked, contradiction -> flagged); non-directive entries KEEP their bible confidence (the bible is a git-reviewed, human-merged artifact), stamped source="import"; type="user-directive" entries are FORCED to pending proposals (never active -- a bible cannot smuggle an active directive). Idempotent (re-import of the same bible adds nothing). Runs a freshness sweep after import so entries whose basis does not match this worktree are staled. Accepts BOTH bible shapes: a legacy bare JSON array and the v2 {version, provenance:{commit, branch, entry_count}, entries} envelope. Entries with no source_files, or citing files absent from this worktree, are REJECTED (an entry with no checkable basis can never be staled, so nothing could falsify it) -- re-importing a legacy bible deliberately drops those. Returns {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}. Pass skip_sweep: true to skip the post-import freshness sweep -- the sweep re-judges EVERY entry against the given worktree, which is right for a deliberate audit but wrong for a routine warm-the-KB import (it mass-stales entries merely because unrelated files moved on, which in turn empties the promotion candidates kb_list returns). Accepts `repo_path` as an alias for `repo`, matching every other kb_* tool (the apra-fleet-src input-name trap: zod strips an unknown key silently, so the mismatched name resolved against the server cwd instead of erroring). TRUST BOUNDARY: importing the repo-resolved bible is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust, equivalent in power to kb_promote. Directives are quarantined either way; activation stays CLI-only.',
  kb_resolve_contradiction:
    'Resolve a KB contradiction pair: {winnerId, loserId, evidence}. The SINGLE write path for reconcile resolutions (used by kb_reconcile_prefilter and the reconciler agent alike). Winner ends confidence=CONFIRMED with the evidence note appended and both flag fields cleared (flagged_for_review + contradiction_of); stale is cleared ONLY if the D2 un-stale predicate holds on the post-flag-clear row (so a downvoted or invalidated winner still stays retired -- it wins the contradiction, not its reputation). Loser ends superseded_at=now + stale=1 + flag cleared, never deleted. REFUSES (throws, writes nothing) when either id is missing, either entry is already superseded, the ids do not form a genuinely linked contradiction pair, or the pair involves an ACTIVE user-directive.',
  kb_reconcile_prefilter:
    'Mechanical hash-basis prefilter over all flagged contradiction pairs (including stale members -- see flaggedPairs liveness contract). Re-hashes both sides of each pair against the CURRENT worktree: exactly one side fully matching wins mechanically via kb_resolve_contradiction (evidence "hash-basis match on merged worktree"); both match, both mismatch, or an empty/missing basis on either side leaves the pair for the reconciler agent. Pairs involving an ACTIVE user-directive are never touched. Returns {pairs, resolved, left_for_agent, skipped_directive}. Run after kb_import + kb_freshness_sweep, before dispatching the reconciler agent.',
  kb_setup:
    'Set up KB: install git post-commit hook, write provider config, store remote credentials encrypted. Run once per repo.',
  kb_export:
    'Export all CONFIRMED, non-superseded, non-stale KB entries to a canonical bible file (stable field set, deterministic id order, ASCII-safe). scope="project" (default): reads the project KB, writes <repo>/.fleet/kb-canonical.json. scope="global": reads the GLOBAL KB, writes <repo>/.fleet/kb-canonical-global.json (in practice the apra-fleet platform repo, committed there so the installer can distribute it to every project on the machine -- D8/F9). Run after kb_promote so the canonical set stays current. F6a: the tool itself auto-commits the bible file (pathspec-only, identity pm-kb) when the repo is a git repo and the content changed -- this is code, not agent discretion, so no manual git step is needed, and this applies to the global file too. Non-fatal on any git failure; push is not automatic. Writes the v2 format: {version:2, provenance:{commit, branch, entry_count}, entries:[...]}, recording the commit the entries were verified against (a commit, not a timestamp, so re-exports stay diff-free when nothing changed). An export whose entry set is unchanged rewrites nothing. Auto-commit defaults to ON (USER DIRECTIVE 2026-08-11 -- an export left uncommitted is knowledge nobody else ever sees): set FLEET_DIR/knowledge/config.json { bible: { autoCommit: false } } to opt out. A malformed config disables it.',
  kb_stats:
    'Read-only KB health aggregation: totals by confidence/type, stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, canonical-bible presence/drift, and optional per-symbol coverage. Never bumps use_count/last_accessed (kb_list pattern). Bible drift is visibility for the machine that owns the KB -- CI cannot see the local kb.sqlite, so there is no CI gate on it.',
  kb_feedback:
    'Downvote a KB entry that proved wrong in practice: { id, reason, role? }. Marks the entry stale=1 + flagged_for_review=1 and appends an ASCII feedback note "[feedback <ISO>] <validated-role>: <reason>" (CONTENT_CAP respected). NEVER deletes and NEVER touches confidence -- a downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged; the human resolves it in kb-review, this tool only flags it for that review. Exception: an ACTIVE user-directive is flagged for review but NOT staled (directives outrank agent experience -- the human decides); a pending directive proposal stales normally.',
  code_graph:
    'Trace the call graph for a symbol. Returns callers and callees across the codebase. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.',
  code_impact:
    'Find what is affected by changes to a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.',
  code_query:
    'Search the codebase for symbols, patterns, or concepts using natural language or code patterns. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.',
  code_context:
    'Get callers, callees, and execution flows for a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.',
  code_map:
    'Get the architectural map of a repository: module communities with their key symbols and files, ranked by size. Prefer this over directory listings or file reads when orienting in an unfamiliar codebase -- the answer is pre-indexed.',
  code_flow:
    'Find process flows (entry -> steps -> exit) matching a name or endpoints. Prefer this over manually tracing call chains across files -- the flows are pre-indexed.',
  code_tests:
    'Find the test files and test functions that exercise a symbol (transitive callers, depth 2). Use this to run targeted tests for the code you changed instead of the full suite. Prefer this over Grep for test discovery -- the call graph is pre-indexed.',
};

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
  return emit(SCHEMAS_DIR, `${tool}.${kind}.json`, doc);
}

/**
 * Build one MCP binding definition for a tool (T1.2.3). Naming and ref scheme
 * are hand-recorded in memory-contract/v1/tests/BINDING-SCHEME.md -- this
 * function is the implementation of that recorded decision, not a second
 * place the decision is made. Fixed key order ($id, name, description,
 * request, response) keeps two consecutive runs byte-identical.
 *
 * Deliberately NOT itself declared as a JSON Schema document ($schema is
 * omitted): a binding definition does not validate instances, it is a
 * manifest that REFERENCES the two schema documents that do, so stamping a
 * dialect on it would misstate what it is (see BINDING-SCHEME.md).
 */
function buildBindingDoc(tool) {
  const description = DESCRIPTIONS[tool];
  if (!description) {
    throw new Error(`${tool}: no registration description recorded in DESCRIPTIONS -- add it before generating`);
  }
  return {
    $id: `${BINDINGS_ID_BASE}/${tool}.json#`,
    name: tool,
    description,
    request: { $ref: `${ID_BASE}/${tool}.request.json#` },
    response: { $ref: `${ID_BASE}/${tool}.response.json#` },
  };
}

function writeBindingDoc(tool, doc) {
  return emit(BINDINGS_MCP_DIR, `${tool}.json`, doc);
}

// --- write-or-check primitive -----------------------------------------------
//
// In normal mode, emit() writes the file. In --check mode, it writes nothing
// and instead records a mismatch (missing file, or content that differs byte-
// for-byte from what generation would produce now) into MISMATCHES, so main()
// can report every mismatch at once and exit nonzero -- rather than stopping
// at the first one.
const MISMATCHES = [];

function emit(dir, filename, doc) {
  const filePath = path.join(dir, filename);
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  if (CHECK_MODE) {
    let existing = null;
    try {
      existing = readFileSync(filePath, 'utf8');
    } catch {
      existing = null;
    }
    if (existing === null) {
      MISMATCHES.push(`${filePath}: MISSING (would be created)`);
    } else if (existing !== content) {
      MISMATCHES.push(`${filePath}: CONTENT DIFFERS from what generation produces now`);
    }
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
}

/**
 * Parity check (--check mode only): every file actually present under `dir`
 * must be one of `expectedNames` -- an extra/stray file is as much a parity
 * violation as a missing one (acceptance: "no extras, no gaps").
 */
function checkNoExtraFiles(dir, expectedNames) {
  let present;
  try {
    present = readdirSync(dir);
  } catch {
    present = [];
  }
  const expected = new Set(expectedNames);
  for (const name of present) {
    if (name === '.gitkeep') continue;
    if (!expected.has(name)) {
      MISMATCHES.push(`${path.join(dir, name)}: EXTRA (not produced by generation, no matching tool)`);
    }
  }
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
  const expectedSchemaFiles = [];
  const expectedBindingFiles = [];
  for (const [tool, zodRequestSchema] of entries) {
    if (!zodRequestSchema) {
      throw new Error(`${tool}: request schema export missing from dist/tools -- run "npm run build" first`);
    }
    const requestDoc = buildDoc(tool, 'request', zodRequestSchema);
    writeDoc(tool, 'request', requestDoc);
    expectedSchemaFiles.push(`${tool}.request.json`);
    written += 1;

    const responseDoc = buildDoc(tool, 'response', responseSchema(tool));
    writeDoc(tool, 'response', responseDoc);
    expectedSchemaFiles.push(`${tool}.response.json`);
    written += 1;

    // T1.2.3: one MCP binding definition per tool, ref-ing the pair above.
    const bindingDoc = buildBindingDoc(tool);
    writeBindingDoc(tool, bindingDoc);
    expectedBindingFiles.push(`${tool}.json`);
    written += 1;
  }

  if (CHECK_MODE) {
    // Three-way parity (acceptance criteria): registered tool <-> exactly one
    // bindings/mcp definition <-> one request/response schema pair. `entries`
    // IS the registered-tool roster (same one EXPECTED_TOOL_COUNT already
    // validated above), so "no extras, no gaps" against expectedSchemaFiles/
    // expectedBindingFiles below is the whole check.
    checkNoExtraFiles(SCHEMAS_DIR, expectedSchemaFiles);
    checkNoExtraFiles(BINDINGS_MCP_DIR, expectedBindingFiles);

    if (MISMATCHES.length > 0) {
      console.error(`contract:generate --check: ${MISMATCHES.length} mismatch(es):`);
      for (const m of MISMATCHES) console.error(`  - ${m}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `contract:generate --check: OK -- ${entries.length} tools, ${expectedSchemaFiles.length} schema files, ` +
        `${expectedBindingFiles.length} binding files, all match.`,
    );
    return;
  }

  console.log(
    `contract:generate: wrote ${written} files (${entries.length} tools x [request, response, binding]) -- ` +
      `${expectedSchemaFiles.length} schema files to ${SCHEMAS_DIR}, ${expectedBindingFiles.length} binding files to ${BINDINGS_MCP_DIR}.`,
  );
}

main().catch((err) => {
  console.error('contract:generate failed:', err);
  process.exitCode = 1;
});
