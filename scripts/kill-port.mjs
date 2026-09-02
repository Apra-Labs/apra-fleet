#!/usr/bin/env node
// Cross-platform "wait for a TCP port to be free, killing anything bound to
// it first" guard for regression-test-playbook.md's bounded-retry port
// guards (Setup's scratch-port check, Reset's toy-app dev-server check).
//
// Bug this replaces: the playbook's original loops shelled out straight to
// 'lsof -ti tcp:$PORT 2>/dev/null || true'. On a host with no 'lsof' (Git
// Bash on Windows, confirmed in this repo's own regression runs) that
// command fails, stderr is swallowed, the substitution is empty, and the
// loop -- including its own fail-loud check at the end -- reads "port free"
// when it never actually looked. This script probes for a supported tool
// FIRST and hard-fails (non-zero exit, names the missing tool) instead of
// silently treating "I could not check" as "nothing is there".
//
// Platform strategy:
//   - POSIX: 'lsof -ti tcp:<port>' (unchanged from the original loops).
//   - Windows: 'netstat -ano' (always present on Windows, including under
//     Git Bash), parsed for LISTENING/ESTABLISHED rows on <port>; killed via
//     'taskkill /F /PID <pid>'.
// If neither applies (POSIX host missing lsof, or Windows missing netstat --
// both would be unusual but not impossible), this exits 1 naming the missing
// tool rather than proceeding as if the port were free.
//
// CLI (used directly by regression-test-playbook.md):
//   node scripts/kill-port.mjs <port> <label> [deadline-ms]
// Exits 0 once the port is confirmed free (or was already free); exits 1 if
// still bound after the deadline, or if no probe tool is available.
//
// Every exported function takes an optional 'deps' object for test
// injection (execFileSync/platform/sleep), mirroring
// scripts/sandbox-lock.mjs's and scripts/check-sandbox-sync-remote.mjs's
// convention -- no real processes/ports are needed to exercise the parsing
// and retry-loop decision logic.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class ProbeToolMissingError extends Error {
  constructor(tool) {
    super(`required probe tool '${tool}' is not available on this host`);
    this.tool = tool;
  }
}

/** Parse `lsof -ti tcp:<port>` output (one PID per line) into a PID array. */
export function parseLsofPids(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

/** Parse `netstat -ano` output for every row whose local address ends in
 *  ':<port>' (TCP or UDP, any state), returning the PID column. Windows'
 *  netstat format: 'TCP    0.0.0.0:18700    0.0.0.0:0    LISTENING    12345'
 *  (columns are whitespace-separated; the PID is always the last column). */
export function parseNetstatPids(output, port) {
  const pids = new Set();
  const suffix = `:${port}`;
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!/^(TCP|UDP)\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const localAddr = cols[1];
    if (!localAddr.endsWith(suffix)) continue;
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

function isWindows(deps) {
  return (deps.platform ?? process.platform) === 'win32';
}

/** Find every PID currently bound to `port`, or throw ProbeToolMissingError
 *  if this host has no supported probe tool. */
export function findPids(port, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  if (isWindows(deps)) {
    let out;
    try {
      out = exec('netstat', ['-ano'], { encoding: 'utf8' });
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new ProbeToolMissingError('netstat');
      // netstat can exit non-zero with useful output in some locales; try to
      // use it if present, otherwise treat as "nothing found" this pass.
      out = err && typeof err.stdout === 'string' ? err.stdout : '';
    }
    return parseNetstatPids(out, port);
  }
  try {
    const out = exec('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    return parseLsofPids(out);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new ProbeToolMissingError('lsof');
    // A non-zero exit with no output means "nothing bound to this port" --
    // lsof's own documented behavior, not a missing-tool signal.
    return [];
  }
}

/** Kill every pid in `pids`, best-effort (a pid that already exited between
 *  the probe and the kill is not an error). */
export function killPids(pids, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  for (const pid of pids) {
    try {
      if (isWindows(deps)) exec('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      else exec('kill', ['-9', String(pid)], { stdio: 'ignore' });
    } catch {
      // best effort -- already gone, or unkillable; the retry loop's own
      // deadline + final verification is what actually decides pass/fail.
    }
  }
}

/** Poll `findPids`/`killPids` until the port is free or `deadlineMs`
 *  elapses. Returns { ok, pids, message }. Never throws ProbeToolMissingError
 *  itself -- that propagates to the caller so the CLI can name the missing
 *  tool and exit non-zero, distinguishable from "genuinely still bound". */
export async function waitPortFree(port, label, deadlineMs = 5000, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deadlineMs;
  let pids = findPids(port, deps);
  while (pids.length > 0) {
    killPids(pids, deps);
    if (now() >= deadline) break;
    await sleep(1000);
    pids = findPids(port, deps);
  }
  if (pids.length > 0) {
    return {
      ok: false,
      pids,
      message: `${label} still bound to pid(s) ${pids.join(',')} after ${deadlineMs}ms of kill retries.`,
    };
  }
  return { ok: true, pids: [], message: `${label} confirmed free.` };
}

async function main() {
  const [portArg, labelArg, deadlineArg] = process.argv.slice(2);
  const port = Number(portArg);
  const label = labelArg || `port ${portArg}`;
  const deadlineMs = deadlineArg !== undefined ? Number(deadlineArg) : 5000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[kill-port] invalid port argument '${portArg}'`);
    process.exit(1);
  }
  let result;
  try {
    result = await waitPortFree(port, label, deadlineMs);
  } catch (err) {
    if (err instanceof ProbeToolMissingError) {
      console.error(
        `[kill-port] ${err.message} -- cannot verify ${label} is free. `
        + "Install 'lsof' (POSIX) or ensure 'netstat' is on PATH (Windows), "
        + 'or free the port manually before continuing.',
      );
      process.exit(1);
    }
    throw err;
  }
  console.error(`[kill-port] ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
