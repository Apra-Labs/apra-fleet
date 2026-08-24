// T1.4.2: provider-parameterized round-trip validator for memory-contract/v1.
//
// WHAT THIS IS
// ------------
// A harness MODULE. It takes a provider as a PARAMETER and drives the whole
// recorded fixture corpus (memory-contract/v1/fixtures/**) through it LIVE,
// asserting three things per case:
//
//   1. the request validates against schemas/<tool>.request.json BEFORE it is
//      dispatched;
//   2. the LIVE response validates against schemas/<tool>.response.json;
//   3. an invalid/refusal fixture fails with the exact taxonomy.json code the
//      fixture documents, never a generic error.
//
// It stands up NO server and imports NOTHING from src/ or dist/. The only
// imports are node builtins, ajv, and this contract's own JSON/mjs artifacts.
// That is deliberate: the sqlite adapter (the thing that knows about
// registerAllTools) lives in the discovered entry point
// tests/memory-contract-roundtrip.test.ts, so T8/PoC-1 can hand this module an
// HTTP provider with no edit here at all.
//
// WHERE THE ENTRY POINT LIVES (do not move it back)
// -------------------------------------------------
// vitest.config.ts include is ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'].
// A *.test.ts under memory-contract/v1/tests/ is NOT discovered and would
// silently never run. So this file is a plain .mjs module (imported, never
// discovered) and the discovered runner is tests/memory-contract-roundtrip.test.ts.
//
// THE PROVIDER CONTRACT (what T8's HTTP adapter must implement)
// -------------------------------------------------------------
//   {
//     name: string,                        // 'sqlite' | 'http' | ...
//     slug: string,                        // project slug the calls resolve to
//     repoPath: string,                    // repo root the calls are anchored at
//     prepareEnvironment(env)              // materialise ENVIRONMENT, return
//        -> { substitutions: { paths, literals } },
//     applySetup(ops) -> Promise<void>,    // execute declared precondition ops
//     call(tool, request) -> Promise<envelope>,   // resolves with the wrapTool
//                                          // envelope, or REJECTS for a thrown
//                                          // refusal
//   }
//
// Provider identity is keyed on the (slug, repoPath) PAIR, not on the slug
// alone (src/services/knowledge/kb-providers.ts: `_providers` is a Map keyed by
// providerKey(slug, repoPath), NUL-joined). So this harness records and reports
// the pair it actually exercised, and the entry point asserts the pair is
// load-bearing with a case that would pass if keying were slug-only.
//
// WHY THE HARNESS -- NOT THE PROVIDER -- OWNS NO FILESYSTEM WRITES
// ----------------------------------------------------------------
// Several refusal fixtures need a precondition on the repo the provider serves
// (a malformed bible file, a deleted basis file). Under an HTTP provider that
// repo lives on the SERVER's disk, which this module cannot touch. So the
// preconditions are declared abstractly (SCENARIO[].setup) and executed by the
// provider's applySetup(); the harness never calls fs.writeFileSync itself.
//
// `parsed` IS THE CONTRACT'S OWN READING, NOT A WORKAROUND
// --------------------------------------------------------
// INVENTORY.md section 3: "the generated response schema is the text envelope
// PLUS the documented parsed-body object". The wire NEVER carries a `parsed`
// key -- every handler JSON-stringifies its body into a text content block --
// so decoding it is the CONSUMER's job, and this harness is that consumer. It
// validates `{...envelope, parsed: JSON.parse(payloadBlock.text)}`. This is the
// resolution of the known finding that a raw recorded envelope fails its own
// response schema: the raw envelope was never the thing the schema describes.
// Response schemas are NOT edited to make this pass (they belong to T1.2.2 /
// T1.3.x), and a text block that does not parse is a loud failure, never a skip.
// Recorded in tests/DEGRADATION.md as an entry in its own right.
//
// SCENARIO ORDERING IS DUPLICATED FROM record-fixtures.mjs ON PURPOSE
// -------------------------------------------------------------------
// The corpus is a stateful scenario (kb_promote needs an id minted by an
// earlier kb_capture; kb_promote/refusal-superseded needs an entry a prior
// kb_resolve_contradiction retired). Fixture files record neither their order
// nor those cross-call dependencies. record-fixtures.mjs is T1.4.1's recorder
// and is not refactored here -- breaking the recorder to DRY up an ordering
// list is a bad trade. Instead SCENARIO below restates the order explicitly,
// with `derive` naming exactly which earlier step each id comes from, and
// fails loudly when a named id is absent. Ids are never auto-guessed by
// scanning for UUID-shaped strings: a scan that silently finds nothing is the
// false-green this harness exists to prevent. A coverage check asserts SCENARIO
// consumes every fixture file on disk and covers the full generator roster, so
// dropping a case from the table cannot go green either.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = path.resolve(HERE, '..');
const FIXTURES_DIR = path.join(CONTRACT_DIR, 'fixtures');
const SCHEMAS_DIR = path.join(CONTRACT_DIR, 'schemas');
const BINDINGS_MCP_DIR = path.join(CONTRACT_DIR, 'bindings', 'mcp');
const TAXONOMY_PATH = path.join(CONTRACT_DIR, 'taxonomy.json');

// ---------------------------------------------------------------------------
// Recorded corpus constants. These are the sanitised placeholders and literal
// values record-fixtures.mjs baked into the committed fixtures; the provider
// maps each one onto its own live value.
// ---------------------------------------------------------------------------
export const PATH_PLACEHOLDERS = {
  SCRATCH_ROOT: '<SCRATCH_ROOT>',
  REPO_A: '<SCRATCH_REPO_A>',
  REPO_B: '<SCRATCH_REPO_B>',
  REPO_CODE: '<SCRATCH_REPO_CODE>',
};

export const RECORDED_REMOTE_A = 'https://example.test/memory-contract-fixtures-a.git';
export const RECORDED_REMOTE_B = 'https://example.test/memory-contract-fixtures-b.git';

/**
 * The scratch world the corpus was recorded against, declared so ANY provider
 * can rebuild it. Directory names matter: fixture requests embed
 * `<SCRATCH_ROOT>/repo-import-rejected` literally, so the provider must place
 * that repo at exactly that name under its own scratch root.
 */
export const ENVIRONMENT = {
  repos: [
    {
      key: 'A',
      dir: 'repo-a',
      placeholder: PATH_PLACEHOLDERS.REPO_A,
      // NOT a git repo on purpose: kb_setup then installs no real git hook and
      // kb_export's isGitRepo() check stays false, so no `git add`/`git commit`
      // ever runs (record-fixtures.mjs header, same reasoning).
      files: {
        'src/example.ts': 'export function exampleFn(x: number): number {\n  return x + 1;\n}\n',
        'src/helper.ts': 'export function helperBar(): void {\n  // placeholder\n}\n',
      },
    },
    { key: 'B', dir: 'repo-b', placeholder: PATH_PLACEHOLDERS.REPO_B, files: {} },
    { key: 'CODE', dir: 'repo-code', placeholder: PATH_PLACEHOLDERS.REPO_CODE, files: {} },
    { key: 'IMPORT_REJECTED', dir: 'repo-import-rejected', placeholder: null, files: {} },
  ],
  remotes: { A: RECORDED_REMOTE_A, B: RECORDED_REMOTE_B },
};

// ---------------------------------------------------------------------------
// Live assertions for the three fixtures whose evidence is a RESPONSE FIELD
// rather than a thrown error. Each mirrors the assertion record-fixtures.mjs
// made at recording time, so a silently-changed behaviour fails here too.
// ---------------------------------------------------------------------------
function assertImportRejected(parsed) {
  return typeof parsed?.rejected === 'number' && parsed.rejected >= 1
    ? null
    : `expected parsed.rejected >= 1, got ${JSON.stringify(parsed?.rejected)}`;
}

function assertConfidenceClamped(parsed) {
  return parsed?.confidence_clamped === true
    ? null
    : `expected parsed.confidence_clamped === true, got ${JSON.stringify(parsed?.confidence_clamped)}`;
}

function assertDirectiveQuarantined(parsed, ctx) {
  const liveId = ctx.ids.get('DIRECTIVE')?.live;
  const entry = (parsed?.results ?? []).find((r) => r?.id === liveId);
  if (!entry) return `no kb_list result carried the directive id ${liveId}`;
  return entry.confidence === 'UNVERIFIED'
    ? null
    : `directive entry confidence was ${JSON.stringify(entry.confidence)}, expected UNVERIFIED (quarantine)`;
}

/**
 * The recorded scenario, in record order. One entry per committed fixture.
 *
 *   tool / case  -- locate memory-contract/v1/fixtures/<tool>/<case>.json
 *   captureId    -- name the id this step's live response mints, for later steps
 *   derive       -- { requestField: 'CAPTURED_NAME' }, resolved from live ids
 *   setup        -- provider-executed preconditions, applied before dispatch
 *   assertParsed -- extra live evidence check (response-field refusals etc.)
 */
export const SCENARIO = [
  // -- PASS 1: happy path per tool ------------------------------------------
  { tool: 'kb_setup', case: 'happy' },
  { tool: 'kb_capture', case: 'happy', captureId: 'FOO' },
  { tool: 'kb_capture', case: 'happy-context-cache' },
  { tool: 'kb_context', case: 'happy' },
  { tool: 'kb_session_prime', case: 'happy' },
  { tool: 'kb_query', case: 'happy' },
  { tool: 'kb_list', case: 'happy' },
  { tool: 'kb_promote', case: 'happy', derive: { id: 'FOO' } },
  { tool: 'kb_stats', case: 'happy' },
  // kb_export writes .fleet/kb-canonical.json into repo A; the kb_import step
  // below reads it back through the path anchor, no derive needed.
  { tool: 'kb_export', case: 'happy' },
  { tool: 'kb_import', case: 'happy' },
  { tool: 'kb_freshness_sweep', case: 'happy' },
  { tool: 'kb_feedback', case: 'happy', derive: { id: 'FOO' } },
  { tool: 'kb_harvest', case: 'happy' },
  { tool: 'kb_capture', case: 'happy-contradiction-a', captureId: 'BROKEN' },
  { tool: 'kb_capture', case: 'happy-contradiction-b', captureId: 'FIXED' },
  { tool: 'kb_reconcile_prefilter', case: 'happy' },
  {
    tool: 'kb_resolve_contradiction',
    case: 'happy',
    derive: { winnerId: 'FIXED', loserId: 'BROKEN' },
  },
  { tool: 'kb_invalidate', case: 'happy' },
  { tool: 'code_graph', case: 'happy-no-index' },
  { tool: 'code_impact', case: 'happy-no-index' },
  { tool: 'code_query', case: 'happy-no-index' },
  { tool: 'code_context', case: 'happy-no-index' },
  { tool: 'code_map', case: 'happy-no-index' },
  { tool: 'code_flow', case: 'happy-no-index' },
  { tool: 'code_tests', case: 'happy-no-index' },

  // -- PASS 2: taxonomy-coded refusals + non-error outcomes -----------------
  { tool: 'kb_query', case: 'refusal-no-selector' },
  { tool: 'kb_context', case: 'refusal-path-traversal' },
  { tool: 'kb_export', case: 'refusal-repo-path-invalid' },
  { tool: 'kb_import', case: 'refusal-bible-not-found' },
  {
    tool: 'kb_import',
    case: 'refusal-bible-not-json',
    setup: [
      { op: 'write', repo: 'A', rel: '.fleet/not-json.json', contents: 'this is not valid JSON {{{' },
    ],
  },
  {
    tool: 'kb_import',
    case: 'refusal-bible-wrong-shape',
    setup: [
      {
        op: 'write',
        repo: 'A',
        rel: '.fleet/wrong-shape.json',
        contents: JSON.stringify({ not: 'an array or an entries envelope' }),
      },
    ],
  },
  { tool: 'kb_capture', case: 'refusal-no-basis' },
  { tool: 'kb_capture', case: 'refusal-basis-missing-files' },
  {
    tool: 'kb_import',
    case: 'refusal-import-entry-rejected',
    setup: [
      {
        op: 'write',
        repo: 'A',
        rel: '.fleet/bible-with-rejected-entry.json',
        contents: JSON.stringify([
          {
            id: 'fixture-rejected-entry-1',
            type: 'knowledge',
            title: 'A bible entry with no source_files',
            summary: 'This entry cites no basis and must be rejected on import.',
            confidence: 'INFERRED',
          },
        ]),
      },
    ],
    assertParsed: assertImportRejected,
  },
  { tool: 'kb_promote', case: 'refusal-reason-required', derive: { id: 'FOO' } },
  { tool: 'kb_promote', case: 'refusal-superseded', derive: { id: 'BROKEN' } },
  {
    tool: 'kb_capture',
    case: 'setup-for-basis-unresolved',
    captureId: 'BASIS_LOSS',
    setup: [
      { op: 'write', repo: 'A', rel: 'src/soon-to-be-deleted.ts', contents: 'export const placeholder = 1;\n' },
    ],
  },
  {
    tool: 'kb_promote',
    case: 'setup-first-promote-for-basis-unresolved',
    derive: { id: 'BASIS_LOSS' },
  },
  {
    tool: 'kb_promote',
    case: 'refusal-basis-unresolved',
    derive: { id: 'BASIS_LOSS' },
    setup: [{ op: 'delete', repo: 'A', rel: 'src/soon-to-be-deleted.ts' }],
  },
  { tool: 'kb_promote', case: 'refusal-entry-not-found' },
  { tool: 'kb_resolve_contradiction', case: 'refusal-resolve-missing-entry' },
  {
    tool: 'kb_resolve_contradiction',
    case: 'refusal-not-a-pair',
    derive: { winnerId: 'FOO', loserId: 'BASIS_LOSS' },
  },
  {
    tool: 'kb_resolve_contradiction',
    case: 'refusal-already-superseded',
    derive: { winnerId: 'FIXED', loserId: 'BROKEN' },
  },
  { tool: 'kb_capture', case: 'happy-user-directive-proposal', captureId: 'DIRECTIVE' },
  {
    tool: 'kb_list',
    case: 'observed-directive-quarantine',
    assertParsed: assertDirectiveQuarantined,
  },
  { tool: 'kb_promote', case: 'refusal-promote-directive', derive: { id: 'DIRECTIVE' } },
  { tool: 'kb_capture', case: 'non-error-confidence-clamped', assertParsed: assertConfidenceClamped },
];

// ---------------------------------------------------------------------------
// Corpus + contract artifact loading
// ---------------------------------------------------------------------------
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** Every committed fixture, as `<tool>/<case>` keys. */
export function listFixtureKeys() {
  const keys = [];
  for (const tool of fs.readdirSync(FIXTURES_DIR)) {
    const dir = path.join(FIXTURES_DIR, tool);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) keys.push(`${tool}/${file.slice(0, -'.json'.length)}`);
    }
  }
  return keys.sort();
}

export function loadFixture(tool, caseName) {
  return readJson(path.join(FIXTURES_DIR, tool, `${caseName}.json`));
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map();

/** Compile (once) the emitted 2020-12 schema for a tool's request or response. */
function validatorFor(tool, kind) {
  const key = `${tool}.${kind}`;
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(readJson(path.join(SCHEMAS_DIR, `${key}.json`)));
    compiled.set(key, validate);
  }
  return validate;
}

function ajvErrors(validate) {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

/** Flatten taxonomy.json's groups into `code -> { group, index, entry }`. */
function loadTaxonomyIndex() {
  const taxonomy = readJson(TAXONOMY_PATH);
  const byCode = new Map();
  for (const [group, body] of Object.entries(taxonomy.groups)) {
    body.codes.forEach((entry, index) => byCode.set(entry.code, { group, index, entry }));
  }
  return byCode;
}

/**
 * The names taxonomy.json disposes as non_error_outcomes -- documented results
 * that deliberately carry NO error code. A fixture's `observed_via` may name one
 * of these: it records what the call was observed to do, and a non-error outcome
 * (a clamp, a dedup skip, a directive quarantine) is a legitimate thing to
 * observe. `expected_error_code` may NOT name one -- that stays codes-only,
 * because a fixture asserting a refusal must assert a real refusal.
 */
function loadNonErrorOutcomeNames() {
  return new Set((readJson(TAXONOMY_PATH).non_error_outcomes ?? []).map((n) => n.name));
}

/**
 * The taxonomy codes a tool's MCP binding claims it can raise. bindings/mcp
 * stores them as `$ref` JSON pointers into taxonomy.json
 * (`#/groups/<group>/codes/<index>`), so they are resolved back to codes here.
 */
function bindingErrorCodes(tool, taxonomyIndex) {
  const binding = readJson(path.join(BINDINGS_MCP_DIR, `${tool}.json`));
  const codes = new Set();
  for (const ref of binding.errors ?? []) {
    const pointer = String(ref.$ref ?? '').split('#')[1] ?? '';
    const [, , group, , index] = pointer.split('/');
    for (const [code, meta] of taxonomyIndex) {
      if (meta.group === group && String(meta.index) === index) codes.add(code);
    }
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Placeholder rehydration (recorded corpus -> this provider's live world)
// ---------------------------------------------------------------------------
/**
 * Rebuild a recorded path string against a live anchor. Fixtures were recorded
 * on Windows, so their path tails use backslashes; splitting on BOTH separators
 * and re-joining with the local one is what keeps `<SCRATCH_REPO_A>\.fleet\
 * not-json.json` pointing at a real file on POSIX instead of degrading into one
 * weird filename (which would silently turn an E-BIBLE-NOT-JSON case into an
 * E-BIBLE-NOT-FOUND one -- a passing-looking wrong assertion).
 */
function joinRecordedPath(anchorValue, tail) {
  const segments = tail.split(/[\\/]+/).filter(Boolean);
  return segments.length ? path.join(anchorValue, ...segments) : anchorValue;
}

function rehydrateString(value, substitutions) {
  for (const [placeholder, live] of substitutions.pathPairs) {
    if (value === placeholder) return live;
    if (value.startsWith(placeholder)) return joinRecordedPath(live, value.slice(placeholder.length));
  }
  let out = value;
  for (const [recorded, live] of substitutions.literalPairs) out = out.split(recorded).join(live);
  return out;
}

function rehydrate(value, substitutions) {
  if (typeof value === 'string') return rehydrateString(value, substitutions);
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, substitutions));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrate(v, substitutions);
    return out;
  }
  return value;
}

/**
 * Map a LIVE message back onto the recorded vocabulary (placeholders, recorded
 * remote URLs, recorded ids) so a live refusal message can be compared to the
 * recorded one byte-for-byte. Path separators are normalised last because the
 * recording host and the running host need not agree on them.
 */
function normalizeMessage(message, substitutions, ctx) {
  let out = String(message);
  const reverse = [
    ...ctx.idPairs(),
    ...substitutions.pathPairs.map(([placeholder, live]) => [live, placeholder]),
    ...substitutions.literalPairs.map(([recorded, live]) => [live, recorded]),
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [live, recorded] of reverse) out = out.split(live).join(recorded);
  return out.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// Envelope decoding
// ---------------------------------------------------------------------------
/**
 * The payload block is the one wrapTool did NOT annotate: the optional
 * onboarding preamble and nudge suffix both carry `annotations`
 * (src/services/tool-registry.ts), the payload block never does.
 */
export function decodeEnvelope(envelope) {
  const blocks = (envelope?.content ?? []).filter((b) => b?.type === 'text');
  if (blocks.length === 0) throw new Error('response envelope carries no text content block');
  const payload = blocks.find((b) => b.annotations === undefined) ?? blocks[0];
  let parsed;
  try {
    parsed = JSON.parse(payload.text);
  } catch (err) {
    throw new Error(`response payload block is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...envelope, parsed };
}

// ---------------------------------------------------------------------------
// Volatile-field normalisation (my-beads-db-27m.50)
// ---------------------------------------------------------------------------
// The recorded fixture corpus is NOT byte-reproducible across recordings of
// the "same" scenario: entry ids are fresh UUIDs, `created_at` timestamps
// are wall-clock, and at least one response's result ORDER is unstable
// (kb_list/happy.json listed the context-cache entry before the knowledge
// entry in commit f230c530, and the reverse in 8d6a5e00 -- same two entries,
// same total). None of that is a defect in what got recorded; it is why NO
// regenerate-and-diff drift guard is (or should ever be) pointed at
// fixtures/ the way `contract:check` is pointed at schemas/ and bindings/mcp/
// (see README.md's fixtures note and this file's own header).
//
// This harness does not need a general recorded-vs-live deep-equal today --
// its one true equality assertion (`liveMessage === recordedMessage` for a
// refusal) already normalises via `normalizeMessage` above, and every other
// check either validates against a SCHEMA (order/id-agnostic by
// construction) or reads one named field (`assertParsed`). This normaliser
// exists so any FUTURE equality assertion added to this harness -- or to a
// consumer that wants to diff two recordings of the same fixture -- has a
// ready-made, already-proven way to do it instead of re-discovering the
// UUID/timestamp/order trap. It is deliberately NOT wired into a blanket
// live-vs-recorded comparison here: several tools' parsed bodies carry other
// live-vs-recorded deltas that are NOT simply id/timestamp/order (e.g.
// kb_export/kb_setup's `path`/`steps` embed a live scratch path where the
// fixture has `<SCRATCH_REPO_A>`; kb_stats's `retrieval`/`promote_ratio` are
// derived from telemetry accumulated over the whole run) -- normalising
// those too is a different, larger task, not this one.
//
// Operates on the DECODED **parsed body** (`decodeEnvelope(envelope).parsed`,
// or any plain object/array) -- NOT the raw envelope and NOT
// `decodeEnvelope()`'s whole return value. The volatile values live inside
// `content[].text` as a JSON STRING; a structural walk cannot see through
// that string (it would need to be re-serialised to normalise, defeating the
// point of a semantic comparison), so passing the whole envelope leaves
// `content[].text` un-normalised and two genuinely-equivalent recordings
// will still compare unequal. Always normalise `.parsed`, never `.content`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Canonical (sorted-key) JSON.stringify, so array-sort-for-comparison below does not depend on insertion order. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deep-normalise a decoded fixture/response value for SEMANTIC (not byte)
 * comparison: every UUID-shaped string becomes `<UUID>`, every ISO-8601
 * timestamp string becomes `<TIMESTAMP>`, and every array is re-sorted by its
 * own (already-normalised) canonical JSON string -- so two recordings whose
 * only difference is fresh ids/timestamps and result ORDER normalise to
 * deep-equal values.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeVolatileFixtureFields(value) {
  if (Array.isArray(value)) {
    const normalizedItems = value.map(normalizeVolatileFixtureFields);
    return [...normalizedItems].sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : stableStringify(a) > stableStringify(b) ? 1 : 0));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeVolatileFixtureFields(v);
    return out;
  }
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '<UUID>';
    if (ISO_TIMESTAMP_RE.test(value)) return '<TIMESTAMP>';
  }
  return value;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------
function assertProviderShape(provider) {
  if (typeof provider?.name !== 'string' || provider.name.length === 0) {
    throw new Error('round-trip provider is missing a non-empty "name"');
  }
  for (const fn of ['prepareEnvironment', 'applySetup', 'call']) {
    if (typeof provider?.[fn] !== 'function') {
      throw new Error(`round-trip provider is missing the "${fn}()" method`);
    }
  }
}

/**
 * slug/repoPath are checked AFTER prepareEnvironment: a provider cannot know
 * either until its scratch world exists (the sqlite adapter resolves the slug
 * from the repo root it just created). Both are required -- provider identity
 * is the (slug, repoPath) PAIR, so a provider that can only name one of them
 * has not said which instance the corpus actually exercised.
 */
function assertProviderIdentity(provider) {
  for (const key of ['slug', 'repoPath']) {
    if (typeof provider?.[key] !== 'string' || provider[key].length === 0) {
      throw new Error(`round-trip provider did not resolve a non-empty "${key}" during prepareEnvironment()`);
    }
  }
}

function coverageFailures(rosterTools) {
  const failures = [];
  const onDisk = new Set(listFixtureKeys());
  const inScenario = new Set(SCENARIO.map((s) => `${s.tool}/${s.case}`));

  for (const key of onDisk) {
    if (!inScenario.has(key)) failures.push(`fixture ${key} is committed but no SCENARIO step consumes it`);
  }
  for (const key of inScenario) {
    if (!onDisk.has(key)) failures.push(`SCENARIO step ${key} has no committed fixture`);
  }
  if (inScenario.size !== SCENARIO.length) {
    failures.push(`SCENARIO lists ${SCENARIO.length} steps but only ${inScenario.size} distinct tool/case keys`);
  }

  if (rosterTools) {
    const covered = new Set(SCENARIO.map((s) => s.tool));
    for (const tool of rosterTools) {
      if (!covered.has(tool)) failures.push(`inventoried tool ${tool} has no round-trip coverage`);
    }
    for (const tool of covered) {
      if (!rosterTools.includes(tool)) failures.push(`SCENARIO covers ${tool}, which is not on the generator roster`);
    }
  }
  return failures;
}

/**
 * Cross-check a refusal fixture's `expected_error_code` against the contract
 * itself: the closed taxonomy set, the code's own raising_methods, and the
 * tool's bindings/mcp errors array. `observed_via` fixtures are deliberately
 * NOT cross-checked against the tool's bindings -- they document another
 * tool's code, and the tool that made the call correctly carries no ref to it.
 */
function taxonomyFailures(fixture, taxonomyIndex) {
  const failures = [];
  const code = fixture.expected_error_code;
  const observed = fixture.observed_via;

  if (observed && !taxonomyIndex.has(observed) && !loadNonErrorOutcomeNames().has(observed)) {
    failures.push(
      `observed_via ${observed} is neither a closed-set taxonomy code nor a documented non_error_outcome`,
    );
  }
  if (!code) return failures;

  const meta = taxonomyIndex.get(code);
  if (!meta) {
    failures.push(`expected_error_code ${code} is not in the closed taxonomy set`);
    return failures;
  }
  const raisers = (meta.entry.raising_methods ?? []).map((m) => m.tool);
  if (!raisers.includes(fixture.tool)) {
    failures.push(`taxonomy raising_methods for ${code} do not name ${fixture.tool} (names ${raisers.join(', ')})`);
  }
  if (!bindingErrorCodes(fixture.tool, taxonomyIndex).has(code)) {
    failures.push(`bindings/mcp/${fixture.tool}.json carries no error ref for ${code}`);
  }

  // The fixture's own shape must agree with how the taxonomy says the code is
  // surfaced -- a free assertion that catches a fixture recorded the wrong way.
  const surfaced = meta.entry.surfaced;
  if (surfaced === 'thrown' && !fixture.error) {
    failures.push(`${code} is surfaced:thrown but the fixture records no error`);
  }
  if (surfaced === 'response-field' && !fixture.response) {
    failures.push(`${code} is surfaced:response-field but the fixture records no response`);
  }
  return failures;
}

/**
 * Drive the whole committed corpus through `provider`, live.
 *
 * @param {object} provider  see "THE PROVIDER CONTRACT" above
 * @param {string[]} [rosterTools]  the inventoried tool roster (pass
 *   generate-contract.mjs's roster so coverage is checked against the real
 *   data, not a hand-copied list)
 * @returns {Promise<{provider: {name,slug,repoPath}, steps: object[], failures: string[]}>}
 */
export async function runRoundTrip(provider, rosterTools) {
  assertProviderShape(provider);
  const taxonomyIndex = loadTaxonomyIndex();
  const failures = coverageFailures(rosterTools);
  const steps = [];

  const prepared = await provider.prepareEnvironment(ENVIRONMENT);
  assertProviderIdentity(provider);
  const substitutions = {
    // Longest placeholder first so `<SCRATCH_REPO_A>` wins over `<SCRATCH_ROOT>`
    // for a path that starts with both (they do not nest today, but the corpus
    // does place every repo under the scratch root).
    pathPairs: Object.entries(prepared?.substitutions?.paths ?? {}).sort((a, b) => b[0].length - a[0].length),
    literalPairs: Object.entries(prepared?.substitutions?.literals ?? {}).sort((a, b) => b[0].length - a[0].length),
  };
  if (substitutions.pathPairs.length === 0) {
    throw new Error('provider.prepareEnvironment() returned no path substitutions');
  }

  const ids = new Map();
  const ctx = {
    ids,
    idPairs: () => [...ids.values()].map(({ live, recorded }) => [live, recorded]),
  };

  for (const step of SCENARIO) {
    const key = `${step.tool}/${step.case}`;
    const fail = (message) => failures.push(`${key}: ${message}`);
    const fixture = loadFixture(step.tool, step.case);
    const record = { key, tool: step.tool, kind: fixture.kind, dispatched: false };
    steps.push(record);

    failures.push(...taxonomyFailures(fixture, taxonomyIndex).map((m) => `${key}: ${m}`));

    if (step.setup) await provider.applySetup(step.setup);

    // 1. request validates BEFORE dispatch
    const request = rehydrate(fixture.request, substitutions);
    for (const [field, name] of Object.entries(step.derive ?? {})) {
      const known = ids.get(name);
      if (!known) {
        fail(`derive needs the id captured as ${name}, which no earlier step produced`);
      } else {
        request[field] = known.live;
      }
    }
    const validateRequest = validatorFor(step.tool, 'request');
    record.requestValid = validateRequest(request);
    if (!record.requestValid) {
      fail(`request does not validate against schemas/${step.tool}.request.json: ${ajvErrors(validateRequest)}`);
      continue; // never dispatch a request the contract already rejects
    }

    // 2. dispatch live
    let envelope;
    let thrown;
    try {
      envelope = await provider.call(step.tool, request);
      record.dispatched = true;
    } catch (err) {
      thrown = err;
      record.dispatched = true;
    }

    const expectsThrow = Boolean(fixture.error?.thrown);
    if (expectsThrow) {
      // 3. a refusal must fail with the documented code, not a generic error
      if (!thrown) {
        fail(`expected a thrown refusal for ${fixture.expected_error_code} but the call returned a response`);
        continue;
      }
      const liveMessage = normalizeMessage(thrown instanceof Error ? thrown.message : String(thrown), substitutions, ctx);
      const recordedMessage = String(fixture.error.message).split('\\').join('/');
      record.refusalMatched = liveMessage === recordedMessage;
      if (!record.refusalMatched) {
        fail(
          `refusal message does not match the recorded ${fixture.expected_error_code} refusal.\n` +
            `  live:     ${liveMessage}\n  recorded: ${recordedMessage}`,
        );
      }
      continue;
    }

    if (thrown) {
      fail(`dispatch threw unexpectedly: ${thrown instanceof Error ? thrown.stack : String(thrown)}`);
      continue;
    }

    // 4. live response validates against its response schema
    let decoded;
    try {
      decoded = decodeEnvelope(envelope);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    const validateResponse = validatorFor(step.tool, 'response');
    record.responseValid = validateResponse(decoded);
    if (!record.responseValid) {
      fail(`live response does not validate against schemas/${step.tool}.response.json: ${ajvErrors(validateResponse)}`);
    }

    // 5. extra live evidence, where the fixture's evidence is a response field
    if (step.assertParsed) {
      const problem = step.assertParsed(decoded.parsed, ctx);
      record.signalMatched = problem === null;
      if (problem) fail(problem);
    }

    // 6. record the id this step minted, for later steps that derive from it
    if (step.captureId) {
      const live = decoded.parsed?.id;
      let recorded;
      try {
        recorded = decodeEnvelope(fixture.response).parsed?.id;
      } catch {
        recorded = undefined;
      }
      if (typeof live !== 'string' || typeof recorded !== 'string') {
        fail(`captureId ${step.captureId} needs an id in both the live and recorded response (live=${live}, recorded=${recorded})`);
      } else {
        ids.set(step.captureId, { live, recorded });
      }
    }
  }

  return {
    provider: { name: provider.name, slug: provider.slug, repoPath: provider.repoPath },
    steps,
    failures,
  };
}
