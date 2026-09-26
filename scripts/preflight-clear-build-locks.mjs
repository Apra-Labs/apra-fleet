#!/usr/bin/env node
// Clears processes that hold a lock on files under THIS repo's node_modules
// (the recurring "npm ci EPERM unlink" class of failure: an orphaned build
// tool from a prior, already-finished/crashed run is still holding
// node_modules/@esbuild/*/esbuild.exe open when a fresh `npm ci` tries to
// replace it -- or, more subtly, some process ANYWHERE on the box has a
// native addon such as node_modules/@rollup/*/rollup.win32-x64-msvc.node
// mapped into its address space).
//
// Two distinct holder classes, both scoped to THIS checkout by absolute path:
//
//   1. In-tree owners -- the process's OWN executable path lives inside this
//      repo's node_modules (a stale esbuild.exe / rollup binary).
//   2. Out-of-tree module holders -- the process image lives anywhere at all
//      (a system node.exe, an editor language server, a leftover vitest
//      worker), but it has LOADED a .node/.dll/.exe file from this repo's
//      node_modules as a mapped module. A matcher that only looks at the
//      process's own image path structurally cannot see these, which is why
//      earlier versions of this script reported success and `npm ci` then
//      died with EPERM/errno -4048 unlink anyway.
//
// Never name-based: a match requires an absolute-path prefix hit on THIS
// checkout's node_modules directory (with a trailing separator, so a sibling
// `node_modules-backup` cannot match). An unrelated process that loaded a
// same-named addon from a DIFFERENT checkout is never reported and never
// killed.
//
// Design: the expensive whole-machine module enumeration is gated behind a
// cheap per-file lock probe. If nothing under node_modules is actually
// locked, the script exits 0 immediately having killed nothing. Only when a
// file is genuinely locked do we scan for the holder, report it, kill what we
// safely can, and RE-PROBE. "Cannot clear" therefore means "empirically still
// locked", not "merely detected" -- so a mapped-but-harmless module in an
// editor does not fail a deploy that would have succeeded.
//
// Exit codes: 0 = nothing locked, or every lock was cleared. 1 = at least one
// file under node_modules is still locked; the blocking PID, its image path
// and the locked file are printed.
//
// Flags: --dry-run  report holders, never kill anything.
//
// Intended as a deploy.md pre-flight step, run just before `npm ci`.
// NOTE: `npm ci` DELETES node_modules before reinstalling it, so a run that
// fails partway leaves node_modules partially installed and NOT usable. Never
// assume a usable tree after a failed `npm ci` -- rerun it to completion.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[preflight-clear-build-locks]';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeModulesPath = path.join(repoRoot, 'node_modules');
// Trailing separator: makes the prefix test a true directory-containment test,
// so `<repo>/node_modules-backup/...` or `..._old/...` can never match.
const nodeModulesPrefix = nodeModulesPath.endsWith(path.sep)
  ? nodeModulesPath
  : nodeModulesPath + path.sep;
const ownPid = process.pid;
const dryRun = process.argv.includes('--dry-run');

const log = (msg) => console.log(`${TAG} ${msg}`);

function isUnderNodeModules(candidate) {
  if (!candidate) return false;
  const normalized = path.normalize(String(candidate));
  return process.platform === 'win32'
    ? normalized.toLowerCase().startsWith(nodeModulesPrefix.toLowerCase())
    : normalized.startsWith(nodeModulesPrefix);
}

function runCapture(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // Non-zero here generally just means "no matches" for the discovery
    // commands below; hand back whatever stdout we got.
    return err && err.stdout ? String(err.stdout) : '';
  }
}

// ---------------------------------------------------------------------------
// Step 1 (cheap): which lock-prone files under node_modules are actually held?
// ---------------------------------------------------------------------------

// Only these can be held as a mapped image / running binary. Data files are
// not the failure mode and probing all ~7k files would be wasteful.
const LOCK_PRONE = /\.(node|exe|dll|dylib|so)$/i;

function collectLockProneFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectLockProneFiles(full, out);
    else if (entry.isFile() && LOCK_PRONE.test(entry.name)) out.push(full);
  }
  return out;
}

// Non-mutating probe. Deliberately NOT a rename/unlink probe: that would be
// higher fidelity to what `npm ci` does, but a crash mid-probe would corrupt
// node_modules -- the very state this script exists to keep you out of.
// A mapped image denies write sharing, so opening for write is the tell.
function isLocked(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    return false;
  } catch (err) {
    const code = err && err.code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function lockedFiles() {
  return collectLockProneFiles(nodeModulesPath).filter(isLocked);
}

// ---------------------------------------------------------------------------
// Step 2 (expensive, gated): find the holders.
// ---------------------------------------------------------------------------

// Enumerate every process's LOADED MODULES and report the ones mapping a file
// out of this checkout's node_modules. Processes we cannot open (access
// denied, protected, cross-bitness) are counted, not silently dropped: a scan
// that finds nothing while a file is still locked must say how much of the
// machine it could not see, or it is just a confident false negative.
const PS_MODULE_SCAN = `param([string]$Prefix)
$ErrorActionPreference = 'SilentlyContinue'
$inspected = 0
$denied = 0
$rows = New-Object System.Collections.ArrayList
foreach ($p in Get-Process) {
  $inspected++
  $mods = $null
  try { $mods = $p.Modules } catch { $mods = $null }
  if ($null -eq $mods) { $denied++; continue }
  $imagePath = ''
  try { if ($p.Path) { $imagePath = $p.Path } } catch { $imagePath = '' }
  foreach ($m in $mods) {
    $f = $m.FileName
    if ($f -and $f.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      [void]$rows.Add([pscustomobject]@{ ProcessId = $p.Id; ImagePath = $imagePath; Module = $f })
    }
  }
}
[pscustomobject]@{ Inspected = $inspected; Denied = $denied; Holders = @($rows) } |
  ConvertTo-Json -Depth 4 -Compress
`;

function withTempPs1(contents, fn) {
  const file = path.join(os.tmpdir(), `preflight-locks-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(file, contents, 'utf8');
  try {
    return fn(file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

function parseJsonLoose(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

// One CIM pass gives us both the in-tree owners and the parent map used to
// build this process's ancestor chain.
function windowsProcessTable() {
  const raw = runCapture('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress',
  ]);
  const parsed = parseJsonLoose(raw);
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function ancestorPidsWindows(table) {
  const parentOf = new Map();
  for (const row of table) {
    if (row && row.ProcessId != null) parentOf.set(Number(row.ProcessId), Number(row.ParentProcessId));
  }
  const chain = new Set();
  let current = parentOf.get(ownPid);
  while (current && current !== 0 && !chain.has(current)) {
    chain.add(current);
    current = parentOf.get(current);
  }
  return chain;
}

function ancestorPidsPosix() {
  const chain = new Set();
  let current = ownPid;
  for (let i = 0; i < 64; i++) {
    const raw = runCapture('ps', ['-o', 'ppid=', '-p', String(current)]).trim();
    const parent = Number(raw);
    if (!parent || parent === 0 || chain.has(parent)) break;
    chain.add(parent);
    current = parent;
  }
  return chain;
}

function scanWindowsHolders() {
  const table = windowsProcessTable();
  const ancestors = ancestorPidsWindows(table);
  const byPid = new Map();

  const add = (pid, imagePath, module, reason) => {
    const numeric = Number(pid);
    if (!numeric) return;
    const existing = byPid.get(numeric) || { pid: numeric, imagePath: imagePath || '', modules: [], reasons: new Set() };
    if (imagePath && !existing.imagePath) existing.imagePath = imagePath;
    if (module && !existing.modules.includes(module)) existing.modules.push(module);
    existing.reasons.add(reason);
    byPid.set(numeric, existing);
  };

  // Class 1: in-tree owners (process image itself lives in node_modules).
  // Path-prefix matched in JS rather than via a WQL `LIKE` filter -- in WQL
  // `_` is a single-character wildcard and `node_modules` contains one, so a
  // LIKE filter over that literal silently over-matches (`node-modules`).
  for (const row of table) {
    if (row && isUnderNodeModules(row.ExecutablePath)) {
      add(row.ProcessId, row.ExecutablePath, '', 'process image inside this checkout node_modules');
    }
  }

  // Class 2: out-of-tree holders of a loaded module from this checkout.
  const scan = withTempPs1(PS_MODULE_SCAN, (file) =>
    parseJsonLoose(
      runCapture('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Prefix', nodeModulesPrefix]),
    ),
  );
  let inspected = 0;
  let denied = 0;
  if (scan) {
    inspected = Number(scan.Inspected) || 0;
    denied = Number(scan.Denied) || 0;
    const holders = Array.isArray(scan.Holders) ? scan.Holders : scan.Holders ? [scan.Holders] : [];
    for (const holder of holders) {
      if (!holder || !isUnderNodeModules(holder.Module)) continue;
      add(holder.ProcessId, holder.ImagePath, holder.Module, 'loaded module from this checkout node_modules');
    }
  }

  return { holders: [...byPid.values()], ancestors, inspected, denied, scanned: Boolean(scan) };
}

function scanPosixHolders() {
  const ancestors = ancestorPidsPosix();
  const byPid = new Map();
  // pgrep -f matches the FULL command line, so requiring this repo's own
  // absolute node_modules path in the match string is path-scoped: it cannot
  // match a process belonging to a different checkout or project.
  const raw = runCapture('pgrep', ['-f', nodeModulesPath]).trim();
  for (const line of raw ? raw.split('\n') : []) {
    const pid = Number(line.trim());
    if (!pid) continue;
    byPid.set(pid, {
      pid,
      imagePath: runCapture('ps', ['-o', 'comm=', '-p', String(pid)]).trim(),
      modules: [],
      reasons: new Set(['command line references this checkout node_modules']),
    });
  }
  return { holders: [...byPid.values()], ancestors, inspected: 0, denied: 0, scanned: true };
}

function killPid(pid) {
  if (process.platform === 'win32') runCapture('taskkill', ['/F', '/T', '/PID', String(pid)]);
  else runCapture('kill', ['-9', String(pid)]);
}

function describe(holder, locked) {
  const image = holder.imagePath || '<image path unavailable>';
  const modules = holder.modules.length ? holder.modules.join(', ') : locked.join(', ') || '<no specific module attributed>';
  return `PID ${holder.pid} (${image}) -- ${[...holder.reasons].join('; ')}; file(s): ${modules}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(nodeModulesPath)) {
    log(`no node_modules at ${nodeModulesPath}; nothing to clear.`);
    return 0;
  }

  let locked = lockedFiles();
  if (locked.length === 0) {
    log(`no locked files under ${nodeModulesPath}; nothing to clear.`);
    return 0;
  }

  log(`${locked.length} locked file(s) under node_modules:`);
  for (const file of locked) log(`  locked: ${file}`);
  log('scanning every process on this machine for holders (this can take ~30s)...');

  const { holders, ancestors, inspected, denied, scanned } =
    process.platform === 'win32' ? scanWindowsHolders() : scanPosixHolders();

  const killable = [];
  const protectedHolders = [];
  for (const holder of holders) {
    if (holder.pid === ownPid) {
      log(`skipping PID ${holder.pid}: that is this script itself.`);
      continue;
    }
    if (ancestors.has(holder.pid)) {
      log(`NOT killing PID ${holder.pid}: it is an ancestor of this script (killing it would take down this session).`);
      protectedHolders.push(holder);
      continue;
    }
    killable.push(holder);
  }

  if (holders.length === 0) {
    log('no holder process could be attributed to those locked files.');
  } else {
    for (const holder of holders) log(`holder: ${describe(holder, locked)}`);
  }

  const killed = [];
  for (const holder of killable) {
    if (dryRun) {
      log(`--dry-run: would kill ${describe(holder, locked)}`);
      continue;
    }
    log(`killing ${describe(holder, locked)}`);
    killPid(holder.pid);
    killed.push(holder.pid);
  }

  // Re-probe: "cannot clear" must mean empirically still locked.
  locked = lockedFiles();
  if (locked.length === 0) {
    log(`cleared ${killed.length} process(es) holding node_modules open: ${killed.join(', ') || 'none'}`);
    return 0;
  }

  log('FAILED to clear all locks under node_modules. Still locked:');
  for (const file of locked) log(`  still locked: ${file}`);
  const remaining = dryRun ? holders : [...protectedHolders, ...killable];
  if (remaining.length > 0) {
    log('blocking process(es):');
    for (const holder of remaining) log(`  ${describe(holder, locked)}`);
  } else {
    log('no blocking process could be attributed to the remaining lock(s).');
  }
  if (process.platform === 'win32') {
    log(
      scanned
        ? `inspected ${inspected} process(es); could not inspect ${denied} (access denied / protected / cross-bitness) -- the holder may be among them. Rerun this script from an elevated shell to see them.`
        : 'the process module scan produced no output at all; rerun from an elevated shell.',
    );
  }
  log('`npm ci` DELETES node_modules before reinstalling, so a run that fails on one of these files leaves node_modules PARTIALLY INSTALLED. Do not treat the tree as usable: clear the lock and rerun `npm ci` to completion.');
  return 1;
}

process.exitCode = main();
