#!/usr/bin/env node
// run-integ-suites-sequentially.mjs
//
// Per-suite runner for the apra-fleet-se real (bd-real) test suite, used by
// the "Unit-suite timing check" section of integ-test-playbook.md.
//
// Instead of one monolithic `npm test --workspace=@apralabs/apra-fleet-se`
// call (~16 minutes across ~38 files -- long enough to trip a dispatch
// watchdog and lose all progress), this script runs ONE .test.mjs file per
// invocation and records each file's result (pass/fail, exit code, elapsed
// seconds) in a durable JSON status file, so an interrupted pass resumes
// from where it left off instead of starting over.
//
// Platform-agnostic: pure Node (>=22), no shell-isms, works on Windows and
// POSIX. Requires only filesystem + child-process access (no MCP tools).
//
// Usage:
//   node scripts/run-integ-suites-sequentially.mjs --status
//       Print discovered/done/pending summary. Exit 0.
//   node scripts/run-integ-suites-sequentially.mjs --one
//       Run exactly the NEXT pending suite, record its result, exit with
//       that suite's exit code. If nothing is pending, print the final
//       summary and exit 0 if all recorded results pass, 1 otherwise.
//   node scripts/run-integ-suites-sequentially.mjs --fresh
//       Delete the status file (start a new pass). Exit 0.
//   node scripts/run-integ-suites-sequentially.mjs --help
//       Print this usage. Exit 0.
//
// Exit codes: 0 = ok / suite passed; 1 = suite failed (or, with no pending
// work, at least one recorded failure); 2 = infrastructure error (no test
// files discovered, stale status file, unreadable state). Exit 2 is always
// a fail-loud condition: file a bug bead, do not continue.
//
// Status file: integ-suite-status.json at the repo root (gitignored,
// throwaway state -- never commit it).

import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(repoRoot, 'packages', 'apra-fleet-se');
const testDir = path.join(pkgDir, 'test');
const statusFile = path.join(repoRoot, 'integ-suite-status.json');

const args = new Set(process.argv.slice(2));

function usage() {
  console.log([
    'Usage: node scripts/run-integ-suites-sequentially.mjs [--status|--one|--fresh|--help]',
    '  --status  print discovered/done/pending summary (default action)',
    '  --one     run the next pending suite, record result, exit with its exit code',
    '  --fresh   delete the status file to start a new pass',
    '  --help    this text',
    `Status file: ${statusFile}`,
  ].join('\n'));
}

function fail(msg) {
  console.error(`[integ-suites] ERROR: ${msg}`);
  console.error('[integ-suites] This is a fail-loud condition: file a bug bead, do not continue.');
  process.exit(2);
}

function discover() {
  if (!existsSync(testDir)) fail(`test directory not found: ${testDir}`);
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort();
  if (files.length === 0) fail(`no *.test.mjs files discovered under ${testDir}`);
  return files;
}

function loadStatus() {
  if (!existsSync(statusFile)) {
    return { startedAt: new Date().toISOString(), testDir: 'packages/apra-fleet-se/test', results: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch (e) {
    fail(`status file ${statusFile} is unreadable/corrupt (${e.message}); inspect it, then use --fresh to start over`);
  }
  if (!parsed || typeof parsed.results !== 'object' || parsed.results === null) {
    fail(`status file ${statusFile} has no "results" object; inspect it, then use --fresh to start over`);
  }
  return parsed;
}

function saveStatus(status) {
  writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n', 'utf8');
}

function checkStale(files, status) {
  const known = new Set(files);
  const stale = Object.keys(status.results).filter((f) => !known.has(f));
  if (stale.length > 0) {
    fail(
      `status file records results for files that no longer exist: ${stale.join(', ')}. ` +
      'The test directory changed mid-pass; use --fresh to start a new pass.'
    );
  }
}

function summarize(files, status) {
  const done = files.filter((f) => status.results[f]);
  const pending = files.filter((f) => !status.results[f]);
  const failed = done.filter((f) => !status.results[f].passed);
  const totalElapsed = done.reduce((s, f) => s + (status.results[f].elapsedSeconds || 0), 0);
  console.log(`[integ-suites] discovered=${files.length} done=${done.length} pending=${pending.length} failed=${failed.length} elapsedTotal=${totalElapsed}s`);
  for (const f of failed) {
    console.log(`[integ-suites]   FAIL ${f} exit=${status.results[f].exitCode} elapsed=${status.results[f].elapsedSeconds}s`);
  }
  if (pending.length > 0) {
    console.log(`[integ-suites]   next pending: ${pending[0]}`);
  } else {
    console.log(`[integ-suites] pass COMPLETE: every discovered file has a recorded result (${failed.length} failure(s)).`);
  }
  return { done, pending, failed, totalElapsed };
}

function runOne(files, status) {
  const pending = files.filter((f) => !status.results[f]);
  if (pending.length === 0) {
    const { failed } = summarize(files, status);
    process.exit(failed.length > 0 ? 1 : 0);
  }
  const file = pending[0];
  const idx = files.length - pending.length + 1;
  console.log(`[integ-suites] running ${idx}/${files.length}: ${file}`);
  const startMs = Date.now();
  // Mirrors the package's own "test" script invocation, scoped to one file
  // (concurrency flag omitted: it only parallelizes across files).
  //
  // REAL bd, not the mock: the bd-mock-shim work (sibling branch) makes the
  // mocked bd the DEFAULT for plain `npm test`. This runner is the playbook's
  // real-integration check, so it must force the real/unmocked mode.
  // TODO(bd-mock-shim merge): confirm the exact flag/script name the shim
  // branch lands (candidate: APRA_FLEET_BD_MOCK=0) and reconcile here. Setting
  // the env var is harmless on branches where the shim does not exist yet.
  const res = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=./test/helpers/timestamped-reporter.mjs',
      '--test-reporter-destination=stdout',
      path.join('test', file),
    ],
    { cwd: pkgDir, stdio: 'inherit', env: { ...process.env, APRA_FLEET_BD_MOCK: '0' } }
  );
  if (res.error) fail(`could not spawn node --test for ${file}: ${res.error.message}`);
  const elapsedSeconds = Math.round((Date.now() - startMs) / 1000);
  const exitCode = res.status === null ? -1 : res.status;
  status.results[file] = {
    exitCode,
    passed: exitCode === 0,
    elapsedSeconds,
    finishedAt: new Date().toISOString(),
  };
  saveStatus(status);
  console.log(`[integ-suites] result: ${file} ${exitCode === 0 ? 'PASS' : 'FAIL'} exit=${exitCode} elapsed=${elapsedSeconds}s`);
  summarize(files, status);
  process.exit(exitCode === 0 ? 0 : 1);
}

if (args.has('--help') || args.has('-h')) {
  usage();
  process.exit(0);
}
if (args.has('--fresh')) {
  if (existsSync(statusFile)) rmSync(statusFile);
  console.log(`[integ-suites] status file cleared: ${statusFile}`);
  process.exit(0);
}

const files = discover();
const status = loadStatus();
checkStale(files, status);

if (args.has('--one')) {
  runOne(files, status);
} else {
  // --status (also the default with no args)
  summarize(files, status);
  process.exit(0);
}
