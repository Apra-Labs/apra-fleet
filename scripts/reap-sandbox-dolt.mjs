#!/usr/bin/env node
// Reap a detached ephemeral 'dolt sql-server' the smoke-test sandbox's own
// toy sprint spawned (fleet-sprint/dolt-settle.mjs's spawnEphemeralServer),
// before regression-test-playbook.md's Teardown deletes the sandbox
// directory. This is the last-resort backstop for the one case
// dolt-settle's own 'finally' teardown cannot cover: the orchestrator
// process dying mid-settle.
//
// Replaces a plain 'pgrep -f "dolt.*sql-server.*$SANDBOX"' loop for two
// reasons:
//
// 1. Portability: 'pgrep' does not exist in Git Bash on Windows. This
//    script probes for a supported enumeration tool (POSIX 'ps', Windows
//    'powershell'/Get-CimInstance) and hard-fails (naming the missing tool)
//    rather than silently reading "nothing found" as "nothing is there".
//
// 2. The relative-data-dir blind spot: dolt-settle.mjs's resolveDoltStatus
//    falls back to a RELATIVE default data dir (DEFAULT_EMBEDDED_DATA_DIR,
//    '.beads/embeddeddolt') when 'bd dolt status' cannot be parsed. When
//    that happens, the spawned server's command line carries NO absolute
//    sandbox path at all, so matching on the sandbox's own absolute path
//    (the original loop's only signal) can miss it entirely.
//
//    The fix is NOT to widen the match to a bare 'dolt.*sql-server' (or even
//    a bare '.beads/embeddeddolt') pattern -- either default is shared by
//    every sandbox and every production install that also falls into the
//    'unknown' status-parse branch, so a bare match would be exactly the
//    machine-wide-kill hazard documented against dolt-orphan-sweep.mjs (it
//    could kill a live, unrelated dolt sql-server on the same host). Instead
//    the relative-default branch is additionally bounded by RECENCY: it
//    only matches a process that started AFTER this test run's own recorded
//    start time (--since). A process using the shared relative default AND
//    started inside this run's own narrow window is this sandbox's -- the
//    residual risk (a DIFFERENT sandbox/sprint on the same host, also on
//    the relative-default fallback, started in the same few-minute window)
//    is accepted and narrow, the same kind of bounded-trust-window
//    mitigation the dolt-orphan-sweep hazard note elsewhere in this
//    playbook already uses (there: bounded by age; here: bounded by
//    recency).
//
// CLI (used directly by regression-test-playbook.md's Teardown):
//   node scripts/reap-sandbox-dolt.mjs --sandbox <path> --since <epoch-seconds> [--deadline-ms <ms>]
// Exits 0 once no matching process remains; exits 1 if one survives past the
// deadline, or if no supported enumeration tool is available.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class ProbeToolMissingError extends Error {
  constructor(tool) {
    super(`required probe tool '${tool}' is not available on this host`);
    this.tool = tool;
  }
}

function isWindows(deps) {
  return (deps.platform ?? process.platform) === 'win32';
}

/** Parse `ps -eo pid=,etimes=,args=` output into { pid, startedAt, args }
 *  rows (startedAt derived from etimes, the process's age in seconds). */
export function parsePsRows(output, nowSeconds) {
  const rows = [];
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, etimes, args] = m;
    rows.push({ pid: Number(pid), startedAt: nowSeconds - Number(etimes), args });
  }
  return rows;
}

/** Parse the pipe-delimited '<pid>|<epoch-seconds>|<command line>' rows this
 *  script's own PowerShell probe below emits. */
export function parseWindowsRows(output) {
  const rows = [];
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [pid, startedAt, ...rest] = parts;
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(startedAt)) continue;
    rows.push({ pid: Number(pid), startedAt: Number(startedAt), args: rest.join('|') });
  }
  return rows;
}

/** True if `row` is a dolt sql-server this sandbox's own toy sprint spawned
 *  -- see the module doc above for the two match branches and why the
 *  relative-default branch also requires `since`-bounded recency. */
export function matchesSandboxDolt(row, { sandboxPath, since }) {
  if (!/sql-server/i.test(row.args)) return false;
  const normArgs = row.args.replace(/\\/g, '/');
  const normSandbox = String(sandboxPath || '').replace(/\\/g, '/');
  if (normSandbox && normArgs.includes(normSandbox)) return true;
  const usesRelativeDefault = /\.beads\/embeddeddolt/i.test(normArgs);
  if (usesRelativeDefault && Number.isFinite(since) && row.startedAt >= since) return true;
  return false;
}

/** List every currently-running process's { pid, startedAt, args }, or throw
 *  ProbeToolMissingError if this host has no supported enumeration tool. */
export function listCandidates(deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  const now = deps.now ?? (() => Date.now());
  if (isWindows(deps)) {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='dolt.exe'\" -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.ProcessId)|$([long]([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeSeconds())|$($_.CommandLine)\" }";
    let out;
    try {
      out = exec('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new ProbeToolMissingError('powershell');
      out = err && typeof err.stdout === 'string' ? err.stdout : '';
    }
    return parseWindowsRows(out);
  }
  let out;
  try {
    out = exec('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new ProbeToolMissingError('ps');
    throw err;
  }
  return parsePsRows(out, Math.floor(now() / 1000));
}

export function killPid(pid, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  try {
    if (isWindows(deps)) exec('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else exec('kill', ['-9', String(pid)], { stdio: 'ignore' });
  } catch {
    // best effort -- the retry loop's own deadline + final verification
    // decides pass/fail, not this individual kill call.
  }
}

/** Poll for matching processes and kill them until none remain or
 *  `deadlineMs` elapses. Returns { ok, matches, message }. */
export async function reapSandboxDolt({ sandboxPath, since, deadlineMs = 5000 }, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deadlineMs;

  function findMatches() {
    const rows = listCandidates(deps);
    return rows.filter((row) => matchesSandboxDolt(row, { sandboxPath, since }));
  }

  let matches = findMatches();
  while (matches.length > 0) {
    for (const m of matches) killPid(m.pid, deps);
    if (now() >= deadline) break;
    await sleep(1000);
    matches = findMatches();
  }
  if (matches.length > 0) {
    return {
      ok: false,
      matches,
      message: `${matches.length} matching dolt sql-server process(es) still alive after ${deadlineMs}ms: `
        + matches.map((m) => `pid ${m.pid} (${m.args})`).join('; '),
    };
  }
  return { ok: true, matches: [], message: 'no matching dolt sql-server processes remain.' };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || '').replace(/^--/, '');
    opts[key] = argv[i + 1];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sandboxPath = opts.sandbox;
  const since = Number(opts.since || 0);
  const deadlineMs = opts['deadline-ms'] !== undefined ? Number(opts['deadline-ms']) : 5000;
  if (!sandboxPath) {
    console.error('[reap-sandbox-dolt] --sandbox <path> is required');
    process.exit(1);
  }
  let result;
  try {
    result = await reapSandboxDolt({ sandboxPath, since, deadlineMs });
  } catch (err) {
    if (err instanceof ProbeToolMissingError) {
      console.error(
        `[reap-sandbox-dolt] ${err.message} -- cannot verify no detached dolt `
        + "sql-server survives this sandbox. Install 'ps' (POSIX) or ensure "
        + "'powershell' is on PATH (Windows), or check for stray dolt "
        + 'processes manually before continuing.',
      );
      process.exit(1);
    }
    throw err;
  }
  console.error(`[reap-sandbox-dolt] ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
