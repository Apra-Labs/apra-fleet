// bin/runtime.mjs -- the real collaborators, finally written.
//
// Every module under src/ takes its I/O injected (this package's rule,
// restated in every sibling verb and sink), which is why the suite runs
// with no cloud and no credentials. Nothing has ever constructed the real
// thing. This module is where that stops: the composition root (whatever
// eventually wires `bin/fleet-bridge.mjs`'s verbs together) imports these
// four exports and hands them to `deps`. Each one is small and boring on
// purpose -- the value is in getting its edge cases right, not in
// cleverness.
//
// WHY THIS LIVES IN bin/, NOT src/: `test/error-rule.test.mjs` source-scans
// `src/**/*.mjs` only, so this file is outside the mechanically-enforced
// "every throw is a BridgeError" guard. That is a scope fact about the
// guard, not license to ignore the rule it encodes: every export below
// still follows it for anything that would cross ITS OWN boundary --
// `readTokenFile` is contracted to never throw at all (see below);
// `createGit().resolveRef` rejects with the real `execFile` error rather
// than inventing a BridgeError, because its one consumer
// (`verbs/preflight.mjs`'s `checkRepoAndBase`) already catches it locally
// and only ever reads `.message` off it (via its own `safeMessage`), so
// wrapping would add a translation layer with no consumer.
//
// INJECTED I/O EVERYWHERE ELSE IN THIS PACKAGE, REAL I/O ONLY HERE: this is
// the one file allowed to import `node:fs`, `node:child_process` and
// `node:os` directly.

import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync, createWriteStream } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

/**
 * Sync reader of `<dataDir>/private/token`, the supervisor bearer that
 * apra-fleet PR #493 introduces. Consumed by `createSupervisorClient`
 * (`src/supervisor-client.mjs`) and `createViewerProxy`
 * (`src/viewer-proxy.mjs`) -- both of which expect a zero-argument
 * `() => string|null`, so the composition root binds this as
 * `() => readTokenFile(dataDir)` rather than passing it directly.
 *
 * MUST NEVER THROW. A missing file, a permissions error, a directory where
 * a file should be -- all of these mean "no token", which is the correct
 * pre-#493 state, and none of them may crash the CLI. Trailing whitespace
 * is trimmed; an empty or whitespace-only file reads as `null`, not `''`,
 * so callers never have to special-case an empty string. The value itself
 * is never logged by this function (nor should any caller log it).
 *
 * @param {string} dataDir
 * @returns {string|null}
 */
export function readTokenFile(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    return null;
  }
  let raw;
  try {
    raw = readFileSync(join(dataDir, 'private', 'token'), 'utf8');
  } catch {
    // ENOENT (missing file), EACCES/EPERM (permissions), EISDIR (a
    // directory sitting where the token file should be) -- every failure
    // mode here means "no token", never a thrown error.
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `preflight`'s base-branch check (`verbs/preflight.mjs`'s
 * `checkRepoAndBase`). `resolveRef` shells out to a real
 * `git rev-parse --verify <ref>` in `cwd` and resolves to the trimmed sha,
 * rejecting with the underlying `execFile` error when the ref does not
 * exist (or `git` itself fails). `execFile` is taken injected so this is
 * testable without a real repo. Argv is passed as an array -- never a
 * shell -- because `ref` is caller input (a branch name flows in from
 * `opts.baseBranch`) and a shell-interpolated ref would be injectable.
 *
 * @param {object} deps
 * @param {typeof import('node:child_process').execFile} [deps.execFile] -
 *   injected; defaults to the real `node:child_process` `execFile`. Any fake
 *   must match its `(file, args, options, callback(err, stdout, stderr))`
 *   signature.
 * @returns {{ resolveRef(ref: string, opts: { cwd: string }): Promise<string> }}
 */
export function createGit({ execFile } = {}) {
  const run = typeof execFile === 'function' ? execFile : nodeExecFile;

  return {
    resolveRef(ref, { cwd } = {}) {
      return new Promise((resolve, reject) => {
        run('git', ['rev-parse', '--verify', ref], { cwd }, (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(String(stdout).trim());
        });
      });
    },
  };
}

/**
 * `daemon`'s liveness probe (`verbs/daemon.mjs`, wired as `deps.isAlive`),
 * and the safety-critical one in this file.
 *
 * SAME HOST: `process.kill(pid, 0)` in a try/catch -- `true` if it does not
 * throw. `EPERM` means the process EXISTS but is owned by someone else, so
 * that is ALIVE, not dead; only `ESRCH` (no such process) means dead.
 *
 * CROSS-HOST LIVENESS IS UNSOLVED. For a foreign `host` this returns
 * `true` -- "assume alive" -- and DELIBERATELY DOES NOT ATTEMPT A REAL
 * PROBE (no ping, no remote exec, nothing). Getting this the other way is
 * what lets two daemons both believe they own a sprint and both advance the
 * append-blob `appendpos` cursor, corrupting the log silently:
 * `spool.claim()` already fails safe on an alive answer (see spool.mjs),
 * so a wrong "true" here only costs a stale claim outliving its actually-
 * dead owner (recoverable: the operator restarts the daemon that holds it,
 * or it's noticed and force-released), while a wrong "false" would let a
 * second daemon steal a still-running claim out from under the first one
 * mid-flight (silent, unrecoverable corruption). Do NOT "optimise" this
 * into a ping or a remote exec later -- there is no generically-correct way
 * to probe an arbitrary foreign host's process table from here, and a
 * probe that is occasionally wrong in the unsafe direction is worse than
 * one that is honestly unable to answer.
 *
 * LOCAL HOST: determined via `node:os`'s `hostname()`. This is deliberately
 * the same primitive `verbs/daemon.mjs`'s own `opts.host` doc describes as
 * "this machine's identity, used as claim identity" -- whatever value the
 * composition root stamps into a claim's `host` field (via `daemon`'s
 * `opts.host`) is expected to come from the same `os.hostname()` call this
 * function makes, so a claim written by this machine always compares equal
 * to this machine's own identity here, and a claim written elsewhere always
 * compares unequal (falling into "cross-host, assume alive" above).
 *
 * @param {number} pid
 * @param {string} host
 * @returns {boolean}
 */
export function isAlive(pid, host) {
  if (typeof host === 'string' && host.length > 0 && host !== osHostname()) {
    // Cross-host: unsolved by design. See the file comment above.
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') {
      // Process exists, just isn't ours -- still alive.
      return true;
    }
    // ESRCH (no such process), or anything else unexpected: cannot confirm
    // it is alive, and this is the same-host case where that means dead.
    return false;
  }
}

/**
 * Real `Date.now`, `setTimeout`, `clearTimeout`, plus a promise-based
 * `sleep(ms)` -- the one clock object shared by every consumer in this
 * package that needs to schedule work without a fake in production.
 *
 * ONE OBJECT SATISFIES ALL FIVE CALL SITES this was checked against, in two
 * different ways they consume it:
 *
 *   - `verbs/watch.mjs`, `verbs/daemon.mjs`, `src/await-gate.mjs` each take
 *     bare `deps.now()` / `deps.sleep(ms)` -- the composition root passes
 *     this object's own `now` and `sleep` methods for those two dep slots
 *     (e.g. `{ now: clock.now, sleep: clock.sleep, ... }`, or an object
 *     spread). Neither method reads `this`, so extracting them like that is
 *     safe.
 *   - `src/sinks/jsonl-file.mjs` and `src/sinks/append-blob.mjs` each take
 *     a whole `deps.clock` object and call `.now()` on it (both) and
 *     `.setTimeout()` / `.clearTimeout()` on it (append-blob only) -- the
 *     composition root passes this object wholesale as `clock`, and since
 *     it carries all four methods, both sinks' requirements are satisfied
 *     by the exact same instance.
 *
 * No mismatch was found: every consumer's required method is present, no
 * consumer needs anything this object does not provide, and none of the
 * methods depend on being called as `clock.method()` vs. destructured --
 * they close over nothing but the real global timer functions.
 *
 * @returns {{ now: () => number, setTimeout: (fn: Function, ms: number) => any, clearTimeout: (id: any) => void, sleep: (ms: number) => Promise<void> }}
 */
export function createClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

/**
 * `fs.createWriteStream(path, { flags: 'a' })` for `createJsonlFileSink`
 * (`src/sinks/jsonl-file.mjs`). Confirmed against that sink's exact usage:
 * it only ever calls `.write(chunk)` (in `emit()`) and `.end()` (in
 * `stop()`, guarded by `typeof stream.end === 'function'`) on whatever this
 * returns -- both of which a real `fs.WriteStream` provides natively (it is
 * also a full `EventEmitter`, so `.on(...)` is available if a future caller
 * needs it, but nothing in this package currently does).
 *
 * @param {string} path
 * @returns {import('node:fs').WriteStream}
 */
export function openAppendStream(path) {
  return createWriteStream(path, { flags: 'a' });
}
