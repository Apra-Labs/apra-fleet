// Git Bash FLEET_PID carries the Windows pid, and a timeout kill by that pid
// takes down the command tree and nothing else (src/os/windows-gitbash.ts
// pidWrapGitBash / killPid, src/os/linux.ts pidWrap hook).
//
// Unit part runs everywhere. The live part needs a Windows host with Git for
// Windows; it only ever kills processes this test started itself.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOsCommands } from '../src/os/index.js';
import { pidWrapGitBash, resolveGitBashPath } from '../src/os/windows-gitbash.js';
import { getProvider } from '../src/providers/index.js';
import { isPidAlive } from '../src/utils/pid-helpers.js';
import { isRemoteProcessAlive } from '../src/services/orphan-recovery.js';

const claude = getProvider('claude');
const promptOpts = {
  folder: '/home/u/work', promptFile: '.fleet-task.md', sessionId: 'sess-1', resuming: true,
  unattended: 'auto', model: 'opus', maxTurns: 10,
} as const;

const GITBASH_EMIT = String.raw`_fleet_wpid=; { read -r _fleet_wpid < "/proc/$_fleet_pid/winpid"; } 2>/dev/null; if [ -n "$_fleet_wpid" ]; then printf 'FLEET_PID:%s\n' "$_fleet_wpid"; fi; `;

describe('Git Bash FLEET_PID emit (unit)', () => {
  const gitbash = getOsCommands('windows', 'gitbash');

  it('wrapPidCapture emits the Windows pid read from /proc/<msys-pid>/winpid, never $! itself', () => {
    const cmd = gitbash.wrapPidCapture('echo hi');
    expect(cmd).toBe(String.raw`{ echo hi; } & _fleet_pid=$!; ${GITBASH_EMIT}wait "$_fleet_pid"; exit $?`);
    expect(cmd).toBe(pidWrapGitBash('echo hi'));
    expect(cmd).not.toContain(String.raw`printf 'FLEET_PID:%s\n' "$_fleet_pid"`);
  });

  it('buildAgentPromptCommand (the other emit path) emits the same Windows pid form', () => {
    const cmd = gitbash.buildAgentPromptCommand(claude, promptOpts as never);
    expect(cmd).toContain(String.raw`; } & _fleet_pid=$!; ${GITBASH_EMIT}wait "$_fleet_pid"; exit $?`);
    expect(cmd.endsWith(String.raw`${GITBASH_EMIT}wait "$_fleet_pid"; exit $?`)).toBe(true);
    expect(cmd).not.toContain(String.raw`printf 'FLEET_PID:%s\n' "$_fleet_pid"`);
  });

  it('the emitted marker still matches the FLEET_PID regex ssh.ts and strategy.ts parse', () => {
    expect(/^FLEET_PID:(\d+)\r?$/m.exec('FLEET_PID:33584\n')?.[1]).toBe('33584');
    expect(gitbash.wrapPidCapture('x')).toContain(String.raw`printf 'FLEET_PID:%s\n'`);
  });

  it('killPid output is unchanged', () => {
    expect(gitbash.killPid(4242)).toBe('taskkill //F //T //PID 4242 >/dev/null 2>&1; true');
  });
});

describe('linux/macOS FLEET_PID wrapper is byte-identical to before the Git Bash change', () => {
  // Captured from the builders at the commit before the change.
  const WRAP = String.raw`{ echo hi; } & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?`;
  const PROMPT = String.raw`{ cd "/home/u/work" && export PATH="$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin" && unset ANTIGRAVITY_SOURCE_METADATA CLAUDE_SOURCE_METADATA COPILOT_SOURCE_METADATA CODEX_SOURCE_METADATA && claude -p "Your task is described in .fleet-task.md in the current directory. Read that file first, then execute the task." --output-format json --max-turns 10 --resume "sess-1" --permission-mode auto --model "opus"; } & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?`;

  for (const osName of ['linux', 'macos'] as const) {
    it(`${osName}: wrapPidCapture and buildAgentPromptCommand unchanged`, () => {
      const cmds = getOsCommands(osName);
      expect(cmds.wrapPidCapture('echo hi')).toBe(WRAP);
      expect(cmds.buildAgentPromptCommand(claude, promptOpts as never)).toBe(PROMPT);
    });
  }
});

// --- Live ---

function liveSkipReason(): string | undefined {
  if (process.platform !== 'win32') return 'not a Windows host';
  try {
    resolveGitBashPath();
    return undefined;
  } catch (e) {
    return `no Git for Windows bash.exe (${String((e as Error).message).slice(0, 120)})`;
  }
}
const skipReason = liveSkipReason();

/**
 * Windows parent chain from `pid` upward until `stopAt` (inclusive) or 12
 * steps. Lookups by process id only -- nothing is enumerated by name.
 */
function parentChain(pid: number, stopAt: number): number[] {
  const script = [
    `$p = ${pid}; $out = @()`,
    `for ($i = 0; $i -lt 12; $i++) {`,
    `  $out += $p`,
    `  if ($p -eq ${stopAt}) { break }`,
    `  $q = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).ParentProcessId`,
    `  if (-not $q) { break }`,
    `  $p = $q`,
    `}`,
    `$out -join ','`,
  ].join('\n');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8', windowsHide: true, timeout: 30_000,
  });
  return out.trim().split(',').filter(Boolean).map(Number);
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe('Git Bash timeout kill by Windows pid (live)', () => {
  let tmp: string | undefined;
  let sentinel: ChildProcess | undefined;
  let wrapped: ChildProcess | undefined;
  let innerPid: number | undefined;

  afterEach(() => {
    // Only processes this test started, each by its own handle or pid.
    if (innerPid !== undefined && isPidAlive(innerPid)) {
      try { process.kill(innerPid); } catch { /* gone */ }
    }
    if (wrapped?.pid !== undefined && wrapped.exitCode === null && wrapped.signalCode === null) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(wrapped.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
    }
    if (sentinel && sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined; sentinel = undefined; wrapped = undefined; innerPid = undefined;
  });

  it.skipIf(skipReason !== undefined)(
    `kills the wrapped command and its child, leaves a sentinel alive${skipReason ? ` (skipped: ${skipReason})` : ''}`,
    async () => {
      const bash = resolveGitBashPath();
      const gitbash = getOsCommands('windows', 'gitbash');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gitbash-winpid-'));
      const env = {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
      };

      sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      expect(sentinel.pid).toBeDefined();

      const node = process.execPath.replace(/\\/g, '/');
      const inner = `"${node}" -e "console.log('CHILD:' + process.pid); setInterval(() => {}, 1000)"`;
      wrapped = spawn(bash, ['-c', gitbash.wrapPidCapture(inner)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise<void>((resolve) => wrapped!.on('close', () => resolve()));
      let out = '';
      wrapped.stdout!.on('data', (d: Buffer) => { out += d.toString(); });

      expect(await waitFor(() => /^FLEET_PID:\d+\r?$/m.test(out) && /^CHILD:\d+\r?$/m.test(out), 20_000)).toBe(true);
      const fleetPid = Number(/^FLEET_PID:(\d+)\r?$/m.exec(out)![1]);
      innerPid = Number(/^CHILD:(\d+)\r?$/m.exec(out)![1]);

      // Guard before any kill: FLEET_PID must be a Windows process on the
      // chain between the node child and the bash.exe this test spawned.
      // An MSYS pid (the pre-fix behaviour) fails here and nothing is killed.
      const chain = parentChain(innerPid, wrapped.pid!);
      expect(chain[chain.length - 1], `chain ${chain.join(' -> ')}`).toBe(wrapped.pid);
      expect(chain, `FLEET_PID ${fleetPid} not in chain ${chain.join(' -> ')}`).toContain(fleetPid);
      expect(fleetPid).not.toBe(wrapped.pid);

      // Liveness probe a Git Bash member's remote check issues, run through its
      // own bash: the live winpid must read ALIVE (kill -0 reads it DEAD).
      const bashStrategy = {
        execCommand: async (cmd: string) => ({
          stdout: execFileSync(bash, ['-c', cmd], { env, windowsHide: true, timeout: 30_000, encoding: 'utf-8' }),
          stderr: '', code: 0,
        }),
      } as never;
      expect(await isRemoteProcessAlive(bashStrategy, fleetPid, 'windows', 'gitbash')).toBe(true);

      execFileSync(bash, ['-c', gitbash.killPid(fleetPid)], { env, windowsHide: true, timeout: 30_000 });

      expect(await waitFor(() => !isPidAlive(innerPid!), 10_000)).toBe(true);
      expect(isPidAlive(fleetPid)).toBe(false);
      expect(await isRemoteProcessAlive(bashStrategy, fleetPid, 'windows', 'gitbash')).toBe(false);
      await Promise.race([closed, new Promise((r) => setTimeout(r, 10_000))]);
      expect(wrapped.exitCode !== null || wrapped.signalCode !== null).toBe(true);

      expect(sentinel.exitCode).toBeNull();
      expect(isPidAlive(sentinel.pid!)).toBe(true);
    },
    90_000,
  );
});
