#!/usr/bin/env node
// run-integ-suites.mjs
//
// Background supervisor + checkpoint runner for the apra-fleet-se real-bd
// test suite, used by the "Run the apra-fleet-se suite against real bd"
// section of integ-test-playbook.md.
//
// Design: ONE detached background run of
//   node --test --test-concurrency=8 <all pending files>
// keeps the full concurrency-8 wall-clock win (~6.5-8 min for the full
// suite, per TEST-VALUE-ANALYSIS.md / commit 72a929e), while a checkpoint
// reporter (scripts/integ-file-results-reporter.mjs) streams each FILE's
// result into a durable status file the instant that file finishes. The
// calling agent starts the run with one short --start call, then polls
// bounded --status --wait=N calls, narrating between polls. A crash mid-run
// is resumed by calling --start again: it recomputes pending files (those
// with no recorded result) and reruns only those. Every scenario uses an
// isolated temp dir, so rerunning an in-flight file is safe.
//
// The detached-background path was smoke-tested in the target dispatch
// environment (2026-07-17, Windows, Claude Code Bash tool): a
// detached+unref()'d Node child survived its parent tool call returning and
// completed 20s of work observed from later tool calls. If a future
// environment kills detached children, fall back to bounded foreground
// batches -- see the playbook.
//
// NO FAIL-FAST: node --test's default behavior continues past a failure in
// any one file (the package's own "test" script passes no --test-fail-fast
// and neither does this runner). The checkpoint reporter records failures
// and the run continues. Do not "improve" this into a fail-fast design.
//
// Platform-agnostic: pure Node (>=22), no shell-isms (no &/nohup/job
// control), works on Windows and POSIX.
//
// Usage:
//   node scripts/run-integ-suites.mjs --status [--wait=N]
//       Print one summary line (discovered/done/pending/failed/inflight/
//       elapsedWall/cumFileTime/live), then FAILED files only with captured
//       failure detail, then in-flight files if live. With --wait=N, poll
//       the status file for up to N seconds, returning early the moment the
//       recorded state changes. Exit codes below.
//   node scripts/run-integ-suites.mjs --start
//       Compute pending files and launch the detached background supervisor
//       over all of them at once. Returns immediately. Refuses if a run is
//       already live. Also the resume command after a crash.
//   node scripts/run-integ-suites.mjs --fresh
//       Delete the status/heartbeat/log files to start a brand-new measured
//       pass. NEVER use this to erase an inconvenient failure -- failures
//       stay recorded and get filed as bug beads first. Refuses if a run is
//       live.
//   node scripts/run-integ-suites.mjs --supervise <files...>
//       INTERNAL -- the detached supervisor process spawned by --start. Not
//       for direct human/agent use.
//   node scripts/run-integ-suites.mjs --help
//       Print this usage. Exit 0.
//
// --status exit codes:
//   0 = complete with zero failures (prints "pass COMPLETE"), or no run
//       recorded yet (does NOT print "pass COMPLETE" -- completion is the
//       "pass COMPLETE" line plus exit 0/1, never exit 0 alone)
//   1 = complete, failures recorded (prints "pass COMPLETE" with count)
//   3 = still running (live) -- poll again with --status --wait=N
//   2 = infra fail-loud: stale/corrupt status file, or run not live with
//       pending files remaining (crashed -- run --start to resume)
//
// Status file: integ-suite-status.json at the repo root (gitignored,
// throwaway state -- never commit it). Heartbeat:
// integ-suite-heartbeat.json. Supervisor log: integ-suite-run.log.

import {
  readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync,
  openSync, closeSync, statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const pkgDir = path.join(repoRoot, 'packages', 'apra-fleet-se');
const testDir = path.join(pkgDir, 'test');
const statusFile = path.join(repoRoot, 'integ-suite-status.json');
const heartbeatFile = path.join(repoRoot, 'integ-suite-heartbeat.json');
const logFile = path.join(repoRoot, 'integ-suite-run.log');
const reporterPath = path.join(repoRoot, 'scripts', 'integ-file-results-reporter.mjs');

const HEARTBEAT_STALE_MS = 120000;
const TEST_CONCURRENCY = 8;

// apra-fleet-eft.46.1: these two watchdog tests do real per-retry dolt/bd
// child-process work and, under concurrency=8, that dolt overhead contends
// with the other 7 files in the run and can push them past their own
// purpose-computed hang-detection timeout budgets (a scheduling artifact,
// not a correctness regression). Run them in their own low-concurrency lane,
// sequenced AFTER the main lane finishes (never overlapping it), so their
// dolt overhead is never contended with the rest of the suite. Do not widen
// this set casually -- it exists to avoid inflating the tests' own
// hang-detecting timeouts, which would risk re-masking the eft.28 hang.
const ISOLATED_LANE_FILES = new Set([
  'mock-sprint-planner-dispatch-dead-pid.test.mjs',
  'mock-sprint-planner-dispatch-stalled-session.test.mjs',
]);
const ISOLATED_LANE_CONCURRENCY = 1;

const argv = process.argv.slice(2);
const args = new Set(argv.filter((a) => !a.startsWith('--wait=')));
const waitArg = argv.find((a) => a.startsWith('--wait='));
const waitSeconds = waitArg ? Number(waitArg.slice('--wait='.length)) : 0;

function usage() {
  console.log([
    'Usage: node scripts/run-integ-suites.mjs [--status [--wait=N]|--start|--fresh|--help]',
    '  --status         summary line + FAILED files + in-flight files (default action)',
    '  --status --wait=N  bounded poll: return early on state change, else after N seconds',
    '  --start          launch (or resume) the detached background run; returns immediately',
    '  --fresh          delete status/heartbeat/log for a brand-new measured pass',
    '                   (never to erase a failure -- file the bug bead first)',
    '  --supervise ...  INTERNAL (spawned by --start; do not run directly)',
    '  --help           this text',
    'Exit codes for --status: 0 complete+pass or nothing recorded; 1 complete+failures;',
    '  3 still running (poll again); 2 infra fail-loud (stale/corrupt state, or crashed',
    '  with pending files -- run --start to resume).',
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
  if (!existsSync(statusFile)) return null;
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
  const tmp = statusFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8');
  renameSync(tmp, statusFile);
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function heartbeatAgeMs() {
  try {
    return Date.now() - statSync(heartbeatFile).mtimeMs;
  } catch {
    return Infinity;
  }
}

// "Live" = pid alive AND heartbeat fresh, so a reused PID after a crash
// cannot be mistaken for the same still-live run.
function isLive(status) {
  const run = status && status.run;
  if (!run || run.runComplete || !pidAlive(run.pid)) return false;
  return heartbeatAgeMs() < HEARTBEAT_STALE_MS;
}

function touchHeartbeat() {
  writeFileSync(heartbeatFile, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf8');
}

function computeSummary(files, status) {
  const results = status ? status.results : {};
  const done = files.filter((f) => results[f]);
  const pending = files.filter((f) => !results[f]);
  const failed = done.filter((f) => !results[f].passed);
  const cumFileMs = done.reduce((s, f) => s + (results[f].durationMs || 0), 0);
  const live = status ? isLive(status) : false;
  const run = status && status.run;
  let elapsedWallSeconds = null;
  if (run && run.startedAt) {
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    elapsedWallSeconds = Math.round((end - Date.parse(run.startedAt)) / 1000);
  }
  const inflight = live ? ((run && run.inflight) || []) : [];
  return { done, pending, failed, cumFileMs, live, inflight, elapsedWallSeconds };
}

function printSummary(files, status) {
  const s = computeSummary(files, status);
  console.log(
    `[integ-suites] discovered=${files.length} done=${s.done.length} pending=${s.pending.length} ` +
    `failed=${s.failed.length} inflight=${s.inflight.length} ` +
    `elapsedWall=${s.elapsedWallSeconds === null ? 'n/a' : s.elapsedWallSeconds + 's'} ` +
    `cumFileTime=${Math.round(s.cumFileMs / 1000)}s live=${s.live ? 'yes' : 'no'}`
  );
  // FAILED files only -- never enumerate passing files.
  for (const f of s.failed) {
    const rec = status.results[f];
    console.log(`[integ-suites]   FAIL ${f} elapsed=${rec.elapsedSeconds === null ? '?' : rec.elapsedSeconds}s`);
    for (const detail of rec.failures || []) {
      console.log(`[integ-suites]     ${detail.name}: ${String(detail.error).split('\n')[0]}`);
    }
  }
  if (s.live && s.inflight.length > 0) {
    console.log(`[integ-suites]   in-flight: ${s.inflight.join(', ')}`);
  }
  return s;
}

function stateFingerprint(files, status) {
  const s = computeSummary(files, status);
  return JSON.stringify([s.done.length, s.failed.length, s.live, !!(status && status.run && status.run.runComplete)]);
}

async function cmdStatus(files) {
  let status = loadStatus();
  if (status) checkStale(files, status);

  if (waitSeconds > 0) {
    const initial = stateFingerprint(files, status);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      status = loadStatus();
      if (stateFingerprint(files, status) !== initial) break;
    }
    if (status) checkStale(files, status);
  }

  if (!status) {
    console.log('[integ-suites] no run recorded -- start one with --start');
    process.exit(0);
  }

  const s = printSummary(files, status);
  if (s.pending.length === 0 && !s.live) {
    console.log(`[integ-suites] pass COMPLETE: every discovered file has a recorded result (${s.failed.length} failure(s)).`);
    process.exit(s.failed.length > 0 ? 1 : 0);
  }
  if (s.live) {
    console.log('[integ-suites] run is LIVE -- poll again with --status --wait=45');
    process.exit(3);
  }
  // Not live, pending > 0: crashed mid-run (or new files appeared after a
  // completed run). Either way: resume with --start.
  fail(
    `run is not live but ${s.pending.length} file(s) have no recorded result ` +
    '(crashed mid-run, or new test files appeared). Run --start to resume -- ' +
    'already-recorded results are kept and only pending files rerun.'
  );
}

function cmdStart(files) {
  const status = loadStatus() || { startedAt: new Date().toISOString(), testDir: 'packages/apra-fleet-se/test', results: {} };
  checkStale(files, status);
  if (isLive(status)) {
    console.log(`[integ-suites] a run is already live (supervisor pid=${status.run.pid}) -- poll it with --status --wait=45 instead.`);
    process.exit(3);
  }
  const pending = files.filter((f) => !status.results[f]);
  if (pending.length === 0) {
    printSummary(files, status);
    console.log('[integ-suites] nothing pending -- pass already COMPLETE. Use --status for the summary, --fresh for a new measured pass.');
    const failed = files.filter((f) => !status.results[f].passed);
    process.exit(failed.length > 0 ? 1 : 0);
  }

  const logFd = openSync(logFile, 'a');
  writeFileSync(logFd, `\n[integ-suites] ---- --start at ${new Date().toISOString()} (${pending.length} pending) ----\n`);
  const child = spawn(
    process.execPath,
    [scriptPath, '--supervise', ...pending],
    { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }
  );
  child.unref();
  closeSync(logFd);

  status.run = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    pendingFiles: pending,
    inflight: [],
    runComplete: false,
  };
  saveStatus(status);
  touchHeartbeat();

  console.log(
    `[integ-suites] started detached run: supervisor pid=${child.pid}, ${pending.length} file(s) pending ` +
    `(concurrency=${TEST_CONCURRENCY}). Poll with: node scripts/run-integ-suites.mjs --status --wait=45`
  );
  console.log(`[integ-suites] supervisor log: ${logFile}`);
  process.exit(0);
}

// Runs one node --test invocation over `files` at the given concurrency and
// resolves with its exit code (never rejects -- a spawn error resolves -1,
// mirroring the previous single-lane error handling). Absolute file paths on
// purpose: the checkpoint reporter identifies file-level events by
// name === data.file (see its header comment). APRA_FLEET_BD_MOCK=off forces
// REAL bd, not the mocked default (bd-mock-shim contract: unset =
// mock/replay; 0/false/off/real = real bd; record = real bd + refresh
// fixtures).
function runLane(files, concurrency) {
  return new Promise((resolve) => {
    if (files.length === 0) { resolve(0); return; }
    const child = spawn(
      process.execPath,
      [
        '--test',
        `--test-concurrency=${concurrency}`,
        '--test-reporter=./test/helpers/timestamped-reporter.mjs',
        '--test-reporter-destination=stdout',
        `--test-reporter=${pathToFileURL(reporterPath).href}`,
        '--test-reporter-destination=stdout',
        ...files.map((f) => path.join(testDir, f)),
      ],
      {
        cwd: pkgDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          APRA_FLEET_BD_MOCK: 'off',
          INTEG_SUITES_STATUS_FILE: statusFile,
          INTEG_SUITES_HEARTBEAT_FILE: heartbeatFile,
        },
      }
    );

    child.on('error', (e) => {
      console.error(`[integ-suites] supervisor: could not spawn node --test (lane concurrency=${concurrency}): ${e.message}`);
      resolve(-1);
    });
    child.on('exit', (code, signal) => {
      const exitCode = code === null ? -1 : code;
      console.log(
        `[integ-suites] supervisor: node --test lane (concurrency=${concurrency}, ${files.length} file(s)) ` +
        `exited code=${exitCode}${signal ? ` signal=${signal}` : ''}`
      );
      resolve(exitCode);
    });
  });
}

async function cmdSupervise(assignedFiles) {
  if (assignedFiles.length === 0) fail('--supervise called with no files (internal error)');
  touchHeartbeat();
  // Belt-and-braces heartbeat: the reporter touches it on every test event,
  // but a single long-running test can be event-quiet for minutes, so the
  // supervisor also touches it on an interval.
  const hb = setInterval(() => {
    try { touchHeartbeat(); } catch { /* best-effort */ }
  }, 20000);

  const startMs = Date.now();

  // Two sequential (never overlapping) lanes: the bulk of the suite keeps
  // its concurrency=8 wall-clock win, then the dolt-heavy watchdog tests run
  // alone at low concurrency so their per-attempt dolt overhead is never
  // contended with the rest of the suite (apra-fleet-eft.46.1). Either lane
  // may be empty on a resume (--start only re-passes pending files).
  const isolatedFiles = assignedFiles.filter((f) => ISOLATED_LANE_FILES.has(f));
  const mainFiles = assignedFiles.filter((f) => !ISOLATED_LANE_FILES.has(f));

  let mainExit = 0;
  let isolatedExit = 0;
  try {
    mainExit = await runLane(mainFiles, TEST_CONCURRENCY);
    isolatedExit = await runLane(isolatedFiles, ISOLATED_LANE_CONCURRENCY);
  } finally {
    clearInterval(hb);
  }

  const exitCode = mainExit !== 0 ? mainExit : isolatedExit;
  finalize(assignedFiles, startMs, exitCode);
  process.exit(exitCode === 0 ? 0 : 1);
}

function finalize(assignedFiles, startMs, exitCode) {
  try {
    const status = loadStatus() || { results: {} };
    // Safety net: any assigned file the reporter never checkpointed (e.g. a
    // crash so hard no file-level event fired) is recorded as failed, so
    // runComplete always implies every assigned file has a result.
    for (const f of assignedFiles) {
      if (!status.results[f]) {
        status.results[f] = {
          passed: false,
          durationMs: null,
          elapsedSeconds: null,
          finishedAt: new Date().toISOString(),
          failures: [{ name: f, error: 'no result checkpointed by the reporter (file or runner crashed?)' }],
        };
      }
    }
    status.run = {
      ...(status.run || {}),
      inflight: [],
      runComplete: true,
      exitCode,
      finishedAt: new Date().toISOString(),
      wallClockSeconds: Math.round((Date.now() - startMs) / 1000),
    };
    saveStatus(status);
    touchHeartbeat();
  } catch (e) {
    console.error(`[integ-suites] supervisor: failed to finalize status file: ${e.message}`);
  }
}

function cmdFresh() {
  const status = loadStatus();
  if (status && isLive(status)) {
    console.log(`[integ-suites] refusing --fresh: a run is live (supervisor pid=${status.run.pid}). Let it finish or kill it first.`);
    process.exit(3);
  }
  for (const f of [statusFile, heartbeatFile, logFile]) {
    if (existsSync(f)) rmSync(f);
  }
  console.log(`[integ-suites] status/heartbeat/log cleared: ${statusFile}`);
  console.log('[integ-suites] reminder: --fresh starts a new measured pass; it is never for erasing a recorded failure.');
  process.exit(0);
}

// ---- entry point ----

if (args.has('--help') || args.has('-h')) {
  usage();
  process.exit(0);
}
if (args.has('--fresh')) {
  cmdFresh();
}
if (args.has('--supervise')) {
  const idx = argv.indexOf('--supervise');
  cmdSupervise(argv.slice(idx + 1));
} else if (args.has('--start')) {
  cmdStart(discover());
} else {
  // --status (also the default with no args)
  await cmdStatus(discover());
}
