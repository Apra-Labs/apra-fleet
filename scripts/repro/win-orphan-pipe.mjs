#!/usr/bin/env node
/**
 * Standalone reproduction: a grandchild that inherits the dispatch's stdio
 * pins the pipe after the dispatched process has already exited (Windows).
 *
 * Shape (the same one the fleet server hits in production):
 *   powershell wrapper  ->  starts a grandchild with UseShellExecute=$false and
 *                           NO redirected handles, so the grandchild inherits
 *                           the wrapper's stdout/stderr
 *   wrapper exits immediately (stand-in for claude.exe finishing its turn)
 *   the grandchild keeps running (stand-in for the deploy sandbox pair, a test
 *   runner, or an orphaned find.exe)
 *
 * Pre-fix the exec side waits for pipe EOF, so the dispatch never returns while
 * the grandchild lives. Post-fix (src/services/exit-drain.ts) it completes
 * within the drain window of the wrapper's exit and the grandchild survives.
 *
 * Usage (Windows, after `npm run build`):
 *   node scripts/repro/win-orphan-pipe.mjs
 *   node scripts/repro/win-orphan-pipe.mjs --grandchild "node dist/index.js --transport http"
 *   node scripts/repro/win-orphan-pipe.mjs --keep     # leave the grandchild running
 *
 * Prints elapsed time to completion, the surviving grandchild pid, and a
 * PASS/FAIL verdict. The same scenario runs as an automated test in
 * tests/execute-command-long-running-windows.test.ts (grandchild-pins-pipe).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default grandchild: a node keep-alive that never exits on its own. */
export const DEFAULT_GRANDCHILD = 'node -e "setInterval(()=>{},1000)"';

/**
 * PowerShell parent script: starts `grandchildCommand` with inherited handles
 * (UseShellExecute=$false, nothing redirected), announces both pids, and exits.
 * Shared with the automated test so the two can never drift apart.
 */
export function buildOrphanPipeParentScript(grandchildCommand = DEFAULT_GRANDCHILD) {
  const trimmed = grandchildCommand.trim();
  const spaceAt = trimmed.indexOf(' ');
  const exe = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const args = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1);
  const psArgs = args.replace(/'/g, "''");
  return [
    'Write-Output "FLEET_PID:$pid"',
    `$psi = [System.Diagnostics.ProcessStartInfo]::new("${exe}", '${psArgs}')`,
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '$p = [System.Diagnostics.Process]::Start($psi)',
    'Write-Output "GRANDCHILD_PID:$($p.Id)"',
    '[Console]::Out.Flush()',
    'exit 0',
  ].join('; ');
}

/** True if a pid is currently running (tasklist on Windows, kill -0 elsewhere). */
export function isPidAlive(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort kill of a pid and its descendants. */
export function killPidTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[win-orphan-pipe] This reproduction only means anything on Windows; exiting.');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const grandchildIdx = argv.indexOf('--grandchild');
  const grandchild = grandchildIdx === -1 ? DEFAULT_GRANDCHILD : argv[grandchildIdx + 1];
  const keep = argv.includes('--keep');
  const deadlineMs = 30_000;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const strategyDist = path.join(repoRoot, 'dist', 'services', 'strategy.js');
  if (!fs.existsSync(strategyDist)) {
    console.error(`[win-orphan-pipe] ${strategyDist} not found -- run "npm run build" first.`);
    process.exit(2);
  }
  const { getStrategy } = await import(`file://${strategyDist.replace(/\\/g, '/')}`);

  const agent = {
    id: `repro-${Date.now()}`,
    friendlyName: 'win-orphan-pipe-repro',
    agentType: 'local',
    os: 'windows',
    workFolder: fs.existsSync(path.join(repoRoot, 'dist')) ? repoRoot : os.tmpdir(),
    createdAt: new Date().toISOString(),
  };

  const script = buildOrphanPipeParentScript(grandchild);
  console.log(`[win-orphan-pipe] grandchild command: ${grandchild}`);
  console.log(`[win-orphan-pipe] parent script: ${script}`);

  const started = Date.now();
  let elapsed = -1;
  let stdout = '';
  let failure = null;
  try {
    const result = await getStrategy(agent).execCommand(script, deadlineMs);
    elapsed = Date.now() - started;
    stdout = result.stdout;
  } catch (err) {
    elapsed = Date.now() - started;
    failure = err instanceof Error ? err.message : String(err);
  }

  const pidMatch = /GRANDCHILD_PID:(\d+)/.exec(stdout);
  const grandchildPid = pidMatch ? Number(pidMatch[1]) : null;
  const alive = grandchildPid === null ? false : isPidAlive(grandchildPid);

  console.log(`[win-orphan-pipe] elapsed to completion: ${elapsed} ms`);
  console.log(`[win-orphan-pipe] grandchild pid: ${grandchildPid ?? '(not reported)'}`);
  console.log(`[win-orphan-pipe] grandchild still alive after the dispatch: ${alive}`);
  if (failure) console.log(`[win-orphan-pipe] dispatch failed: ${failure}`);

  const passed = !failure && grandchildPid !== null && alive && elapsed < deadlineMs / 2;
  console.log(`[win-orphan-pipe] ${passed ? 'PASS' : 'FAIL'} -- dispatch must complete within seconds of the parent exit while the grandchild keeps running.`);

  if (grandchildPid !== null && !keep) {
    killPidTree(grandchildPid);
    console.log(`[win-orphan-pipe] torn down grandchild ${grandchildPid}; still alive: ${isPidAlive(grandchildPid)}`);
  } else if (keep) {
    console.log(`[win-orphan-pipe] --keep given: grandchild ${grandchildPid} left running; kill it with: taskkill /F /T /PID ${grandchildPid}`);
  }
  process.exit(passed ? 0 : 1);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[win-orphan-pipe] unexpected error:', err);
    process.exit(1);
  });
}
