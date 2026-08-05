#!/usr/bin/env node
// Kills processes that hold a lock on files under THIS repo's node_modules
// (the recurring "npm ci EPERM unlink esbuild.exe" class of failure: an
// orphaned build-tool child from a prior, already-finished/crashed run is
// still holding node_modules/@esbuild/*/esbuild.exe open when a fresh
// `npm ci` tries to replace it).
//
// Ownership-scoped, never name-based: a match requires the process's own
// executable path (Windows) or full command line (POSIX, via `pgrep -f`)
// to point INSIDE this exact repo's node_modules directory. This can never
// hit an unrelated esbuild.exe/process from a different project or a
// different checkout of this same repo -- unlike a blind
// `taskkill /IM esbuild.exe /F` or `pkill esbuild`, which would.
//
// Intended as a deploy.md pre-flight step, run just before `npm ci`.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeModulesPath = path.join(repoRoot, 'node_modules');
const ownPid = process.pid;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    // A non-zero exit here just means "no matches" for most of the
    // discovery commands below -- treat stdout (if any) as the result and
    // let callers deal with empty output.
    return err.stdout ? String(err.stdout) : '';
  }
}

function killWindows() {
  const escaped = nodeModulesPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const psCmd =
    `Get-CimInstance Win32_Process -Filter "ExecutablePath LIKE '${escaped}%'" ` +
    `| Select-Object -Property ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  const raw = run(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`).trim();
  if (!raw) return [];
  let rows;
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  const killed = [];
  for (const row of rows) {
    const pid = row.ProcessId;
    if (!pid || pid === ownPid) continue;
    console.log(`[preflight-clear-build-locks] killing PID ${pid} (${row.ExecutablePath})`);
    run(`taskkill /F /T /PID ${pid}`);
    killed.push(pid);
  }
  return killed;
}

function killPosix() {
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

const killed = process.platform === 'win32' ? killWindows() : killPosix();
console.log(
  killed.length > 0
    ? `[preflight-clear-build-locks] cleared ${killed.length} stale process(es) holding node_modules open: ${killed.join(', ')}`
    : '[preflight-clear-build-locks] no stale processes found holding node_modules open.'
);
