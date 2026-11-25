/**
 * apra-fleet-0pvq.3: execute_command long_running must never report a fake
 * success, and monitor_task must say when a task never started.
 *
 * - A launch that exits nonzero, or exits 0 without the readiness marker the
 *   launch script prints once the wrapper started, is a typed launch_failed
 *   failure with credential values redacted -- never a task_id.
 * - A successful launch returns only after the task dir and task.pid exist.
 *   The POSIX launch script is executed for real by a fake strategy that runs
 *   it through bash with HOME pointed at a per-test sandbox (Git Bash on a
 *   Windows host, /bin/bash elsewhere), so the ordering is checked against
 *   the real script, not a mock. The Windows script's ordering is asserted
 *   on its decoded text: its detached WMI process does not inherit an
 *   overridden USERPROFILE, so a real run could not be kept in a sandbox.
 * - monitor_task on a task id whose directory/wrapper never appeared reports
 *   status launch_failed with a reason, never unknown with all fields null.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand, TASK_READY_MARKER } from '../src/tools/execute-command.js';
import { monitorTask } from '../src/tools/monitor-task.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import { resolveGitBashPath } from '../src/os/windows-gitbash.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: vi.fn((member: any) => Promise.resolve(member)),
}));

function decodeIfEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
}

const MEMBER_ROWS: { label: string; os: 'linux' | 'windows' | 'macos'; shell?: string }[] = [
  { label: 'linux', os: 'linux' },
  { label: 'macos', os: 'macos' },
  { label: 'windows powershell5', os: 'windows', shell: 'powershell5' },
  { label: 'windows pwsh7', os: 'windows', shell: 'pwsh7' },
  { label: 'windows gitbash', os: 'windows', shell: 'gitbash' },
];

describe('execute_command long_running: a launch that did not start is a typed failure', () => {
  const credName = `launchTok${Date.now()}`;
  const secret = 'launch-secret-value-123';

  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    credentialSet(credName, secret, false, 'allow');
  });

  afterEach(() => {
    credentialDelete(credName);
    restoreRegistry();
  });

  it.each(MEMBER_ROWS)('$label: a nonzero launch exit returns launch_failed with redacted output and no task_id', async (row) => {
    const member = makeTestAgent({ os: row.os, shell: row.shell } as any);
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: 'TASK_PID:77\n',
      stderr: `Win32_Process.Create failed with code 9 while using ${secret}`,
      code: 1,
    });

    const result = await executeCommand({
      member_id: member.id,
      command: `python train.py --token {{secret.${credName}}}`,
      long_running: true,
      timeout_s: 5,
    } as any);

    expect(typeof result).toBe('object');
    const r = result as Exclude<typeof result, string>;
    expect(r.text).toMatch(/^Failed to launch task on "/);
    expect(r.text).not.toContain('Task launched');
    expect(r.text).not.toMatch(/task_id=/);
    expect(r.structuredContent).toMatchObject({ isError: true, reason: 'launch_failed', exitCode: -1 });
    expect(r.text).not.toContain(secret);
    expect(r.structuredContent!.stderr).not.toContain(secret);
    expect(r.structuredContent!.stderr).toContain(`[REDACTED:${credName}]`);
    expect(r.structuredContent!.stderr).toContain('Win32_Process.Create failed');
  });

  it.each(MEMBER_ROWS)('$label: exit 0 without the readiness marker (wrapper never confirmed) is launch_failed too', async (row) => {
    const member = makeTestAgent({ os: row.os, shell: row.shell } as any);
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:77\n', stderr: '', code: 0 });

    const r = await executeCommand({ member_id: member.id, command: 'python train.py', long_running: true, timeout_s: 5 } as any);

    expect(resultText(r)).toMatch(/^Failed to launch task on "/);
    expect(resultText(r)).not.toMatch(/task_id=/);
    expect((r as any).structuredContent).toMatchObject({ isError: true, reason: 'launch_failed' });
  });

  it.each(MEMBER_ROWS)('$label: exit 0 plus the readiness marker is the only success shape', async (row) => {
    const member = makeTestAgent({ os: row.os, shell: row.shell } as any);
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: `TASK_PID:77\r\n${TASK_READY_MARKER}\r\n`, stderr: '', code: 0 });

    const r = await executeCommand({ member_id: member.id, command: 'python train.py', long_running: true, timeout_s: 5 } as any);

    expect(resultText(r)).toMatch(/Task launched: task_id=task-[a-z0-9]+/);
  });

  it.each(['powershell5', 'pwsh7', 'gitbash', undefined])('windows (shell=%s): the launch script waits for task.pid before printing the readiness marker, and fails when it never appears', async (shell) => {
    const member = makeTestAgent({ os: 'windows', shell } as any);
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: TASK_READY_MARKER, stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'python train.py', long_running: true, timeout_s: 5 } as any);

    const script = decodeIfEncoded(mockExecCommand.mock.calls[0][0] as string);
    const create = script.indexOf('Invoke-CimMethod');
    const poll = script.indexOf('task.pid") { $ready = $true');
    const ready = script.indexOf(`Write-Output "${TASK_READY_MARKER}"`);
    expect(create).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(create);
    expect(ready).toBeGreaterThan(poll);
    expect(script).toMatch(/if \(-not \$ready\) \{ Stop-Process -Id \$result\.ProcessId[^}]*exit 1 \}/);
    // PowerShell only on the Windows path: no POSIX expansion or tokens.
    expect(script).not.toContain('~/');
    expect(script).not.toContain('$HOME');
    expect(script).not.toContain('2>/dev/null');
  });
});

/**
 * Real bash for the POSIX launch/monitor scripts. Git Bash on a Windows host
 * (skipped with a stated reason when absent), /bin/bash elsewhere.
 */
const realBash: string | undefined = process.platform === 'win32'
  ? (() => { try { return resolveGitBashPath(); } catch { return undefined; } })()
  : '/bin/bash';
const realBashSkipReason = realBash ? '' : ' [SKIPPED: no Git for Windows bash.exe on this Windows host]';

describe.skipIf(!realBash)(`long_running POSIX launch + monitor_task run for real in a sandboxed HOME${realBashSkipReason}`, () => {
  let sandbox: string;
  let home: string;
  let work: string;

  /** Run a member-bound command through real bash with HOME in the sandbox. The
   *  command is passed as a script file, never as a huge argv element. */
  function runInSandbox(cmd: string, homeDir = home): Promise<SSHExecResult> {
    const scriptFile = path.join(sandbox, `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(scriptFile, cmd);
    return new Promise((resolve, reject) => {
      const child = spawn(realBash!, [scriptFile.replace(/\\/g, '/')], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, GIT_CONFIG_GLOBAL: path.join(sandbox, 'gitconfig') },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        fs.rmSync(scriptFile, { force: true });
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  async function waitForFinished(statusFile: string): Promise<void> {
    for (let i = 0; i < 150; i++) {
      if (fs.existsSync(statusFile) && !/"status":"running"/.test(fs.readFileSync(statusFile, 'utf-8'))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    mockExecCommand.mockImplementation((cmd: string) => runInSandbox(cmd));
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lr-launch-'));
    home = path.join(sandbox, 'home');
    work = path.join(sandbox, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
  });

  afterEach(async () => {
    restoreRegistry();
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    expect(fs.existsSync(sandbox)).toBe(false);
  });

  it('returns only after the task dir and task.pid exist, and monitor_task then sees the task', async () => {
    const member = makeTestAgent({ os: 'linux', workFolder: work.replace(/\\/g, '/') });
    addAgent(member);

    const r = await executeCommand({ member_id: member.id, command: 'sleep 2', long_running: true, timeout_s: 30, max_retries: 0 } as any);

    // Checked synchronously at the moment the launch returned.
    const text = resultText(r);
    const taskId = /task_id=(task-[a-z0-9]+)/.exec(text)?.[1];
    expect(taskId, text).toBeDefined();
    const taskDir = path.join(home, '.fleet-tasks', taskId!);
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'task.pid'))).toBe(true);

    const monitored = JSON.parse(await monitorTask({ member_id: member.id, task_id: taskId! } as any));
    expect(monitored.status).toBe('running');
    expect(monitored.pidAlive).toBe(true);

    await waitForFinished(path.join(taskDir, 'status.json'));
    expect(fs.readFileSync(path.join(taskDir, 'status.json'), 'utf-8')).toContain('"status":"completed"');
  }, 60_000);

  it('a task that finishes before the readiness poll sees task.pid still counts as launched', async () => {
    const member = makeTestAgent({ os: 'linux', workFolder: work.replace(/\\/g, '/') });
    addAgent(member);

    const r = await executeCommand({ member_id: member.id, command: 'true', long_running: true, timeout_s: 30, max_retries: 0 } as any);

    const taskId = /task_id=(task-[a-z0-9]+)/.exec(resultText(r))?.[1];
    expect(taskId, resultText(r)).toBeDefined();
    await waitForFinished(path.join(home, '.fleet-tasks', taskId!, 'status.json'));
  }, 60_000);

  it('a launch whose setup fails on the member (task dir cannot be created) is launch_failed, not a task_id', async () => {
    // HOME is a regular file, so `mkdir -p ~/.fleet-tasks/<id>` fails. The old
    // script backgrounded the whole setup chain and still reported success.
    const fileHome = path.join(sandbox, 'home-is-a-file');
    fs.writeFileSync(fileHome, 'not a directory');
    mockExecCommand.mockImplementation((cmd: string) => runInSandbox(cmd, fileHome));
    const member = makeTestAgent({ os: 'linux', workFolder: work.replace(/\\/g, '/') });
    addAgent(member);

    const r = await executeCommand({ member_id: member.id, command: 'sleep 1', long_running: true, timeout_s: 30, max_retries: 0 } as any);

    expect(resultText(r)).toMatch(/^Failed to launch task on "/);
    expect(resultText(r)).not.toMatch(/task_id=/);
    expect((r as any).structuredContent).toMatchObject({ isError: true, reason: 'launch_failed' });
  }, 60_000);

  it('monitor_task on a task id that never started reports launch_failed with a reason', async () => {
    const member = makeTestAgent({ os: 'linux', workFolder: work.replace(/\\/g, '/') });
    addAgent(member);

    const missing = JSON.parse(await monitorTask({ member_id: member.id, task_id: 'task-neverran1' } as any));
    expect(missing.status, JSON.stringify(missing)).toBe('launch_failed');
    expect(missing.reason).toMatch(/never started.*does not exist/);
    expect(missing.pidAlive).toBe(false);

    fs.mkdirSync(path.join(home, '.fleet-tasks', 'task-emptydir1'), { recursive: true });
    const empty = JSON.parse(await monitorTask({ member_id: member.id, task_id: 'task-emptydir1' } as any));
    expect(empty.status).toBe('launch_failed');
    expect(empty.reason).toMatch(/wrapper never wrote status\.json or task\.pid/);
  }, 60_000);
});

describe('monitor_task: never-started task (fake strategy, Windows and POSIX command shapes)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
  });

  afterEach(() => restoreRegistry());

  it.each(MEMBER_ROWS)('$label: missing task dir -> launch_failed with a reason, not unknown with null fields', async (row) => {
    const member = makeTestAgent({ os: row.os, shell: row.shell } as any);
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const s = decodeIfEncoded(cmd);
      if (s.includes('status.json')) return { stdout: '{}', stderr: '', code: 0 };
      if (s.includes('task.pid')) return { stdout: 'dead', stderr: '', code: 0 };
      if (s.includes('task.log')) return { stdout: '', stderr: '', code: 0 };
      if (s.includes('echo present')) return { stdout: 'missing\r\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const res = JSON.parse(await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' } as any));
    expect(res.status).toBe('launch_failed');
    expect(res.reason).toMatch(/never started/);
  });

  it('a status read that throws reports unknown WITH a reason, distinct from never-started', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('status.json')) throw new Error('ssh channel closed');
      return { stdout: 'dead', stderr: '', code: 0 };
    });

    const res = JSON.parse(await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' } as any));
    expect(res.status).toBe('unknown');
    expect(res.reason).toMatch(/ssh channel closed/);
  });
});
