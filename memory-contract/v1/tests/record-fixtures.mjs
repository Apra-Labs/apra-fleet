// T1.4.1: record-mode fixture harness for memory-contract/v1.
//
// Plain .mjs module, NOT a *.test.ts, on purpose -- vitest.config.ts only
// discovers tests/**/*.test.ts and packages/*/tests/**/*.test.ts, so a test
// file placed here would silently never run (same constraint documented in
// probe-generator-2020-12.mjs). Run it explicitly:
//
//   npm run build && node memory-contract/v1/tests/record-fixtures.mjs
//
// The build step is required because this harness drives the REAL
// registerAllTools() wiring compiled to dist/services/tool-registry.js (the
// surface is authored in TypeScript, same as probe-generator-2020-12.mjs).
//
// WHAT THIS DOES
// ---------------
// Registers all 57 tools (23 of them memory-contract tools: 16 kb_* + 7
// code_*, INVENTORY.md section 1) with a 4-line fake McpServer -- the exact
// technique INVENTORY.md section 1 used to verify the tool count at runtime
// -- then calls each of the 23 wrapped handlers with a scripted request and
// records the wrapTool response ENVELOPE (the {content, structuredContent?}
// shape wrapTool() returns, per T1.3.3/.33 widening the emitted response
// schemas to that general envelope -- NOT the inner JSON payload) to
// memory-contract/v1/fixtures/<tool>/<case>.json.
//
// HERMETIC / SCRATCH-ONLY, on purpose (never touches real host state):
//   - APRA_FLEET_DATA_DIR is set to a fresh tmpdir BEFORE any dist/*.js
//     module is imported, so every KB write (sqlite files, onboarding.json,
//     knowledge/config.json) lands there instead of under the real
//     ~/.apra-fleet/data. This file therefore has ZERO static imports of
//     dist/* -- only dynamic `await import()` calls issued after the env var
//     is set, because ESM `import` declarations are hoisted and would run
//     before the assignment otherwise (same load-order hazard documented on
//     kb-providers.ts's module-level FLEET_DIR constant).
//   - repo_path/repo arguments point at fresh tmpdir "repos" that are
//     deliberately NOT git repositories, so kb_setup never installs a real
//     git hook and kb_export's isGitRepo() check is false, so it NEVER runs
//     `git add`/`git commit` anywhere (see kb-export.ts maybeAutoCommitBible).
//   - repo_remote_url is set explicitly on every kb_* call (a synthetic
//     example.test URL) rather than relying on git-derived slugs, so the
//     recorded corpus is HOST-INDEPENDENT -- reproducible on any host
//     regardless of whether the scratch tmpdir happens to sit inside a real
//     git working tree. This is NOT the same claim as byte-reproducible; see
//     the dedicated note below.
//   - code_* calls pass repo= a tmpdir with no .gitnexus/meta.json, so
//     callGitNexus()'s pre-flight check (code-intelligence-gitnexus.ts)
//     returns a structured "missing index" result WITHOUT ever spawning the
//     real gitnexus child process -- see docs note in INVENTORY.md that no
//     code_* tool declares a response schema (opaque provider payload); the
//     recorded envelope here is the real, honest behavior of this surface
//     when no project is indexed, not a fabricated stand-in.
//
// KNOWN NON-SCRATCH SIDE EFFECT (documented, not worked around): each code_*
// call also fires code-intelligence-telemetry.ts's recordUsage(), which
// fire-and-forget appends one JSONL line to the REAL
// ~/.apra-fleet/data/code-intelligence/usage.jsonl (that path is hardcoded
// via os.homedir(), not FLEET_DIR, so APRA_FLEET_DATA_DIR cannot redirect
// it). This is the tool's own always-on behavior for every real call, not
// something this harness introduces; the write is additive-only (a few
// bytes), never destructive, and swallows its own errors. Flagged here
// rather than silently accepted.
//
// THE RECORDED CORPUS IS NOT BYTE-REPRODUCIBLE (my-beads-db-27m.50): running
// this file twice never produces a byte-identical fixtures/ tree, even with
// nothing about the 23 tools' behaviour changed. Three concrete axes,
// verified against the real corpus history:
//   - entry `id` fields are fresh UUIDs, minted per run (kb_capture's
//     handler, not this harness).
//   - `created_at` timestamps (kb_query/kb_session_prime entry payloads) are
//     wall-clock.
//   - at least one response's result ORDER is unstable: fixtures/kb_list/
//     happy.json listed its two entries knowledge-then-context-cache in
//     commit f230c530 and context-cache-then-knowledge in 8d6a5e00 -- same
//     two entries, same `total`, different order.
// Consequences, stated so a later task does not mistake this churn for
// drift: (1) unlike schemas/ and bindings/mcp/ (see this contract's
// README.md "Source of Truth"), NO regenerate-and-diff drift guard is, or
// should ever be, pointed at fixtures/ -- `contract:check`'s byte-comparison
// model does not apply here. (2) T1.4.2's round-trip validator
// (roundtrip-harness.mjs) never byte-compares a recorded fixture against
// anything; it validates each one against its JSON Schema (order/id-agnostic
// by construction) and normalises before its one true string-equality
// assertion (a refusal's error message, via its own `normalizeMessage`).
// (3) Any future consumer that DOES want to diff two recordings of the same
// fixture semantically has a ready-made helper:
// `normalizeVolatileFixtureFields` in roundtrip-harness.mjs, proven against
// the real f230c530/8d6a5e00 kb_list/happy.json pair in
// tests/memory-contract-fixture-volatility.test.ts.
//
// Fixture shape (flat, provider-agnostic, self-describing -- consumed by
// T1.4.2's provider-parameterized round-trip validator):
//   { tool, case, kind: 'happy' | 'refusal' | 'non_error_outcome',
//     request, response?, error?: { message, thrown: true },
//     expected_error_code?: '<taxonomy code>',
//     observed_via?: '<taxonomy code>', note?: string }
// expected_error_code (kind:refusal only) asserts `tool` itself raises that
// taxonomy code -- it is cross-checked against `tool`'s own raising_methods
// and bindings/mcp errors array. observed_via (kind:non_error_outcome only)
// is the opposite: it documents that this fixture's response is evidence of
// a code raised by a DIFFERENT tool, so it is never cross-checked against
// `tool`'s own bindings.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 0. Scratch environment -- MUST run before any dist/* import.
// ---------------------------------------------------------------------------
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-fixtures-'));
process.env.APRA_FLEET_DATA_DIR = path.join(SCRATCH_ROOT, 'fleet-data');
fs.mkdirSync(process.env.APRA_FLEET_DATA_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const FIXTURES_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1', 'fixtures');

// Synthetic scratch repos -- no real BluSKY code, credentials, or customer
// text anywhere below. repoA/repoB are deliberately NOT git repos (no .git).
const repoA = path.join(SCRATCH_ROOT, 'repo-a');
const repoB = path.join(SCRATCH_ROOT, 'repo-b');
const repoCode = path.join(SCRATCH_ROOT, 'repo-code');
fs.mkdirSync(path.join(repoA, 'src'), { recursive: true });
fs.mkdirSync(repoB, { recursive: true });
fs.mkdirSync(repoCode, { recursive: true });

fs.writeFileSync(
  path.join(repoA, 'src', 'example.ts'),
  "export function exampleFn(x: number): number {\n  return x + 1;\n}\n",
);
fs.writeFileSync(
  path.join(repoA, 'src', 'helper.ts'),
  "export function helperBar(): void {\n  // placeholder\n}\n",
);

const REMOTE_A = 'https://example.test/memory-contract-fixtures-a.git';
const REMOTE_B = 'https://example.test/memory-contract-fixtures-b.git';

// ---------------------------------------------------------------------------
// 1. Fake McpServer -- same 4-line technique INVENTORY.md section 1 used to
//    verify the runtime tool count. Captures every registered handler by
//    name so this harness can call the REAL post-wrapTool envelope.
// ---------------------------------------------------------------------------
const registered = new Map();
const fakeServer = {
  tool(name, _description, _shape, handler) {
    registered.set(name, handler);
  },
  server: {
    async sendLoggingMessage() {
      // no-op: onboarding notifications are not part of this contract
    },
  },
};

const { registerAllTools } = await import(pathToFileURL(path.join(DIST, 'services', 'tool-registry.js')).href);
await registerAllTools(fakeServer);

// ---------------------------------------------------------------------------
// 2. Recording plumbing
// ---------------------------------------------------------------------------
let recorded = 0;
let failures = 0;

// Committed fixtures must not carry this machine's absolute tmp paths
// (per-host, non-reproducible, and leaks the local username). Longest-path
// substitutions first (repoA/B/Code are nested under SCRATCH_ROOT).
// Some opaque code_* provider payloads are JSON.stringify'd twice (once by
// the provider layer, once more by wrapTool's outer envelope), so a Windows
// backslash path can appear ONE level re-escaped (each \ doubled to \\)
// inside a nested JSON-text string. Add that re-escaped variant alongside
// the raw path so both nesting depths get caught.
const RAW_PATH_PAIRS = [
  [repoA, '<SCRATCH_REPO_A>'],
  [repoB, '<SCRATCH_REPO_B>'],
  [repoCode, '<SCRATCH_REPO_CODE>'],
  [SCRATCH_ROOT, '<SCRATCH_ROOT>'],
];
const PATH_REPLACEMENTS = RAW_PATH_PAIRS.flatMap(([search, replacement]) => {
  const pairs = [[search, replacement]];
  const reEscaped = search.split('\\').join('\\\\');
  if (reEscaped !== search) pairs.push([reEscaped, replacement]);
  return pairs;
}).sort((a, b) => b[0].length - a[0].length);

function sanitizeValue(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [search, replacement] of PATH_REPLACEMENTS) {
      out = out.split(search).join(replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
    return out;
  }
  return value;
}

function writeFixture(tool, caseName, doc) {
  const dir = path.join(FIXTURES_DIR, tool);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${caseName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(sanitizeValue(doc), null, 2) + '\n', 'utf-8');
  recorded++;
  console.log(`  [recorded] ${tool}/${caseName}.json`);
}

async function recordHappy(tool, caseName, request) {
  const handler = registered.get(tool);
  if (!handler) {
    failures++;
    console.log(`  [FAIL] ${tool} is not registered`);
    return undefined;
  }
  try {
    const response = await handler(request);
    writeFixture(tool, caseName, { tool, case: caseName, kind: 'happy', request, response });
    return response;
  } catch (err) {
    failures++;
    console.log(`  [FAIL] ${tool}/${caseName} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function recordRefusal(tool, caseName, request, expectedErrorCode) {
  const handler = registered.get(tool);
  if (!handler) {
    failures++;
    console.log(`  [FAIL] ${tool} is not registered`);
    return;
  }
  try {
    const response = await handler(request);
    failures++;
    console.log(`  [FAIL] ${tool}/${caseName} expected a throw for ${expectedErrorCode} but got a response`);
    void response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFixture(tool, caseName, {
      tool,
      case: caseName,
      kind: 'refusal',
      request,
      error: { message, thrown: true },
      expected_error_code: expectedErrorCode,
    });
  }
}

// A "response-field" refusal: the call SUCCEEDS but the response carries the
// documented refusal signal (never a thrown error). Recorded from whatever
// the real call actually returned -- assertFn must throw/return false to mark
// the recording as invalid evidence of the taxonomy code.
async function recordResponseFieldRefusal(tool, caseName, request, expectedErrorCode, assertFn) {
  const handler = registered.get(tool);
  if (!handler) {
    failures++;
    console.log(`  [FAIL] ${tool} is not registered`);
    return undefined;
  }
  let response;
  try {
    response = await handler(request);
  } catch (err) {
    failures++;
    console.log(`  [FAIL] ${tool}/${caseName} threw but a response-field refusal was expected: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const ok = assertFn(response);
  if (!ok) {
    failures++;
    console.log(`  [FAIL] ${tool}/${caseName} response did not carry the expected ${expectedErrorCode} signal`);
  }
  writeFixture(tool, caseName, {
    tool,
    case: caseName,
    kind: 'refusal',
    request,
    response,
    expected_error_code: expectedErrorCode,
  });
  return response;
}

async function recordNonErrorOutcome(tool, caseName, request, note) {
  const handler = registered.get(tool);
  if (!handler) {
    failures++;
    console.log(`  [FAIL] ${tool} is not registered`);
    return undefined;
  }
  const response = await handler(request);
  writeFixture(tool, caseName, { tool, case: caseName, kind: 'non_error_outcome', request, response, note });
  return response;
}

// A non-error-outcome fixture that observes, from a DIFFERENT tool's call,
// the durable effect of a taxonomy code raised by some other tool -- never a
// 'refusal' with expected_error_code, because that field means "the named
// taxonomy code is one THIS fixture's own tool can raise" (per
// raising_methods, cross-checked against that tool's bindings/mcp errors
// array by T1.4.2). observedCode documents which code's effect this is
// evidence of, without claiming `tool` raises it -- so a fixture-to-
// projection cross-check never expects `tool`'s binding to carry that ref.
// assertFn still fails the recording loudly if the observed effect stops
// holding, same non-vacuous guarantee recordResponseFieldRefusal gives.
async function recordObservedEffect(tool, caseName, request, observedCode, note, assertFn) {
  const handler = registered.get(tool);
  if (!handler) {
    failures++;
    console.log(`  [FAIL] ${tool} is not registered`);
    return undefined;
  }
  const response = await handler(request);
  const ok = assertFn(response);
  if (!ok) {
    failures++;
    console.log(`  [FAIL] ${tool}/${caseName} response did not carry the expected observed effect of ${observedCode}`);
  }
  writeFixture(tool, caseName, {
    tool,
    case: caseName,
    kind: 'non_error_outcome',
    request,
    response,
    observed_via: observedCode,
    note,
  });
  return response;
}

function parseEnvelopeText(response) {
  // wrapTool envelope: { content: [{type:'text', text}], structuredContent? }
  const block = response?.content?.find((c) => c.type === 'text');
  if (!block) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

// ===========================================================================
// PASS 1 -- happy path per tool (the exit criterion)
// ===========================================================================
console.log('== PASS 1: happy-path corpus ==');

// --- kb_setup -----------------------------------------------------------
await recordHappy('kb_setup', 'happy', { repo_path: repoA, provider: 'sqlite' });

// --- kb_capture (two ordinary entries to build on) -----------------------
const captureFoo = await recordHappy('kb_capture', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'knowledge',
  title: 'exampleFn returns x + 1',
  summary: 'exampleFn in src/example.ts is a trivial increment helper used by the fixture corpus.',
  content: 'exampleFn(x) returns x + 1. Captured as a synthetic fixture for the memory-contract round-trip corpus.',
  source_files: ['src/example.ts'],
  symbols: ['exampleFn'],
  role: 'doer',
});
const idFoo = parseEnvelopeText(captureFoo)?.id;

await recordHappy('kb_capture', 'happy-context-cache', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'context-cache',
  title: 'src/example.ts summary',
  summary: 'File summary cache entry for src/example.ts.',
  content: 'src/example.ts exports exampleFn, a one-line increment helper.',
  source_files: ['src/example.ts'],
  source_file: 'src/example.ts',
  symbols: ['exampleFn'],
});

// --- kb_context -----------------------------------------------------------
await recordHappy('kb_context', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  files: ['src/example.ts', 'src/helper.ts'],
});

// --- kb_session_prime -----------------------------------------------------
await recordHappy('kb_session_prime', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  hint_symbols: ['exampleFn'],
  session_files: ['src/example.ts'],
});

// --- kb_query ---------------------------------------------------------
await recordHappy('kb_query', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  query: 'exampleFn',
});

// --- kb_list ------------------------------------------------------------
await recordHappy('kb_list', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
});

// --- kb_promote -----------------------------------------------------------
if (idFoo) {
  await recordHappy('kb_promote', 'happy', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idFoo,
    reason: 'Manually re-read src/example.ts and confirmed exampleFn(x) returns x + 1 exactly as captured.',
  });
}

// --- kb_stats -------------------------------------------------------------
await recordHappy('kb_stats', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  symbols: ['exampleFn'],
});

// --- kb_export --------------------------------------------------------
await recordHappy('kb_export', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
});
const bibleFromA = path.join(repoA, '.fleet', 'kb-canonical.json');

// --- kb_import (into a genuinely separate KB -- repoB / REMOTE_B slug) ----
await recordHappy('kb_import', 'happy', {
  repo: repoB,
  repo_remote_url: REMOTE_B,
  path: bibleFromA,
});

// --- kb_freshness_sweep ---------------------------------------------------
await recordHappy('kb_freshness_sweep', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
});

// --- kb_feedback ------------------------------------------------------
if (idFoo) {
  await recordHappy('kb_feedback', 'happy', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idFoo,
    reason: 'On re-check, the summary overstated precision -- exampleFn is untyped-input tolerant, unlike the note implies.',
    role: 'reviewer',
  });
}

// --- kb_harvest -------------------------------------------------------
await recordHappy('kb_harvest', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  session_transcript:
    'Note: the helper in `computeThing` inside src/example.ts had a subtle rounding bug that is now fixed after tightening the threshold check.',
  session_id: 'sess-fixture-1',
});

// --- Contradiction pair: kb_reconcile_prefilter + kb_resolve_contradiction -
const captureBroken = await recordHappy('kb_capture', 'happy-contradiction-a', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'learning',
  title: 'helperBar is broken',
  summary: 'helperBar in src/helper.ts is broken under concurrent calls.',
  content: 'helperBar is broken: it silently drops the second concurrent call.',
  source_files: ['src/helper.ts'],
  symbols: ['helperBar'],
});
const idBroken = parseEnvelopeText(captureBroken)?.id;

const captureFixed = await recordHappy('kb_capture', 'happy-contradiction-b', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'learning',
  title: 'helperBar now works under concurrent calls',
  summary: 'helperBar in src/helper.ts now works correctly for concurrent calls after a guard was added.',
  content: 'helperBar now works: a re-entrancy guard was added so concurrent calls no longer collide.',
  source_files: ['src/helper.ts'],
  symbols: ['helperBar'],
});
const idFixed = parseEnvelopeText(captureFixed)?.id;
console.log(`  [info] contradiction pair audn_decision for B: ${parseEnvelopeText(captureFixed)?.audn_decision}`);

await recordHappy('kb_reconcile_prefilter', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
});

if (idBroken && idFixed) {
  await recordHappy('kb_resolve_contradiction', 'happy', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    winnerId: idFixed,
    loserId: idBroken,
    evidence: 'Re-read src/helper.ts after the fix landed: the re-entrancy guard is present and concurrent calls no longer collide.',
  });
}

// --- kb_invalidate ------------------------------------------------------
await recordHappy('kb_invalidate', 'happy', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  files: ['src/example.ts'],
});

// --- code_* (7 tools) -- all against a repo with no .gitnexus/meta.json, so
// the real, honest "missing index" structured result is what gets recorded,
// without ever spawning the gitnexus child process.
await recordHappy('code_graph', 'happy-no-index', { symbol: 'exampleFn', repo: repoCode });
await recordHappy('code_impact', 'happy-no-index', { target: 'exampleFn', direction: 'upstream', repo: repoCode });
await recordHappy('code_query', 'happy-no-index', { query: 'exampleFn', repo: repoCode });
await recordHappy('code_context', 'happy-no-index', { name: 'exampleFn', repo: repoCode, repo_remote_url: REMOTE_A });
await recordHappy('code_map', 'happy-no-index', { repo: repoCode });
await recordHappy('code_flow', 'happy-no-index', { name: 'exampleFn', repo: repoCode });
await recordHappy('code_tests', 'happy-no-index', { symbol: 'exampleFn', repo: repoCode });

// ===========================================================================
// PASS 2 -- hardening: taxonomy-coded refusals + one documented non-error
// outcome. NOT exhaustive (see notes below and T7 gap list printed at the
// end) -- ships whatever fits per the bead's own "gap is a named T7 input,
// not silent debt" allowance.
// ===========================================================================
console.log('== PASS 2: refusal + non-error-outcome fixtures ==');

// -- validation group (all 6 codes) ---------------------------------------
await recordRefusal('kb_query', 'refusal-no-selector', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
}, 'E-QUERY-NO-SELECTOR');

await recordRefusal('kb_context', 'refusal-path-traversal', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  files: ['../outside-the-repo.txt'],
}, 'E-PATH-TRAVERSAL');

await recordRefusal('kb_export', 'refusal-repo-path-invalid', {
  repo_path: path.join(SCRATCH_ROOT, 'this-directory-does-not-exist'),
}, 'E-REPO-PATH-INVALID');

await recordRefusal('kb_import', 'refusal-bible-not-found', {
  repo: repoA,
  repo_remote_url: REMOTE_A,
  path: path.join(repoA, '.fleet', 'no-such-bible.json'),
}, 'E-BIBLE-NOT-FOUND');

const notJsonPath = path.join(repoA, '.fleet', 'not-json.json');
fs.writeFileSync(notJsonPath, 'this is not valid JSON {{{', 'utf-8');
await recordRefusal('kb_import', 'refusal-bible-not-json', {
  repo: repoA,
  repo_remote_url: REMOTE_A,
  path: notJsonPath,
}, 'E-BIBLE-NOT-JSON');

const wrongShapePath = path.join(repoA, '.fleet', 'wrong-shape.json');
fs.writeFileSync(wrongShapePath, JSON.stringify({ not: 'an array or an entries envelope' }), 'utf-8');
await recordRefusal('kb_import', 'refusal-bible-wrong-shape', {
  repo: repoA,
  repo_remote_url: REMOTE_A,
  path: wrongShapePath,
}, 'E-BIBLE-WRONG-SHAPE');

// -- admission group (all 3 codes) ----------------------------------------
await recordRefusal('kb_capture', 'refusal-no-basis', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'knowledge',
  title: 'An entry with no cited source files',
  summary: 'This capture cites no source_files at all.',
  content: 'Nothing here can ever be falsified by the freshness sweep.',
}, 'E-NO-BASIS');

await recordRefusal('kb_capture', 'refusal-basis-missing-files', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'knowledge',
  title: 'An entry citing a file that does not exist',
  summary: 'This capture cites a source file absent from the worktree.',
  content: 'src/does-not-exist.ts is not a real file in repoA.',
  source_files: ['src/does-not-exist.ts'],
}, 'E-BASIS-MISSING-FILES');

const rejectedBiblePath = path.join(repoA, '.fleet', 'bible-with-rejected-entry.json');
fs.writeFileSync(
  rejectedBiblePath,
  JSON.stringify([
    {
      id: 'fixture-rejected-entry-1',
      type: 'knowledge',
      title: 'A bible entry with no source_files',
      summary: 'This entry cites no basis and must be rejected on import.',
      confidence: 'INFERRED',
    },
  ]),
  'utf-8',
);
const repoImportRejected = path.join(SCRATCH_ROOT, 'repo-import-rejected');
fs.mkdirSync(repoImportRejected, { recursive: true });
await recordResponseFieldRefusal(
  'kb_import',
  'refusal-import-entry-rejected',
  { repo: repoImportRejected, path: rejectedBiblePath },
  'E-IMPORT-ENTRY-REJECTED',
  (response) => {
    const payload = parseEnvelopeText(response);
    return !!payload && payload.rejected >= 1;
  },
);

// -- authority group (all 3 codes) ----------------------------------------
await recordRefusal('kb_promote', 'refusal-reason-required', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  id: idFoo ?? 'placeholder-id',
}, 'E-PROMOTE-REASON-REQUIRED');

if (idBroken) {
  // idBroken was superseded by the resolve_contradiction call above.
  await recordRefusal('kb_promote', 'refusal-superseded', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idBroken,
    reason: 'Attempting to re-promote an entry that was already superseded by the contradiction resolution above.',
  }, 'E-PROMOTE-SUPERSEDED');
}

fs.writeFileSync(path.join(repoA, 'src', 'soon-to-be-deleted.ts'), 'export const placeholder = 1;\n');
const captureForBasisLoss = await recordHappy('kb_capture', 'setup-for-basis-unresolved', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'knowledge',
  title: 'Entry whose basis file will be deleted before a second promote',
  summary: 'Set up to demonstrate E-PROMOTE-BASIS-UNRESOLVED.',
  content: 'This entry cites src/soon-to-be-deleted.ts, which is removed before the second promote call.',
  source_files: ['src/soon-to-be-deleted.ts'],
});
const idBasisLoss = parseEnvelopeText(captureForBasisLoss)?.id;
if (idBasisLoss) {
  await recordHappy('kb_promote', 'setup-first-promote-for-basis-unresolved', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idBasisLoss,
    reason: 'First promotion (UNVERIFIED -> INFERRED) while the basis file still exists.',
  });
  fs.rmSync(path.join(repoA, 'src', 'soon-to-be-deleted.ts'));
  await recordRefusal('kb_promote', 'refusal-basis-unresolved', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idBasisLoss,
    reason: 'Second promotion attempted after the cited basis file was deleted.',
  }, 'E-PROMOTE-BASIS-UNRESOLVED');
}

// -- not_found group (both codes) -----------------------------------------
await recordRefusal('kb_promote', 'refusal-entry-not-found', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  id: 'fixture-does-not-exist',
  reason: 'Attempting to promote an id that was never captured.',
}, 'E-ENTRY-NOT-FOUND');

await recordRefusal('kb_resolve_contradiction', 'refusal-resolve-missing-entry', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  winnerId: 'fixture-does-not-exist-winner',
  loserId: 'fixture-does-not-exist-loser',
  evidence: 'Neither id was ever captured.',
}, 'E-RESOLVE-MISSING-ENTRY');

// -- conflict group (both codes) ------------------------------------------
if (idFoo && idBasisLoss) {
  await recordRefusal('kb_resolve_contradiction', 'refusal-not-a-pair', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    winnerId: idFoo,
    loserId: idBasisLoss,
    evidence: 'These two entries were never linked as a contradiction pair.',
  }, 'E-RESOLVE-NOT-A-PAIR');
}

if (idBroken && idFixed) {
  // The pair was already resolved above; resolving it again hits the
  // already-superseded guard.
  await recordRefusal('kb_resolve_contradiction', 'refusal-already-superseded', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    winnerId: idFixed,
    loserId: idBroken,
    evidence: 'Re-resolving an already-resolved contradiction pair.',
  }, 'E-RESOLVE-ALREADY-SUPERSEDED');
}

// -- governance group (2 of 5 reachable without CLI directive activation) --
const captureDirective = await recordHappy('kb_capture', 'happy-user-directive-proposal', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'user-directive',
  title: 'Always run the sanitation test before committing fixtures',
  summary: 'A standing instruction captured as a pending proposal, never active from this channel.',
  content: 'Always run the fixture sanitation test before committing new fixtures.',
  source_files: ['src/example.ts'],
});
const idDirective = parseEnvelopeText(captureDirective)?.id;

// NOT a refusal fixture: taxonomy.json's E-DIRECTIVE-QUARANTINE raising_methods
// names kb_capture/kb_harvest/kb_import (the capture-time forcing), never
// kb_list -- kb_list's own bindings/mcp errors array correctly carries no ref
// to this code, so labelling this kb_list call kind:refusal with
// expected_error_code would misattribute another tool's code to this one and
// make T1.4.2's fixture-to-projection cross-check report a false mismatch.
// kb_capture's own response ({id, audn_decision, confidence_clamped}) never
// exposes the forced confidence/tag/scope, so the only way to OBSERVE the
// effect at all is a follow-up read; recorded honestly as what it is -- a
// kb_list call and its real response -- with observed_via naming the code
// whose durable effect this demonstrates.
await recordObservedEffect(
  'kb_list',
  'observed-directive-quarantine',
  { repo_path: repoA, repo_remote_url: REMOTE_A, type: 'user-directive', symbol: undefined },
  'E-DIRECTIVE-QUARANTINE',
  'kb_list observation of the pending directive proposal captured in kb_capture/happy-user-directive-proposal.json. ' +
    'E-DIRECTIVE-QUARANTINE (governance group, surfaced: response-field) is raised at capture time by kb_capture, ' +
    'kb_harvest and kb_import (taxonomy.json raising_methods) -- this kb_list call did not raise it and carries no ' +
    'ref to it in its own bindings/mcp definition; it only reads back the forced-to-UNVERIFIED effect left behind.',
  (response) => {
    const payload = parseEnvelopeText(response);
    const entry = payload?.results?.find((r) => r.id === idDirective);
    // Quarantine means: forced to UNVERIFIED confidence (never active/CONFIRMED)
    // regardless of what was requested.
    return !!entry && entry.confidence === 'UNVERIFIED';
  },
);

if (idDirective) {
  await recordRefusal('kb_promote', 'refusal-promote-directive', {
    repo_path: repoA,
    repo_remote_url: REMOTE_A,
    id: idDirective,
    reason: 'Attempting to promote a user-directive proposal directly, bypassing CLI activation.',
  }, 'E-PROMOTE-REFUSED-DIRECTIVE');
}

// -- non-error outcome (authority group's silent clamp branch) -----------
await recordNonErrorOutcome('kb_capture', 'non-error-confidence-clamped', {
  repo_path: repoA,
  repo_remote_url: REMOTE_A,
  type: 'knowledge',
  title: 'A capture that asks for CONFIRMED directly',
  summary: 'kb_capture always clamps an incoming CONFIRMED down to INFERRED; CONFIRMED is only minted by kb_promote.',
  content: 'This entry requests confidence: CONFIRMED at capture time.',
  source_files: ['src/example.ts'],
  confidence: 'CONFIRMED',
}, 'authority group, non_error_outcomes: the silent clamp branch gets no taxonomy code by design (taxonomy.json _meta.group_definitions.authority). Observable via confidence_clamped:true in the response, not via a thrown/response-field error code.');

// ===========================================================================
// Summary + named T7 gaps
// ===========================================================================
console.log('');
console.log(`Recorded ${recorded} fixture file(s), ${failures} failure(s).`);
console.log('');
console.log('NAMED T7 GAPS (not silent debt -- see taxonomy.json for each code):');
console.log('  - E-CODE-PROVIDER-UNCONFIGURED: requires an invalid `provider` value in');
console.log('    the REAL ~/.apra-fleet/data/code-intelligence/config.json (hardcoded');
console.log('    homedir path, not redirectable via APRA_FLEET_DATA_DIR). Mutating that');
console.log('    real host file is out of this harness\'s scratch-only write scope.');
console.log('  - E-RESOLVE-DIRECTIVE-PAIR, E-ACTIVE-DIRECTIVE-SUPERSEDE-GUARD: both');
console.log('    require an ACTIVE (CONFIRMED) user-directive, which is mintable only via');
console.log('    the CLI `apra-fleet kb approve-directive` (human-terminal only, by');
console.log('    design -- see directive_activation_absence in taxonomy.json). No MCP');
console.log('    tool call can reach this state, so no fixture can either.');
console.log('  - E-SUPERSEDE-CONSENT-MISSING: taxonomy.json marks this `surfaced: silent`');
console.log('    -- "no distinguishable signal exists today" -- so per the taxonomy\'s own');
console.log('    projection_rule it must NOT be projected into any fixture; there is');
console.log('    nothing observable to record.');
console.log('  - Exhaustive "at least one schema-invalid input per tool" sweep (PASS 2');
console.log('    SHOULD): not attempted this run. Zod input validation happens at the');
console.log('    real MCP SDK boundary (server.tool registration), before the handler is');
console.log('    ever called -- this harness\'s fake server bypasses that boundary by');
console.log('    design (it needs the handler reference, not SDK dispatch), so a');
console.log('    schema-invalid fixture would have to validate directly against each');
console.log('    tool\'s exported zod schema object rather than through this handler-call');
console.log('    harness. Left for a follow-up task.');

if (failures > 0) {
  process.exitCode = 1;
}
