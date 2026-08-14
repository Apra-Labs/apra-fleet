#!/usr/bin/env node
// Pre-flight for `npm ci`: find (and where safe, clear) processes that hold a
// lock on a file under THIS repo's node_modules -- the recurring
// "npm ci EPERM unlink ..." class of failure. The observed real-world cases
// are an orphaned in-tree build-tool child (node_modules/@esbuild/*/esbuild.exe)
// AND an OUT-OF-TREE node.exe (e.g. under Program Files) that merely has one of
// this repo's native modules (node_modules/@rollup/*/rollup.win32-x64-msvc.node)
// mapped into its address space. The original own-executable-path matcher could
// only ever see the first kind, so the second kind blocked deploy silently.
//
// Detection (Windows), in order, all bounded in time:
//   1. probe    -- candidate files (.node/.exe/.dll) under the target directory
//                  are opened with `fs.open(path, 'r+')`. A mapped image or an
//                  open exclusive handle makes that fail with EBUSY/EPERM/EACCES.
//                  Nothing is renamed, moved or deleted: a rename/rename-back
//                  probe has a crash window that would leave node_modules
//                  corrupt, which is the very state this script exists to avoid.
//   2. exe-path -- Win32_Process rows whose OWN ExecutablePath is inside the
//                  target directory (the original, narrow matcher).
//   3. modules  -- loaded-module ownership: every accessible process's
//                  System.Diagnostics.Process.Modules list is scanned for a
//                  module whose file lives inside the target directory. This is
//                  what finds the out-of-tree node.exe holding a .node file.
//   4. handle   -- OPTIONAL: if Sysinternals `handle64.exe`/`handle.exe` is on
//                  PATH it is run against each suspect file to attribute plain
//                  file handles (e.g. an AV scanner) that own no loaded module.
// Steps 2+3 are a SINGLE `powershell -EncodedCommand` invocation (one ~500ms
// PowerShell startup, not N of them) that returns one JSON blob.
//
// Kill policy -- deliberately narrower than detection. A process is killed only
// when it is (a) not this process and not any ANCESTOR of this process (the
// widened matcher otherwise matches our own npm/node toolchain and would kill
// the run that invoked us), and (b) either its own executable lives inside the
// target directory, or its image name is in KILLABLE_IMAGES below. Anything
// else -- an AV scanner, an editor, an unknown image -- is REPORTED, never
// killed. After killing, the probe is retried with bounded backoff.
//
// Failure is always loud. There is no silent success path when a lock survives:
// either the holder is named (PID + image name + locked file path) or the
// script says "holder unknown" and lists the enumeration methods it attempted.
//
// Usage:
//   node scripts/preflight-clear-build-locks.mjs [--dir <path>] [--report-only]
//
//   --dir <path>    Directory to check instead of <repo>/node_modules.
//                   Used by the integration test to point at a fixture.
//   --report-only   Enumerate and diagnose only; kill nothing. Any surviving
//                   lock is still reported and still exits non-zero.
//   --help          Print this usage block.
//
// Exit codes:
//   0  nothing locked (or every lock was cleared)   -- one line of output
//   1  lock survives AND at least one holder was identified by PID + image
//   2  lock survives and NO holder could be attributed ("holder unknown")
//   3  usage error (e.g. --dir without a value)
//
// Time bounds (worst case is the sum, ~45s, far under any deploy budget):
//   PROBE_TIMEOUT_MS      per probe sweep of the candidate files
//   ENUM_TIMEOUT_MS       the single PowerShell process/module enumeration
//   HANDLE_TIMEOUT_MS     each optional handle.exe invocation
//   RETRY_BACKOFF_MS      waits between post-kill re-probes
//
// Non-Windows behaviour is unchanged: the original ownership-scoped `pgrep -f`
// sweep runs and the script exits 0.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per probe sweep of candidate files. */
const PROBE_TIMEOUT_MS = 10000;
/** The single PowerShell Win32_Process + loaded-module enumeration. */
const ENUM_TIMEOUT_MS = 20000;
/** Each optional Sysinternals handle.exe invocation. */
const HANDLE_TIMEOUT_MS = 5000;
/** Waits between re-probes after killing holders. */
const RETRY_BACKOFF_MS = [500, 1500, 3000];
/** Hard cap on files stat-ed in one probe sweep, so a huge tree cannot hang. */
const MAX_PROBE_FILES = 20000;
/** Only these extensions can hold the image/handle locks npm ci trips over. */
const CANDIDATE_EXTENSIONS = new Set(['.node', '.exe', '.dll']);
/**
 * Images safe to kill when they hold a lock from OUTSIDE the target directory:
 * a build toolchain process that mapped this checkout's modules is by
 * definition working on this checkout. Anything not listed here is reported.
 */
const KILLABLE_IMAGES = new Set([
  'node.exe',
  'esbuild.exe',
  'rollup.exe',
  'tsc.exe',
  'vitest.exe',
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownPid = process.pid;

function parseArgs(argv) {
  const opts = { dir: path.join(repoRoot, 'node_modules'), reportOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--report-only') {
      opts.reportOnly = true;
    } else if (arg === '--dir') {
      const value = argv[i + 1];
      if (!value) return { error: '--dir requires a path argument' };
      opts.dir = path.resolve(value);
      i += 1;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return opts;
}

const USAGE = [
  'Usage: node scripts/preflight-clear-build-locks.mjs [--dir <path>] [--report-only]',
  '',
  '  --dir <path>    Directory to check instead of <repo>/node_modules.',
  '  --report-only   Diagnose only; kill nothing. Surviving locks still exit non-zero.',
  '  --help          Print this usage block.',
  '',
  'Exit codes: 0 clean/cleared, 1 lock survives with a named holder,',
  '            2 lock survives with holder unknown, 3 usage error.',
].join('\n');

function log(message) {
  console.log(`[preflight-clear-build-locks] ${message}`);
}

function run(cmd, timeout) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit here usually just means "no matches" for the discovery
    // commands below -- treat stdout (if any) as the result and let callers
    // deal with empty output.
    return err && err.stdout ? String(err.stdout) : '';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Non-destructive lock probe: list candidate files under `dir` that cannot be
 * opened for writing. Bounded by PROBE_TIMEOUT_MS and MAX_PROBE_FILES; returns
 * `{ locked, truncated }` so a truncated sweep is never reported as clean.
 */
function probeLockedFiles(dir) {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  const locked = [];
  let seen = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length > 0) {
    if (Date.now() > deadline || seen >= MAX_PROBE_FILES) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CANDIDATE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      seen += 1;
      let fd;
      try {
        fd = fs.openSync(full, 'r+');
      } catch (err) {
        const code = err && err.code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') locked.push(full);
        continue;
      }
      fs.closeSync(fd);
    }
  }
  return { locked, truncated };
}

function psSingleQuote(value) {
  return value.replace(/'/g, "''");
}

/**
 * Mirrors src/os/windows.ts wrapPowerShellEncoded: base64/utf16le so no
 * quoting scheme of ours has to survive cmd.exe. Paths with spaces or quotes
 * are therefore safe.
 */
function wrapPowerShellEncoded(psScript) {
  const guarded = `$ErrorActionPreference = 'Continue'; ${psScript}`;
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(guarded, 'utf16le').toString('base64')}`;
}

/**
 * ONE PowerShell call returning every Win32_Process row (for exe-path matching
 * and ancestor-chain walking) plus every loaded module whose file lives under
 * `dir`. Bounded by ENUM_TIMEOUT_MS.
 */
function enumerateWindowsProcesses(dir) {
  const prefix = psSingleQuote(dir.endsWith(path.sep) ? dir : dir + path.sep);
  const psScript = [
    `$prefix = '${prefix}'`,
    '$cmp = [System.StringComparison]::OrdinalIgnoreCase',
    // Must stay ONE array entry: entries are joined with '; ', which would
    // otherwise cut this pipeline in half and make the whole script a syntax error.
    '$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath',
    '$mods = New-Object System.Collections.ArrayList',
    'foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {',
    '  try {',
    '    foreach ($m in $p.Modules) {',
    '      if ($m.FileName -and $m.FileName.StartsWith($prefix, $cmp)) {',
    '        [void]$mods.Add([pscustomobject]@{ProcessId=$p.Id;Name=$p.ProcessName;ModulePath=$m.FileName})',
    '      }',
    '    }',
    '  } catch { }',
    '}',
    '[pscustomobject]@{procs=@($procs);modules=@($mods)} | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  const raw = run(wrapPowerShellEncoded(psScript), ENUM_TIMEOUT_MS).trim();
  if (!raw) return { procs: [], modules: [], ok: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      procs: Array.isArray(parsed.procs) ? parsed.procs : [],
      modules: Array.isArray(parsed.modules) ? parsed.modules : [],
      ok: true,
    };
  } catch {
    return { procs: [], modules: [], ok: false };
  }
}

/** PIDs of this process and every ancestor -- never kill any of them. */
function ancestorPids(procs) {
  const parentOf = new Map();
  for (const row of procs) {
    if (row && row.ProcessId != null) parentOf.set(Number(row.ProcessId), Number(row.ParentProcessId));
  }
  const chain = new Set([ownPid]);
  let cursor = parentOf.get(ownPid);
  while (cursor && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return chain;
}

/** Sysinternals handle.exe, if present, attributes plain file handles. */
function findHandleTool() {
  for (const tool of ['handle64.exe', 'handle.exe']) {
    const found = run(`where ${tool}`, HANDLE_TIMEOUT_MS).trim();
    if (found) return tool;
  }
  return null;
}

function handleHolders(tool, file) {
  const raw = run(`${tool} -nobanner -accepteula "${file.replace(/"/g, '')}"`, HANDLE_TIMEOUT_MS);
  const holders = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(\S+)\s+pid:\s*(\d+)/i.exec(line);
    if (!match) continue;
    holders.push({ pid: Number(match[2]), image: match[1], file, method: 'handle' });
  }
  return holders;
}

function describeHolder(holder) {
  const where = holder.modulePath || holder.executablePath || holder.file || 'unknown path';
  return `PID ${holder.pid} (${holder.image}) via ${holder.method} -- ${where}`;
}

function runWindows(dir, reportOnly) {
  if (!fs.existsSync(dir)) {
    log(`target directory does not exist, nothing to check: ${dir}`);
    return 0;
  }

  let probe = probeLockedFiles(dir);
  if (probe.locked.length === 0 && !probe.truncated) {
    log('no locked files found under ' + dir + '.');
    return 0;
  }
  if (probe.locked.length === 0 && probe.truncated) {
    log(`probe sweep hit its ${PROBE_TIMEOUT_MS}ms/${MAX_PROBE_FILES}-file bound before finishing; no lock seen so far under ${dir}.`);
    return 0;
  }

  const enumerated = enumerateWindowsProcesses(dir);
  const methods = enumerated.ok
    ? ['probe', 'exe-path', 'modules']
    : ['probe', `exe-path + modules (PowerShell enumeration FAILED or timed out after ${ENUM_TIMEOUT_MS}ms)`];
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const protectedPids = ancestorPids(enumerated.procs);

  const holders = new Map();
  const addHolder = (holder) => {
    const key = `${holder.pid}:${holder.method}:${holder.modulePath || holder.file || ''}`;
    if (!holders.has(key)) holders.set(key, holder);
  };

  for (const row of enumerated.procs) {
    const exe = row && row.ExecutablePath;
    if (!exe || !exe.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    addHolder({
      pid: Number(row.ProcessId),
      image: String(row.Name || 'unknown'),
      executablePath: exe,
      method: 'exe-path',
      inTree: true,
    });
  }
  for (const row of enumerated.modules) {
    const image = String(row.Name || 'unknown');
    addHolder({
      pid: Number(row.ProcessId),
      image: image.toLowerCase().endsWith('.exe') ? image : `${image}.exe`,
      modulePath: row.ModulePath,
      method: 'modules',
      inTree: false,
    });
  }

  const handleTool = findHandleTool();
  if (handleTool) {
    methods.push(`handle (${handleTool})`);
    for (const file of probe.locked.slice(0, 10)) {
      for (const holder of handleHolders(handleTool, file)) addHolder(holder);
    }
  }

  const found = [...holders.values()].filter((h) => h.pid && !protectedPids.has(h.pid));
  const selfHeld = [...holders.values()].filter((h) => h.pid && protectedPids.has(h.pid));

  log(`${probe.locked.length} locked file(s) under ${dir}:`);
  for (const file of probe.locked.slice(0, 10)) log(`  locked file: ${file}`);
  for (const holder of found) log(`  holder: ${describeHolder(holder)}`);
  for (const holder of selfHeld) {
    log(`  holder: ${describeHolder(holder)} [this process or an ancestor -- never killed]`);
  }

  if (reportOnly) {
    if (found.length === 0 && selfHeld.length === 0) {
      log(`holder unknown for ${probe.locked.length} locked file(s); enumeration methods attempted: ${methods.join(', ')}.`);
      log(`first locked file: ${probe.locked[0]}`);
      return 2;
    }
    log('--report-only: nothing was killed; locks above are still held.');
    return 1;
  }

  const killable = found.filter((h) => h.inTree || KILLABLE_IMAGES.has(h.image.toLowerCase()));
  const notKillable = found.filter((h) => !killable.includes(h));
  for (const holder of notKillable) {
    log(`  NOT killing ${describeHolder(holder)} -- image is not in the kill allowlist (e.g. AV/editor); resolve it manually.`);
  }
  const killedPids = new Set();
  for (const holder of killable) {
    if (killedPids.has(holder.pid)) continue;
    log(`killing ${describeHolder(holder)}`);
    run(`taskkill /F /T /PID ${holder.pid}`, HANDLE_TIMEOUT_MS);
    killedPids.add(holder.pid);
  }

  if (killedPids.size > 0) {
    for (const wait of RETRY_BACKOFF_MS) {
      sleepSync(wait);
      probe = probeLockedFiles(dir);
      if (probe.locked.length === 0) {
        log(`cleared ${killedPids.size} process(es) holding ${dir} open: ${[...killedPids].join(', ')}`);
        return 0;
      }
    }
  }

  if (found.length === 0 && selfHeld.length === 0) {
    log(`holder unknown for ${probe.locked.length} locked file(s); enumeration methods attempted: ${methods.join(', ')}.`);
    log(`first locked file: ${probe.locked[0]}`);
    return 2;
  }
  log(`lock NOT cleared: ${probe.locked.length} file(s) still locked, first is ${probe.locked[0]}. Holders are listed above (PID + image name).`);
  return 1;
}

function killPosix(nodeModulesPath) {
  // pgrep -f matches the FULL command line, so requiring this repo's own
  // absolute node_modules path in the match string is path-scoped: it
  // cannot match a process belonging to a different checkout or project.
  const raw = run(`pgrep -f "${nodeModulesPath.replace(/"/g, '\\"')}"`).trim();
  if (!raw) return [];
  const killed = [];
  for (const line of raw.split('\n')) {
    const pid = Number(line.trim());
    if (!pid || pid === ownPid) continue;
    console.log(`[preflight-clear-build-locks] killing PID ${pid} (matched ${nodeModulesPath})`);
    run(`kill -9 ${pid}`);
    killed.push(pid);
  }
  return killed;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.error) {
  console.error(`[preflight-clear-build-locks] ${opts.error}`);
  console.error(USAGE);
  process.exit(3);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

if (process.platform === 'win32') {
  process.exit(runWindows(opts.dir, opts.reportOnly));
} else {
  const killed = killPosix(opts.dir);
  console.log(
    killed.length > 0
      ? `[preflight-clear-build-locks] cleared ${killed.length} stale process(es) holding node_modules open: ${killed.join(', ')}`
      : '[preflight-clear-build-locks] no stale processes found holding node_modules open.'
  );
  process.exit(0);
}
