// integ-file-results-reporter.mjs
//
// Checkpoint reporter for scripts/run-integ-suites.mjs (the "Run the
// apra-fleet-se suite against real bd" runner in integ-test-playbook.md).
// Attached as a second
// node:test reporter alongside the package's timestamped-reporter.mjs, it
// streams each FILE's result into the durable status file the instant that
// file finishes -- per-file crash-safe checkpoints from inside one
// concurrent (--test-concurrency=8) run.
//
// Event-shape notes (verified by experiment against Node 22.22.1, this
// repo's actual Node -- do not "simplify" without re-verifying):
//   - In a multi-file run, each file surfaces as a top-level test whose
//     `name` is exactly the path passed on the CLI. The runner passes
//     ABSOLUTE paths, so file-level events are the ones where
//     resolve(name) === resolve(data.file) at nesting 0.
//   - File-level completion is `test:complete` (with `details.error` set on
//     failure). File-level `test:pass` is NOT emitted for passing files, so
//     keying on test:pass/test:fail alone would miss passes.
//   - A file that hard-crashes (process.exit before tests register) still
//     yields a file-level test:complete carrying an error.
//   - Events from concurrent files interleave OUT OF ORDER: an inner
//     test:fail's detail can arrive AFTER its file's test:complete, so
//     failure detail is merged into an already-recorded result when late.
//
// This reporter must NEVER abort the run: a test:fail is recorded and the
// run continues (no fail-fast -- see the playbook). All status-file work is
// wrapped so a reporter bug degrades to a missing checkpoint, not a dead
// test run.
//
// Status file layout (shared with run-integ-suites.mjs):
//   { run: {..., startedAt, lastResultAt}, results: { "<basename>": {
//     passed, durationMs, elapsedSeconds, finishedAt,
//     tests?: {total, passed, failed, skipped},
//     failures?: [{name, error}] } } }
// tests{} counts individual tests (not suites); skip/todo count as skipped.
// failures[] is bounded (MAX_FAILURES_PER_FILE entries, MAX_ERROR_CHARS
// each) and omits noise entries: a suite failing only because a subtest
// failed, and tests cancelled by their parent. A suite that failed for its
// own reason (e.g. a hook) is kept -- it is where that cause surfaces.
// run.startedAt is set (if absent) to this reporter's start time and
// run.lastResultAt on every file result, so a lane with no supervisor (the
// nightly slow lane) still has a wall-clock duration.
//
// Heartbeat: touches integ-suite-heartbeat.json (throttled to ~1/second) on
// every event so the runner's liveness check can distinguish a live run
// from a reused PID after a crash.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statusFile = process.env.INTEG_SUITES_STATUS_FILE
  || path.join(repoRoot, 'integ-suite-status.json');
const heartbeatFile = process.env.INTEG_SUITES_HEARTBEAT_FILE
  || path.join(repoRoot, 'integ-suite-heartbeat.json');

const MAX_FAILURES_PER_FILE = 5;
const MAX_ERROR_CHARS = 500;

function readStatus() {
  if (!existsSync(statusFile)) return { results: {} };
  // Tolerate a transient read race with the runner's atomic rename.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(statusFile, 'utf8'));
      if (parsed && typeof parsed.results === 'object' && parsed.results !== null) return parsed;
      return { ...parsed, results: {} };
    } catch {
      // brief busy-spin-free retry: fall through, next attempt re-reads
    }
  }
  return { results: {} };
}

function writeStatus(status) {
  const tmp = statusFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, statusFile);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

function mutateStatus(fn) {
  try {
    const status = readStatus();
    fn(status);
    writeStatus(status);
  } catch (e) {
    // Never let a checkpoint failure kill the test run.
    process.stderr.write(`[integ-reporter] checkpoint write failed: ${e.message}\n`);
  }
}

let lastHeartbeatMs = 0;
function heartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatMs < 1000) return;
  lastHeartbeatMs = now;
  try {
    writeFileSync(heartbeatFile, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf8');
  } catch {
    // heartbeat is best-effort
  }
}

const reporterStartedAt = new Date().toISOString();

function trimError(err) {
  // node:test wraps the real error (ERR_TEST_FAILURE) and keeps it in
  // .cause; for a hook failure the wrapper message names the hook and the
  // cause holds the reason, so keep both when they differ.
  const msg = err && err.message;
  const cause = err && err.cause && (err.cause.message || String(err.cause));
  let text;
  if (cause && msg && cause !== msg) text = `${msg}: ${cause}`;
  else text = String(cause || msg || (err && err.stack) || err || 'unknown error');
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) + '...' : text;
}

export default async function* integFileResultsReporter(source) {
  // Failure details seen so far, keyed by basename, merged into the file's
  // result at (or after) its file-level completion.
  const failuresByFile = new Map();
  // Individual-test counts per basename. A file whose result is already
  // recorded gets late counts flushed on the next write and at stream end.
  const countsByFile = new Map();
  const recorded = new Set();
  const dirty = new Set();
  const countsFor = (base) => {
    let c = countsByFile.get(base);
    if (!c) { c = { total: 0, passed: 0, failed: 0, skipped: 0 }; countsByFile.set(base, c); }
    return c;
  };
  const flushDirty = (status) => {
    for (const f of dirty) {
      if (status.results[f]) status.results[f].tests = { ...countsFor(f) };
    }
    dirty.clear();
  };
  const isNoiseFailure = (data) => {
    const ft = data.details && data.details.error && data.details.error.failureType;
    return ft === 'cancelledByParent' || (ft === 'subtestsFailed' && data.details.type === 'suite');
  };

  const isFileLevel = (data) =>
    data && data.nesting === 0 && typeof data.file === 'string'
    && typeof data.name === 'string'
    && path.resolve(data.name) === path.resolve(data.file);

  for await (const event of source) {
    try {
      heartbeat();
      const data = event.data || {};
      const base = typeof data.file === 'string' ? path.basename(data.file) : null;

      if (event.type === 'test:dequeue' && isFileLevel(data)) {
        mutateStatus((status) => {
          status.run = status.run || {};
          const inflight = new Set(status.run.inflight || []);
          inflight.add(base);
          status.run.inflight = [...inflight].sort();
        });
      } else if ((event.type === 'test:pass' || event.type === 'test:fail') && base && !isFileLevel(data)) {
        // Individual test (or suite) inside a file. Count tests only --
        // suites are containers. Inner events can arrive after the file's
        // own result (see header), so late counts are marked dirty.
        if (data.details && data.details.type !== 'suite') {
          const c = countsFor(base);
          c.total += 1;
          if (data.skip || data.todo) c.skipped += 1;
          else if (event.type === 'test:pass') c.passed += 1;
          else c.failed += 1;
          if (recorded.has(base)) dirty.add(base);
        }
        if (event.type === 'test:fail' && !data.todo && !isNoiseFailure(data)) {
          // Failing test: stash detail, and if the file's result was already
          // recorded (out-of-order stream), merge the detail into it now.
          const list = failuresByFile.get(base) || [];
          if (list.length < MAX_FAILURES_PER_FILE) {
            list.push({ name: data.name, error: trimError(data.details && data.details.error) });
          }
          failuresByFile.set(base, list);
          mutateStatus((status) => {
            const rec = status.results[base];
            if (rec) {
              rec.passed = false;
              rec.failures = list.slice(0, MAX_FAILURES_PER_FILE);
            }
            flushDirty(status);
          });
        }
      } else if (event.type === 'test:complete' && isFileLevel(data)) {
        const durationMs = data.details && typeof data.details.duration_ms === 'number'
          ? data.details.duration_ms : null;
        const fileError = data.details && data.details.error
          ? trimError(data.details.error) : null;
        const failures = failuresByFile.get(base) || [];
        if (fileError && failures.length === 0) {
          failures.push({ name: base, error: fileError });
        }
        recorded.add(base);
        mutateStatus((status) => {
          const inflight = new Set((status.run && status.run.inflight) || []);
          inflight.delete(base);
          status.run = status.run || {};
          status.run.inflight = [...inflight].sort();
          if (!status.run.startedAt) status.run.startedAt = reporterStartedAt;
          const finishedAt = new Date().toISOString();
          status.run.lastResultAt = finishedAt;
          status.results[base] = {
            passed: !fileError,
            durationMs,
            elapsedSeconds: durationMs === null ? null : Math.round(durationMs / 1000),
            finishedAt,
            tests: { ...countsFor(base) },
            ...(fileError ? { failures: failures.slice(0, MAX_FAILURES_PER_FILE) } : {}),
          };
          flushDirty(status);
        });
      }
    } catch (e) {
      process.stderr.write(`[integ-reporter] event handling error (run continues): ${e.message}\n`);
    }
    // This reporter yields no output of its own; the timestamped reporter
    // handles the human-readable log stream.
  }
  // Inner events can arrive after their file's result (see header): write
  // any counts still pending once the stream ends.
  if (dirty.size) mutateStatus(flushDirty);
}
