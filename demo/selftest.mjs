#!/usr/bin/env node
// demo/selftest.mjs
//
// Usage: node demo/selftest.mjs
//
// Exercises collect-metrics.mjs and gain-report.mjs end to end against
// synthetic fixtures, WITHOUT touching:
//   - the real C:\ws_yash\demo-upgrade sandbox/data dirs
//   - the operator's real ~/.apra-fleet data (usage.jsonl reads are pointed
//     at a fake homedir via DEMO_REAL_HOMEDIR)
//   - this repo (apra-fleet itself is never used as a sandbox)
//
// All scratch state lives under a fresh os.tmpdir() directory, deleted at
// the end (best-effort -- a leftover temp dir is not a test failure).
//
// Coverage:
//   1. collect-metrics against a synthetic Env A sandbox (progress.json
//      present, no KB -- the released-binary shape) for sprint1 + sprint2.
//   2. collect-metrics against a synthetic Env B sandbox (progress.json +
//      kb.sqlite + .fleet/kb-canonical.json + usage.jsonl -- the branch-build
//      shape) for sprint1 + sprint2.
//   3. The degrade path: a sandbox with NO progress.json at all (simulating
//      either a vendored pm with no dispatches ledger, or a simple-sprint
//      flow), asserting nulls + a note instead of a throw.
//   4. gain-report.mjs against the checked-in demo/fixtures/metrics-*.sample.json
//      (a fully-populated, hand-authored pair covering the honesty-footnote
//      path) and against the metrics files collect-metrics just produced in
//      steps 1-2 (the full pipeline, not just canned data).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, detail: err && err.stack ? err.stack : String(err) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
}
function gitCommit(dir, file, contents, message) {
  fs.writeFileSync(path.join(dir, file), contents);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@local', 'commit', '-q', '-m', message], { cwd: dir });
}

function runCollector(env, sprint, envVars) {
  const script = path.join(__dirname, 'collect-metrics.mjs');
  execFileSync(NODE, [script, env, sprint], { env: { ...process.env, ...envVars }, stdio: 'pipe' });
}

function runGainReport(envVars) {
  const script = path.join(__dirname, 'gain-report.mjs');
  execFileSync(NODE, [script], { env: { ...process.env, ...envVars }, stdio: 'pipe' });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-demo-selftest-'));
console.log('selftest: scratch dir = ' + tmpRoot);

// -----------------------------------------------------------------------
// 1. Synthetic Env A sandbox: progress.json present, no KB.
// -----------------------------------------------------------------------
const sandboxA = path.join(tmpRoot, 'sandbox-a');
const dataA = path.join(tmpRoot, 'data-a');
const metricsDirA = path.join(tmpRoot, 'metrics-a-out');
fs.mkdirSync(metricsDirA, { recursive: true });
gitInit(sandboxA);
fs.copyFileSync(path.join(__dirname, 'fixtures', 'progress-sprint1.json'), path.join(sandboxA, 'progress.json'));
gitCommit(sandboxA, 'notes.ts', '// sprint 1 change', 'feat: archiving');

await check('collect-metrics A sprint1 does not throw', () => {
  runCollector('A', 'sprint1', { DEMO_SANDBOX_DIR: sandboxA, DEMO_DATA_DIR: dataA, DEMO_METRICS_DIR: metricsDirA });
});

// Overwrite progress.json with the sprint2 fixture before the second collection,
// simulating the doer/reviewer loop rewriting it in place for the new phase.
fs.copyFileSync(path.join(__dirname, 'fixtures', 'progress-sprint2.json'), path.join(sandboxA, 'progress.json'));
gitCommit(sandboxA, 'notes.ts', '// sprint 2 change', 'feat: pagination');

await check('collect-metrics A sprint2 does not throw', () => {
  runCollector('A', 'sprint2', { DEMO_SANDBOX_DIR: sandboxA, DEMO_DATA_DIR: dataA, DEMO_METRICS_DIR: metricsDirA });
});

await check('metrics-A.json has 2 snapshots with expected dispatch totals', () => {
  const arr = JSON.parse(fs.readFileSync(path.join(metricsDirA, 'metrics-A.json'), 'utf-8'));
  assert(arr.length === 2, 'expected 2 snapshots, got ' + arr.length);
  assert(arr[0].sprint === 'sprint1' && arr[1].sprint === 'sprint2', 'sprint order wrong');
  assert(arr[0].progress.found === true, 'sprint1 progress.json should be found');
  assert(arr[0].progress.totals.tokens === 72800, 'sprint1 token total mismatch: ' + arr[0].progress.totals.tokens);
  assert(arr[1].progress.totals.tokens === 34700, 'sprint2 token total mismatch: ' + arr[1].progress.totals.tokens);
  assert(arr[0].kb === null && arr[0].bible === null && arr[0].usage === null, 'Env A must not populate kb/bible/usage');
  assert(arr[0].git.commit_count >= 2, 'expected at least 2 commits in Env A sandbox');
});

// -----------------------------------------------------------------------
// 2. Synthetic Env B sandbox: progress.json + kb.sqlite + bible + usage.jsonl.
// -----------------------------------------------------------------------
const sandboxB = path.join(tmpRoot, 'sandbox-b');
const dataB = path.join(tmpRoot, 'data-b');
const fakeHome = path.join(tmpRoot, 'fake-home');
const metricsDirB = path.join(tmpRoot, 'metrics-b-out');
fs.mkdirSync(metricsDirB, { recursive: true });
gitInit(sandboxB);
fs.copyFileSync(path.join(__dirname, 'fixtures', 'progress-sprint1.json'), path.join(sandboxB, 'progress.json'));
fs.mkdirSync(path.join(sandboxB, '.fleet'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'kb-canonical-sample.json'), path.join(sandboxB, '.fleet', 'kb-canonical.json'));
gitCommit(sandboxB, '.fleet/kb-canonical.json', fs.readFileSync(path.join(sandboxB, '.fleet', 'kb-canonical.json'), 'utf-8'), 'kb: export canonical bible');

// slug must match metrics-lib's resolveProjectSlug() -- import the same
// function rather than re-deriving it, so a future change to the slug
// algorithm cannot silently desync the test from the collector.
const { resolveProjectSlug } = await import('./lib/metrics-lib.mjs');
const slugB = resolveProjectSlug(sandboxB);
const kbDir = path.join(dataB, 'knowledge', slugB);
fs.mkdirSync(kbDir, { recursive: true });

await check('build a synthetic kb.sqlite for Env B via node:sqlite', () => {
  // node:sqlite is a Node 22+ experimental builtin; skip gracefully if unavailable.
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(path.join(kbDir, 'kb.sqlite'));
    db.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY, confidence TEXT, type TEXT, stale INTEGER DEFAULT 0,
      flagged_for_review INTEGER DEFAULT 0, superseded_at TEXT, promoted_at TEXT,
      created_at TEXT, use_count INTEGER DEFAULT 0, last_accessed TEXT,
      symbols TEXT DEFAULT '[]', source_files TEXT DEFAULT '[]', tags TEXT DEFAULT '[]'
    )`);
    const insert = db.prepare(`INSERT INTO entries
      (id, confidence, type, stale, flagged_for_review, superseded_at, created_at, use_count)
      VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`);
    insert.run('e1', 'CONFIRMED', 'knowledge', '2026-07-08T10:00:00.000Z', 2);
    insert.run('e2', 'INFERRED', 'learning', '2026-07-08T10:05:00.000Z', 0);
    insert.run('e3', 'UNVERIFIED', 'context-cache', '2026-07-08T10:10:00.000Z', 1);
    db.close();
  });
});

// usage.jsonl -- deliberately includes a record for a DIFFERENT repo to
// prove the repo-path filter in readUsage() actually filters, not just counts everything.
fs.mkdirSync(path.join(fakeHome, '.apra-fleet', 'data', 'code-intelligence'), { recursive: true });
const usageLines = [
  { ts: '2026-07-10T12:00:00.000Z', tool: 'code_query', target: 'listNotes', repo: path.resolve(sandboxB) },
  { ts: '2026-07-10T12:01:00.000Z', tool: 'kb_session_prime', target: 'sprint2', repo: path.resolve(sandboxB) },
  { ts: '2026-07-10T12:02:00.000Z', tool: 'code_query', target: 'unrelated', repo: path.resolve(path.join(tmpRoot, 'some-other-repo')) },
].map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(path.join(fakeHome, '.apra-fleet', 'data', 'code-intelligence', 'usage.jsonl'), usageLines);

await check('collect-metrics B sprint1 does not throw', () => {
  runCollector('B', 'sprint1', { DEMO_SANDBOX_DIR: sandboxB, DEMO_DATA_DIR: dataB, DEMO_METRICS_DIR: metricsDirB, DEMO_REAL_HOMEDIR: fakeHome });
});

fs.copyFileSync(path.join(__dirname, 'fixtures', 'progress-sprint2.json'), path.join(sandboxB, 'progress.json'));
gitCommit(sandboxB, 'notes.ts', '// sprint 2 change (env b)', 'feat: pagination');

await check('collect-metrics B sprint2 does not throw', () => {
  runCollector('B', 'sprint2', { DEMO_SANDBOX_DIR: sandboxB, DEMO_DATA_DIR: dataB, DEMO_METRICS_DIR: metricsDirB, DEMO_REAL_HOMEDIR: fakeHome });
});

await check('metrics-B.json has KB/bible/usage populated and usage is repo-filtered', () => {
  const arr = JSON.parse(fs.readFileSync(path.join(metricsDirB, 'metrics-B.json'), 'utf-8'));
  assert(arr.length === 2, 'expected 2 snapshots, got ' + arr.length);
  const s1 = arr[0];
  assert(s1.kb && s1.kb.available === true, 'kb should be available for Env B');
  assert(s1.kb.totals.total === 3, 'expected 3 kb entries, got ' + (s1.kb.totals && s1.kb.totals.total));
  assert(s1.kb.totals.by_confidence.CONFIRMED === 1, 'expected 1 CONFIRMED entry');
  assert(s1.bible && s1.bible.present === true && s1.bible.entries === 2, 'bible should have 2 entries');
  assert(s1.bible.commits >= 1, 'bible should have at least 1 commit');
  assert(s1.usage && s1.usage.available === true, 'usage should be available');
  assert(s1.usage.total_calls === 2, 'usage should be filtered to the 2 records for this sandbox, got ' + s1.usage.total_calls);
});

// -----------------------------------------------------------------------
// 3. Degrade path: no progress.json at all.
// -----------------------------------------------------------------------
const sandboxNoLedger = path.join(tmpRoot, 'sandbox-no-ledger');
const dataNoLedger = path.join(tmpRoot, 'data-no-ledger');
const metricsDirNoLedger = path.join(tmpRoot, 'metrics-no-ledger-out');
fs.mkdirSync(metricsDirNoLedger, { recursive: true });
gitInit(sandboxNoLedger);

await check('collect-metrics degrades gracefully with no progress.json (vendored-pm-without-ledger simulation)', () => {
  runCollector('A', 'sprint1', { DEMO_SANDBOX_DIR: sandboxNoLedger, DEMO_DATA_DIR: dataNoLedger, DEMO_METRICS_DIR: metricsDirNoLedger });
  const arr = JSON.parse(fs.readFileSync(path.join(metricsDirNoLedger, 'metrics-A.json'), 'utf-8'));
  assert(arr[0].progress.found === false, 'progress.found should be false');
  assert(arr[0].progress.totals === null, 'progress.totals should be null');
  assert(arr[0].notes.some(n => n.includes('no progress.json found')), 'expected a note explaining the missing ledger');
});

await check('collect-metrics refuses to run against a nonexistent sandbox', () => {
  let threw = false;
  try {
    runCollector('A', 'sprint1', { DEMO_SANDBOX_DIR: path.join(tmpRoot, 'does-not-exist'), DEMO_DATA_DIR: dataA, DEMO_METRICS_DIR: metricsDirA });
  } catch {
    threw = true;
  }
  assert(threw, 'expected a nonzero exit for a missing sandbox dir');
});

// -----------------------------------------------------------------------
// 4. gain-report.mjs: canned fixtures, then the freshly-produced metrics.
// -----------------------------------------------------------------------
await check('gain-report on checked-in demo/fixtures/metrics-*.sample.json', () => {
  const out = path.join(tmpRoot, 'gain-report-fixtures.html');
  runGainReport({
    DEMO_METRICS_A: path.join(__dirname, 'fixtures', 'metrics-A.sample.json'),
    DEMO_METRICS_B: path.join(__dirname, 'fixtures', 'metrics-B.sample.json'),
    DEMO_REPORT_OUT: out,
  });
  const html = fs.readFileSync(out, 'utf-8');
  assert(html.includes('Gain Report'), 'missing title');
  assert(html.includes('Sprint 2'), 'missing sprint 2 section');
  assert(html.includes('Honesty note'), 'missing honesty note');
  assert(html.includes('claude-haiku-4-5'), 'missing doer model mix data');
  assert(html.includes('fewer tokens') || html.includes('more tokens'), 'missing headline delta sentence');
});

await check('gain-report on the metrics produced by steps 1-2 (full pipeline)', () => {
  const out = path.join(tmpRoot, 'gain-report-pipeline.html');
  runGainReport({
    DEMO_METRICS_A: path.join(metricsDirA, 'metrics-A.json'),
    DEMO_METRICS_B: path.join(metricsDirB, 'metrics-B.json'),
    DEMO_REPORT_OUT: out,
  });
  const html = fs.readFileSync(out, 'utf-8');
  assert(html.includes('Gain Report'), 'missing title');
  assert(html.includes('KB entries captured'), 'missing Env-B-only capabilities section');
});

await check('gain-report degrades gracefully with a missing metrics file', () => {
  const out = path.join(tmpRoot, 'gain-report-missing.html');
  runGainReport({
    DEMO_METRICS_A: path.join(tmpRoot, 'does-not-exist-A.json'),
    DEMO_METRICS_B: path.join(metricsDirB, 'metrics-B.json'),
    DEMO_REPORT_OUT: out,
  });
  const html = fs.readFileSync(out, 'utf-8');
  assert(html.includes('n/a'), 'expected n/a placeholders when Env A data is entirely missing');
});

// -----------------------------------------------------------------------
// report + cleanup
// -----------------------------------------------------------------------
console.log('');
console.log('selftest results:');
let failures = 0;
for (const r of results) {
  console.log('  [' + (r.pass ? 'PASS' : 'FAIL') + '] ' + r.name);
  if (!r.pass) {
    failures++;
    console.log('    ' + r.detail.split('\n').join('\n    '));
  }
}
console.log('');
console.log(results.length - failures + '/' + results.length + ' checks passed');

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  console.log('(non-fatal: could not clean up ' + tmpRoot + ')');
}

process.exit(failures > 0 ? 1 : 0);
