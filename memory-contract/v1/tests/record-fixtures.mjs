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
// Registers all 58 tools (23 of them memory-contract tools: 16 kb_* + 7
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
//   - kb_* requests carry NO scope argument: every call is dispatched AS a
//     registered member session (roundtrip-harness.mjs ENVIRONMENT.sessions,
//     materialised by session-world.mjs into this run's hermetic registry),
//     so it resolves that member's own work folder. The scratch repos are git
//     repositories with synthetic example.test origin remotes, so the KB slug
//     is HOST-INDEPENDENT. kb_export auto-commits its bible into scratch repo
//     A only -- never outside the scratch root. This is NOT the same claim as
//     byte-reproducible; see the dedicated note below.
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
// realpath: a FULL session's (self) is process.cwd(), which the OS reports
// with symlinks resolved (macOS /var -> /private/var); the sanitiser must see
// that same spelling or a FULL-session message leaks a half-substituted path.
const SCRATCH_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-fixtures-')));
process.env.APRA_FLEET_DATA_DIR = path.join(SCRATCH_ROOT, 'fleet-data');
fs.mkdirSync(process.env.APRA_FLEET_DATA_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const FIXTURES_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1', 'fixtures');

// Single-scenario mode: RECORD_ONLY=<tool>/<case>[,<tool>/<case>...] restricts
// ACTUAL FILE WRITES to the listed fixtures; every other recordHappy/
// recordRefusal call in this script still runs (so the setup chain a later
// scenario depends on -- idFoo, idDemote, etc. -- still gets built), but its
// result is not written to disk. This is the additive-only recording mode: a
// full unfiltered run mints fresh UUIDs for EVERY fixture (recordHappy writes
// unconditionally), which would make the whole existing corpus non-byte-
// identical; this mode records new scenarios without touching any fixture
// file already committed. Unset (the default) records everything, unchanged.
const RECORD_ONLY = process.env.RECORD_ONLY
  ? new Set(process.env.RECORD_ONLY.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

// Synthetic scratch repos -- no real BluSKY code, credentials, or customer
// text anywhere below. repoA/repoB are deliberately NOT git repos (no .git).
const { ENVIRONMENT, RECORDED_REMOTE_A, RECORDED_REMOTE_B, RECORDED_REMOTE_IMPORT_REJECTED, RECORDED_REMOTE_BARE } =
  await import(pathToFileURL(path.join(HERE, 'roundtrip-harness.mjs')).href);
const { materializeSessionWorld } = await import(pathToFileURL(path.join(HERE, 'session-world.mjs')).href);
const { registerAllTools } = await import(pathToFileURL(path.join(DIST, 'services', 'tool-registry.js')).href);
const { memberToolScope } = await import(pathToFileURL(path.join(DIST, 'services', 'tool-scope.js')).href);
const { addAgent, removeAgent } = await import(pathToFileURL(path.join(DIST, 'services', 'registry.js')).href);

const RECORDED_REMOTES = {
  A: RECORDED_REMOTE_A,
  B: RECORDED_REMOTE_B,
  IMPORT_REJECTED: RECORDED_REMOTE_IMPORT_REJECTED,
  BARE: RECORDED_REMOTE_BARE,
};

const world = await materializeSessionWorld(ENVIRONMENT, SCRATCH_ROOT, {
  remoteUrl: (key) => RECORDED_REMOTES[key],
  addAgent,
  removeAgent,
  registerAllTools,
  memberToolScope,
});
const repoA = world.repoPaths.get('A');
const repoB = world.repoPaths.get('B');
const repoCode = world.repoPaths.get('CODE');

// Every record* call below dispatches as `currentSession`; withSession() runs
// one call as another session and stamps that session into the fixture.
let currentSession = ENVIRONMENT.defaultSession;
async function withSession(session, fn) {
  const previous = currentSession;
  currentSession = session;
  try {
    return await fn();
  } finally {
    currentSession = previous;
  }
}
function handlerFor(tool) {
  return world.sessionHandlers.get(currentSession)?.get(tool);
}

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
  // Live member labels carry a per-run tag; fixtures record the bare label.
  ...world.memberLiterals.map(([recordedLabel, liveLabel]) => [liveLabel, recordedLabel]),
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
  const key = `${tool}/${caseName}`;
  if (RECORD_ONLY && !RECORD_ONLY.has(key)) {
    console.log(`  [skip] ${key}.json (RECORD_ONLY set, not in it)`);
    return;
  }
  const dir = path.join(FIXTURES_DIR, tool);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${caseName}.json`);
  const stamped = currentSession === ENVIRONMENT.defaultSession ? doc : { ...doc, session: currentSession };
  fs.writeFileSync(outPath, JSON.stringify(sanitizeValue(stamped), null, 2) + '\n', 'utf-8');
  recorded++;
  console.log(`  [recorded] ${tool}/${caseName}.json`);
}

async function recordHappy(tool, caseName, request) {
  const handler = handlerFor(tool);
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
  const handler = handlerFor(tool);
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
  const handler = handlerFor(tool);
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
  const handler = handlerFor(tool);
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
  const handler = handlerFor(tool);
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
// No member session is served kb_setup (it writes the machine-wide provider
// config), so it is recorded in the FULL session over repo A.
await withSession('FULL_A', () => recordHappy('kb_setup', 'happy', { provider: 'sqlite' }));

// --- kb_capture (two ordinary entries to build on) -----------------------
const captureFoo = await recordHappy('kb_capture', 'happy', {
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
  files: ['src/example.ts', 'src/helper.ts'],
});

// --- kb_session_prime -----------------------------------------------------
await recordHappy('kb_session_prime', 'happy', {
  hint_symbols: ['exampleFn'],
  session_files: ['src/example.ts'],
});

// --- kb_query ---------------------------------------------------------
await recordHappy('kb_query', 'happy', {
  query: 'exampleFn',
});

// --- kb_list ------------------------------------------------------------
await recordHappy('kb_list', 'happy', {
});
// The pre-redesign single-tier string form, read as a one-element list.
await recordHappy('kb_list', 'happy-confidence-string', {
  confidence: 'INFERRED',
});

// --- kb_promote -----------------------------------------------------------
if (idFoo) {
  await recordHappy('kb_promote', 'happy', {
    id: idFoo,
    reason: 'Manually re-read src/example.ts and confirmed exampleFn(x) returns x + 1 exactly as captured.',
  });
}

// --- kb_export --------------------------------------------------------
// Before the CONFIRMED-only read and kb_stats: a member session's default
// (CONFIRMED) reads come from its checkout bible, so the promoted entry is
// visible to them once kb_export has written it there. No member session is
// served kb_export (it auto-commits into the work tree), so it is recorded in
// the FULL session over repo A, which shares repo A's KB.
await withSession('FULL_A', () => recordHappy('kb_export', 'happy', {
}));

// --- kb_bible_commit -----------------------------------------------------
// Entry-level merge of the promoted entry into repo A's bible, with explicit
// target-base-branch provenance. Local commit only; never pushed.
if (idFoo) {
  await recordHappy('kb_bible_commit', 'happy', {
    ids: [idFoo],
    baseBranch: 'main',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
  });
}

// Basis skip: a CONFIRMED entry whose cited file was edited after capture fails
// the shared bible basis predicate (same rule as kb_export) and is reported in
// skipped with reason basis_mismatch; the bible is left untouched.
{
  fs.writeFileSync(path.join(repoA, 'src', 'basis-drift.ts'), 'export const drift = 1;\n');
  const captureDrift = await recordHappy('kb_capture', 'setup-for-bible-commit-basis-mismatch', {
    type: 'knowledge',
    title: 'Entry whose cited file changes after capture',
    summary: 'Set up to demonstrate the kb_bible_commit basis_mismatch skip reason.',
    content: 'This entry cites src/basis-drift.ts, which is edited after the entry is promoted to CONFIRMED.',
    source_files: ['src/basis-drift.ts'],
  });
  const idDrift = parseEnvelopeText(captureDrift)?.id;
  if (idDrift) {
    await recordHappy('kb_promote', 'setup-first-promote-for-bible-commit-basis-mismatch', {
      id: idDrift,
      reason: 'First promotion (UNVERIFIED -> INFERRED) of the entry used by the basis_mismatch fixture.',
    });
    await recordHappy('kb_promote', 'setup-second-promote-for-bible-commit-basis-mismatch', {
      id: idDrift,
      reason: 'Second promotion (INFERRED -> CONFIRMED) while the cited file still matches the capture basis.',
    });
    fs.writeFileSync(path.join(repoA, 'src', 'basis-drift.ts'), 'export const drift = 2;\n');
    await recordHappy('kb_bible_commit', 'basis-mismatch', {
      ids: [idDrift],
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    });
  }
}

// --- kb_demote ------------------------------------------------------------
// DELIBERATELY SELF-CONTAINED: its own capture plus its own two promotes,
// rather than reusing idFoo. Every later bible/stats/CONFIRMED-read fixture
// depends on idFoo still being CONFIRMED, and kb_demote's whole job is to take
// that away -- demoting idFoo here would silently rewrite those fixtures.
//
// The refusal case lives in this block and NOT in the refusal section further
// down for the same reason the ordering comment at the top of this file gives:
// E-DEMOTE-NOT-CONFIRMED is only reachable on an entry kb_demote has ALREADY
// demoted, so the two cases are one dependent sequence, not two independent
// scenarios.
{
  fs.writeFileSync(path.join(repoA, 'src', 'demote-basis.ts'), 'export const demoteBasis = 1;\n');
  const captureForDemote = await recordHappy('kb_capture', 'setup-for-demote', {
    type: 'knowledge',
    title: 'Entry walked up to CONFIRMED so it can be demoted',
    summary: 'Set up to demonstrate the kb_demote happy path and its E-DEMOTE-NOT-CONFIRMED refusal.',
    content: 'This entry cites src/demote-basis.ts and is promoted twice so kb_demote has a legal CONFIRMED target.',
    source_files: ['src/demote-basis.ts'],
  });
  const idDemote = parseEnvelopeText(captureForDemote)?.id;
  if (idDemote) {
    await recordHappy('kb_promote', 'setup-first-promote-for-demote', {
      id: idDemote,
      reason: 'First promotion (UNVERIFIED -> INFERRED) of the entry the kb_demote fixtures act on.',
    });
    await recordHappy('kb_promote', 'setup-second-promote-for-demote', {
      id: idDemote,
      reason: 'Second promotion (INFERRED -> CONFIRMED) so kb_demote has a CONFIRMED entry to lower.',
    });
    await recordHappy('kb_demote', 'happy', {
      id: idDemote,
      reason: 'Re-read src/demote-basis.ts and the claim holds in fewer cases than the promotion note asserts.',
      evidence_files: ['src/demote-basis.ts'],
    });
    // Now INFERRED: kb_demote is not a ladder, so this is a REFUSAL rather
    // than a second step down or an unchanged no-op return.
    await recordRefusal('kb_demote', 'refusal-not-confirmed', {
      id: idDemote,
      reason: 'Attempting to demote the same entry again, after the call above already lowered it to INFERRED.',
    }, 'E-DEMOTE-NOT-CONFIRMED');

    // --- kb_bible_commit tombstone ------------------------------------------
    // Exercises demoted_ids end to end in ONE call: idDemote is now INFERRED
    // (demoted just above) with a demoted_at, so it is admitted -- removed from
    // entries and recorded as an {id, demoted_at} tombstone in the bible's
    // demotions array. idFoo (still CONFIRMED at this point -- this call does
    // not touch it) was never demoted, so it is reported SKIPPED with reason
    // not_demoted_or_unknown rather than as an error. ids is empty: this round
    // confirms nothing new, only tombstones.
    if (idFoo) {
      await recordHappy('kb_bible_commit', 'tombstone', {
        ids: [],
        demoted_ids: [idDemote, idFoo],
        baseBranch: 'main',
        baseCommit: '0123456789abcdef0123456789abcdef01234567',
      });
    }
  }
}

// --- kb_query trust filters (after kb_promote, so idFoo is CONFIRMED) -------
// Same query as kb_query/happy, restricted to CONFIRMED and non-disputed
// entries: the INFERRED context-cache entry that happy.json returns must be
// absent here, and related_claims must obey the same filter.
if (idFoo) {
  await recordHappy('kb_query', 'happy-confirmed-only', {
    query: 'exampleFn',
    confidence: ['CONFIRMED'],
    exclude_disputed: true,
    expand_related: true,
  });
}

// --- kb_stats -------------------------------------------------------------
await recordHappy('kb_stats', 'happy', {
  symbols: ['exampleFn'],
});

const bibleFromA = path.join(repoA, '.fleet', 'kb-canonical.json');

// --- kb_import (into a genuinely separate KB -- repoB / REMOTE_B slug) ----
// Imported INTO member B's own KB (session B); `path` only names A's bible file.
await withSession('B', () => recordHappy('kb_import', 'happy', {
  path: bibleFromA,
}));

// --- kb_import of the v3 bible: the carried basis travels -------------------
// Repo A's bible is format v3, so its entry carries source_file_hashes. Repo B
// now has the cited file with DIFFERENT content: the import stores A's carried
// hash (never a re-hash of B's file) and the post-import sweep stales it.
{
  fs.mkdirSync(path.join(repoB, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoB, 'src', 'example.ts'), 'export function exampleFn(x: number): number {\n  return x + 2;\n}\n');
  const v3Import = await withSession('B', () => recordHappy('kb_import', 'happy-v3-carried-basis', {
    path: bibleFromA,
  }));
  const report = parseEnvelopeText(v3Import);
  if (!(report?.imported === 1 && report?.rejected === 0 && report?.sweep?.staled === 1)) {
    failures++;
    console.log(`  [FAIL] kb_import/happy-v3-carried-basis: expected imported 1, rejected 0, sweep.staled 1, got ${JSON.stringify(report)}`);
  }
}

// --- kb_freshness_sweep ---------------------------------------------------
await recordHappy('kb_freshness_sweep', 'happy', {
});

// --- kb_feedback ------------------------------------------------------
// A MEMBER session's KB reads come from the read-only checkout bible view:
// kb_feedback refuses with E-MEMBER-VIEW-READ-ONLY before any KB is opened and
// changes nothing. The same request from the FULL (non-member) session FULL_A
// -- whose server working folder is repo A, so it shares A's KB -- succeeds.
if (idFoo) {
  const feedbackRequest = {
    id: idFoo,
    reason: 'On re-check, the summary overstated precision -- exampleFn is untyped-input tolerant, unlike the note implies.',
    role: 'reviewer',
  };
  await recordRefusal('kb_feedback', 'refusal-member-view-read-only', feedbackRequest, 'E-MEMBER-VIEW-READ-ONLY');
  await withSession('FULL_A', () => recordHappy('kb_feedback', 'happy', feedbackRequest));
}

// --- kb_harvest -------------------------------------------------------
await recordHappy('kb_harvest', 'happy', {
  session_transcript:
    'Note: the helper in `computeThing` inside src/example.ts had a subtle rounding bug that is now fixed after tightening the threshold check.',
  session_id: 'sess-fixture-1',
});

// --- Contradiction pair: kb_reconcile_prefilter + kb_resolve_contradiction -
const captureBroken = await recordHappy('kb_capture', 'happy-contradiction-a', {
  type: 'learning',
  title: 'helperBar is broken',
  summary: 'helperBar in src/helper.ts is broken under concurrent calls.',
  content: 'helperBar is broken: it silently drops the second concurrent call.',
  source_files: ['src/helper.ts'],
  symbols: ['helperBar'],
});
const idBroken = parseEnvelopeText(captureBroken)?.id;

const captureFixed = await recordHappy('kb_capture', 'happy-contradiction-b', {
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
});

if (idBroken && idFixed) {
  await recordHappy('kb_resolve_contradiction', 'happy', {
    winnerId: idFixed,
    loserId: idBroken,
    evidence: 'Re-read src/helper.ts after the fix landed: the re-entrancy guard is present and concurrent calls no longer collide.',
  });
}

// --- kb_invalidate ------------------------------------------------------
await recordHappy('kb_invalidate', 'happy', {
  files: ['src/example.ts'],
});

// --- code_* (7 provider tools; code_reindex/code_status below) -- code (self): no repo argument; the CODE member
// session (provider pinned to gitnexus) resolves its own work folder, a git
// repo with no .gitnexus/meta.json, so every tool honestly refuses with
// E-CODE-INDEX-NOT-READY from the pre-flight, without ever spawning the
// gitnexus child process.
// NOTE (self-heal): the committed refusal-index-not-ready fixtures carry the
// "An index build was requested automatically." variant -- the contract for a
// missing index whose background build request succeeded, which is what the
// vitest roundtrip produces (tests/setup.ts fakes the build request, so each
// call sees the same outcome). Recording here against the real build instead
// requests ONE real detached analyze in this scratch repo on the first call;
// later calls then read "still being built" (or the npx-not-found variant when
// npx is absent), so do not re-record these 7 fixtures with this script --
// edit them to match indexNotReadyError's "requested" text instead.
await withSession('CODE', async () => {
  await recordRefusal('code_graph', 'refusal-index-not-ready', { symbol: 'exampleFn' }, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_impact', 'refusal-index-not-ready', { target: 'exampleFn', direction: 'upstream' }, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_query', 'refusal-index-not-ready', { query: 'exampleFn' }, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_context', 'refusal-index-not-ready', { name: 'exampleFn' }, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_map', 'refusal-index-not-ready', {}, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_flow', 'refusal-index-not-ready', { name: 'exampleFn' }, 'E-CODE-INDEX-NOT-READY');
  await recordRefusal('code_tests', 'refusal-index-not-ready', { symbol: 'exampleFn' }, 'E-CODE-INDEX-NOT-READY');
});
// Provider 'none': an error result, never an ok "disabled" payload.
await withSession('CODE_OFF', () => recordRefusal('code_query', 'refusal-intel-disabled', { query: 'exampleFn' }, 'E-CODE-INTEL-DISABLED'));
await withSession('CODE_OFF', () => recordRefusal('code_reindex', 'refusal-intel-disabled', {}, 'E-CODE-INTEL-DISABLED'));
await withSession('CODE_OFF', () => recordRefusal('code_status', 'refusal-intel-disabled', {}, 'E-CODE-INTEL-DISABLED'));
// Provider 'codebase-memory' (any non-gitnexus, non-none provider): a typed
// not-started result, not an error, and gitnexus analyze is never spawned.
const providerNote = "code_reindex/code_status gate on the member's provider: only 'gitnexus' runs the fleet-level analyze/status; any other configured provider returns { outcome:'not-started', reason:'provider-not-supported', provider, indexedCommit:null, detail } as a normal result (no taxonomy code).";
await withSession('CODE_CM', () => recordNonErrorOutcome('code_reindex', 'non-error-provider-not-supported', {}, providerNote));
await withSession('CODE_CM', () => recordNonErrorOutcome('code_status', 'non-error-provider-not-supported', {}, providerNote));

// ===========================================================================
// PASS 2 -- hardening: taxonomy-coded refusals + one documented non-error
// outcome. NOT exhaustive (see notes below and T7 gap list printed at the
// end) -- ships whatever fits per the bead's own "gap is a named T7 input,
// not silent debt" allowance.
// ===========================================================================
console.log('== PASS 2: refusal + non-error-outcome fixtures ==');

// -- validation group (all 7 codes) ---------------------------------------
await recordRefusal('kb_query', 'refusal-no-selector', {
}, 'E-QUERY-NO-SELECTOR');

// E-SCOPE-KEY-REMOVED: one per kb_* tool family (read, write, bible,
// maintenance), each with a different removed key.
await recordRefusal('kb_query', 'refusal-scope-key-removed', {
  query: 'exampleFn',
  repo_path: '/elsewhere/other-repo',
}, 'E-SCOPE-KEY-REMOVED');
await recordRefusal('kb_capture', 'refusal-scope-key-removed', {
  type: 'knowledge',
  title: 'Never stored: carries a removed scope key',
  summary: 'A capture naming another repository by a removed key is refused.',
  content: 'Refused before any KB is resolved, so nothing is written anywhere.',
  source_files: ['src/example.ts'],
  repo_remote_url: 'https://example.test/some-other-repo.git',
}, 'E-SCOPE-KEY-REMOVED');
await withSession('FULL_A', () => recordRefusal('kb_export', 'refusal-scope-key-removed', {
  repo_path: '/elsewhere/other-repo',
}, 'E-SCOPE-KEY-REMOVED'));
await recordRefusal('kb_freshness_sweep', 'refusal-scope-key-removed', {
  repo: '/elsewhere/other-repo',
}, 'E-SCOPE-KEY-REMOVED');

await recordRefusal('kb_context', 'refusal-path-traversal', {
  files: ['../outside-the-repo.txt'],
}, 'E-PATH-TRAVERSAL');

// A remote member session: its folder lives on another host, so
// kb_bible_commit (which writes the bible there) refuses. (kb_export has no
// such case: no member session is served it, and a FULL session's folder is
// the server's own working folder.)
await withSession('REMOTE_UNREACHABLE', () => recordRefusal('kb_bible_commit', 'refusal-repo-path-invalid', {
  ids: [],
  baseBranch: 'main',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
}, 'E-REPO-PATH-INVALID'));

// E-BIBLE-BASIS-NOT-GIT: the BARE session's folder is a bare git repository
// with an origin remote -- a valid KB identity, but not a git work tree, so
// bible admission cannot read cited files at HEAD. A CONFIRMED entry must
// exist first: admission (and so the git check) only runs for candidates.
{
  const repoBare = world.repoPaths.get('BARE');
  fs.mkdirSync(path.join(repoBare, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoBare, 'src', 'bare-basis.ts'), 'export const bare = 1;\n');
  const captureBare = await withSession('BARE', () => recordHappy('kb_capture', 'setup-for-bible-basis-not-git', {
    type: 'knowledge',
    title: 'Entry in a bare repository with no work tree',
    summary: 'Set up to demonstrate the E-BIBLE-BASIS-NOT-GIT refusal of kb_export and kb_bible_commit.',
    content: 'This entry cites src/bare-basis.ts in a bare repository, where no file can be read at HEAD of a work tree.',
    source_files: ['src/bare-basis.ts'],
  }));
  const idBare = parseEnvelopeText(captureBare)?.id;
  if (idBare) {
    await withSession('BARE', () => recordHappy('kb_promote', 'setup-first-promote-for-bible-basis-not-git', {
      id: idBare,
      reason: 'First promotion (UNVERIFIED -> INFERRED) of the entry used by the E-BIBLE-BASIS-NOT-GIT fixtures.',
    }));
    await withSession('BARE', () => recordHappy('kb_promote', 'setup-second-promote-for-bible-basis-not-git', {
      id: idBare,
      reason: 'Second promotion (INFERRED -> CONFIRMED) so bible admission runs for this entry.',
    }));
    await withSession('FULL_BARE', () => recordRefusal('kb_export', 'refusal-bible-basis-not-git', {}, 'E-BIBLE-BASIS-NOT-GIT'));
    await withSession('BARE', () => recordRefusal('kb_bible_commit', 'refusal-bible-basis-not-git', {
      ids: [idBare],
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    }, 'E-BIBLE-BASIS-NOT-GIT'));
  }
}

// kb (self) resolution refusals: the calling member's folder cannot carry a KB identity.
await withSession('NO_WORKFOLDER', () => recordRefusal('kb_query', 'refusal-self-no-workfolder', {
  query: 'exampleFn',
}, 'E-SELF-NO-WORKFOLDER'));
await withSession('NOT_A_REPO', () => recordRefusal('kb_stats', 'refusal-self-not-a-repo', {}, 'E-SELF-NOT-A-REPO'));
await withSession('NO_REMOTE', () => recordRefusal('kb_list', 'refusal-self-no-remote', {}, 'E-SELF-NO-REMOTE'));
// code (self) resolution refusals: the same shared resolver, minus the
// origin-remote check (a code index is keyed by folder, not KB identity).
await withSession('NO_WORKFOLDER', () => recordRefusal('code_query', 'refusal-self-no-workfolder', {
  query: 'exampleFn',
}, 'E-SELF-NO-WORKFOLDER'));
await withSession('NOT_A_REPO', () => recordRefusal('code_map', 'refusal-self-not-a-repo', {}, 'E-SELF-NOT-A-REPO'));
// code_reindex / code_status resolve (self) the same way; a refusal is the
// deterministic case (a happy code_reindex would spawn a real analyze).
await withSession('NO_WORKFOLDER', () => recordRefusal('code_reindex', 'refusal-self-no-workfolder', {}, 'E-SELF-NO-WORKFOLDER'));
await withSession('NOT_A_REPO', () => recordRefusal('code_status', 'refusal-self-not-a-repo', {}, 'E-SELF-NOT-A-REPO'));

await recordRefusal('kb_import', 'refusal-bible-not-found', {
  path: path.join(repoA, '.fleet', 'no-such-bible.json'),
}, 'E-BIBLE-NOT-FOUND');

const notJsonPath = path.join(repoA, '.fleet', 'not-json.json');
fs.writeFileSync(notJsonPath, 'this is not valid JSON {{{', 'utf-8');
await recordRefusal('kb_import', 'refusal-bible-not-json', {
  path: notJsonPath,
}, 'E-BIBLE-NOT-JSON');

const wrongShapePath = path.join(repoA, '.fleet', 'wrong-shape.json');
fs.writeFileSync(wrongShapePath, JSON.stringify({ not: 'an array or an entries envelope' }), 'utf-8');
await recordRefusal('kb_import', 'refusal-bible-wrong-shape', {
  path: wrongShapePath,
}, 'E-BIBLE-WRONG-SHAPE');

// -- admission group (all 3 codes) ----------------------------------------
await recordRefusal('kb_capture', 'refusal-no-basis', {
  type: 'knowledge',
  title: 'An entry with no cited source files',
  summary: 'This capture cites no source_files at all.',
  content: 'Nothing here can ever be falsified by the freshness sweep.',
}, 'E-NO-BASIS');

await recordRefusal('kb_capture', 'refusal-basis-missing-files', {
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
await withSession('IMPORT_REJECTED', () => recordResponseFieldRefusal(
  'kb_import',
  'refusal-import-entry-rejected',
  { path: rejectedBiblePath },
  'E-IMPORT-ENTRY-REJECTED',
  (response) => {
    const payload = parseEnvelopeText(response);
    return !!payload && payload.rejected >= 1;
  },
));

// -- authority group (all 3 codes) ----------------------------------------
await recordRefusal('kb_promote', 'refusal-reason-required', {
  id: idFoo ?? 'placeholder-id',
}, 'E-PROMOTE-REASON-REQUIRED');

if (idBroken) {
  // idBroken was superseded by the resolve_contradiction call above.
  await recordRefusal('kb_promote', 'refusal-superseded', {
    id: idBroken,
    reason: 'Attempting to re-promote an entry that was already superseded by the contradiction resolution above.',
  }, 'E-PROMOTE-SUPERSEDED');
}

fs.writeFileSync(path.join(repoA, 'src', 'soon-to-be-deleted.ts'), 'export const placeholder = 1;\n');
const captureForBasisLoss = await recordHappy('kb_capture', 'setup-for-basis-unresolved', {
  type: 'knowledge',
  title: 'Entry whose basis file will be deleted before a second promote',
  summary: 'Set up to demonstrate E-PROMOTE-BASIS-UNRESOLVED.',
  content: 'This entry cites src/soon-to-be-deleted.ts, which is removed before the second promote call.',
  source_files: ['src/soon-to-be-deleted.ts'],
});
const idBasisLoss = parseEnvelopeText(captureForBasisLoss)?.id;
if (idBasisLoss) {
  await recordHappy('kb_promote', 'setup-first-promote-for-basis-unresolved', {
    id: idBasisLoss,
    reason: 'First promotion (UNVERIFIED -> INFERRED) while the basis file still exists.',
  });
  fs.rmSync(path.join(repoA, 'src', 'soon-to-be-deleted.ts'));
  await recordRefusal('kb_promote', 'refusal-basis-unresolved', {
    id: idBasisLoss,
    reason: 'Second promotion attempted after the cited basis file was deleted.',
  }, 'E-PROMOTE-BASIS-UNRESOLVED');
}

// -- not_found group (both codes) -----------------------------------------
await recordRefusal('kb_promote', 'refusal-entry-not-found', {
  id: 'fixture-does-not-exist',
  reason: 'Attempting to promote an id that was never captured.',
}, 'E-ENTRY-NOT-FOUND');

await recordRefusal('kb_resolve_contradiction', 'refusal-resolve-missing-entry', {
  winnerId: 'fixture-does-not-exist-winner',
  loserId: 'fixture-does-not-exist-loser',
  evidence: 'Neither id was ever captured.',
}, 'E-RESOLVE-MISSING-ENTRY');

// -- conflict group (both codes) ------------------------------------------
if (idFoo && idBasisLoss) {
  await recordRefusal('kb_resolve_contradiction', 'refusal-not-a-pair', {
    winnerId: idFoo,
    loserId: idBasisLoss,
    evidence: 'These two entries were never linked as a contradiction pair.',
  }, 'E-RESOLVE-NOT-A-PAIR');
}

if (idBroken && idFixed) {
  // The pair was already resolved above; resolving it again hits the
  // already-superseded guard.
  await recordRefusal('kb_resolve_contradiction', 'refusal-already-superseded', {
    winnerId: idFixed,
    loserId: idBroken,
    evidence: 'Re-resolving an already-resolved contradiction pair.',
  }, 'E-RESOLVE-ALREADY-SUPERSEDED');
}

// -- governance group (2 of 5 reachable without CLI directive activation) --
const captureDirective = await recordHappy('kb_capture', 'happy-user-directive-proposal', {
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
  { type: 'user-directive', confidence: ['UNVERIFIED'], symbol: undefined },
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
    id: idDirective,
    reason: 'Attempting to promote a user-directive proposal directly, bypassing CLI activation.',
  }, 'E-PROMOTE-REFUSED-DIRECTIVE');
}

// -- non-error outcome (authority group's silent clamp branch) -----------
await recordNonErrorOutcome('kb_capture', 'non-error-confidence-clamped', {
  type: 'knowledge',
  title: 'A capture that asks for CONFIRMED directly',
  summary: 'kb_capture always clamps an incoming CONFIRMED down to INFERRED; CONFIRMED is only minted by kb_promote.',
  content: 'This entry requests confidence: CONFIRMED at capture time.',
  source_files: ['src/example.ts'],
  confidence: 'CONFIRMED',
}, 'authority group, non_error_outcomes: the silent clamp branch gets no taxonomy code by design (taxonomy.json _meta.group_definitions.authority). Observable via confidence_clamped:true in the response, not via a thrown/response-field error code.');

// -- kb_bible_commit removes a bible entry the KB holds as invalidated -----
// A CONFIRMED entry citing a committed seed file is merged into repo A's
// bible, discarded by id (kb_invalidate), and the next kb_bible_commit with no
// ids removes it and reports it in removed with reason invalidated.
{
  const captureRemoval = await recordHappy('kb_capture', 'setup-for-bible-removal', {
    type: 'knowledge',
    title: 'Entry merged into the bible and then invalidated',
    summary: 'Set up to demonstrate kb_bible_commit removing an invalidated bible entry.',
    content: 'This entry cites the committed src/helper.ts, is merged into the bible, then discarded by id.',
    source_files: ['src/helper.ts'],
    symbols: ['helperRemovalFixture'],
  });
  const idRemoval = parseEnvelopeText(captureRemoval)?.id;
  if (idRemoval) {
    await recordHappy('kb_promote', 'setup-first-promote-for-bible-removal', {
      id: idRemoval,
      reason: 'First promotion (UNVERIFIED -> INFERRED) of the entry used by the bible removal fixture.',
    });
    await recordHappy('kb_promote', 'setup-second-promote-for-bible-removal', {
      id: idRemoval,
      reason: 'Second promotion (INFERRED -> CONFIRMED) so the entry can be merged into the bible.',
    });
    await recordHappy('kb_bible_commit', 'setup-merge-for-bible-removal', {
      ids: [idRemoval],
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    await recordHappy('kb_invalidate', 'setup-invalidate-for-bible-removal', { ids: [idRemoval] });
    await recordHappy('kb_bible_commit', 'happy-removes-invalidated', {
      ids: [],
      baseBranch: 'main',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
    });
  }
}

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
