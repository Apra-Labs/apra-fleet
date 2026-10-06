import { existsSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { gitBashCandidates } from '../../src/os/git-bash-candidates.js';

/**
 * Locate a REAL bash for tests that must execute a generated shell string
 * instead of only asserting its text.
 *
 * Windows: only a Git-for-Windows bash.exe at a known install location is
 * accepted (never a bare `bash` off PATH, which may be the WSL launcher).
 * POSIX: `bash` on PATH, verified runnable.
 *
 * Returns { path } when found, otherwise { reason } so callers can skip with a
 * visible message (describe.skipIf + a console.warn of the reason).
 */
export function findRealBash(): { path?: string; reason?: string } {
  if (process.platform === 'win32') {
    const found = gitBashCandidates(process.env.LOCALAPPDATA).find((c) => existsSync(c));
    return found
      ? { path: found }
      : { reason: `no Git-for-Windows bash.exe found (tried ${gitBashCandidates(process.env.LOCALAPPDATA).join(', ')})` };
  }
  const probe = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8', timeout: 10000 });
  return probe.status === 0 ? { path: 'bash' } : { reason: '`bash` is not runnable on PATH' };
}

/** Run `script` as `bash -c <script>` with the bash found by findRealBash(). */
export function runBash(bashPath: string, script: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync(bashPath, ['-c', script], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 20000,
    windowsHide: true,
  });
}
