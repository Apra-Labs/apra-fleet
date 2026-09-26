/**
 * apra-fleet-7dir.2.6: table-driven coverage over the member's REGISTERED
 * SHELL for every command builder fixed by the 7dir.2.4/2.5 lane
 * (member-home.ts, orphan-recovery.ts, and the stall/* family). Every other
 * test file covering these builders mocks `../src/utils/agent-helpers.js`
 * (including its own hand-rolled `isPosixShell` copy) purely to keep its
 * pre-existing OS-only assertions green -- that mock would keep passing even
 * if the production wiring silently dropped the `shell` parameter, because
 * the test's own mock (not production code) decides posix-vs-PowerShell.
 *
 * This file deliberately does NOT mock `agent-helpers.js`: it exercises the
 * REAL `getAgentOS`/`getAgentShell`/`isPosixShell` implementations, so a
 * regression in either 7dir.2.4 (member-home/orphan-recovery) or 7dir.2.5
 * (stall/find-log-file/read-log-tail/stall-poller) that reverts a
 * shell-branch back to an OS-only branch will fail a `gitbash` row here.
 *
 * Table: shell in {gitbash, pwsh7, powershell5, unset (undefined)} against a
 * `windows` member. `gitbash` rows assert POSIX output with no PowerShell
 * cmdlet and no `-EncodedCommand` envelope. The other three rows must be
 * byte-identical to each other AND to a hardcoded golden string, so any
 * accidental change to today's PowerShell-member output fails loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';
import { decodePowerShellEncodedCommand } from './test-helpers.js';

type ShellRow = 'gitbash' | 'pwsh7' | 'powershell5' | undefined;
const SHELL_ROWS: ShellRow[] = ['gitbash', 'pwsh7', 'powershell5', undefined];
const isPosixRow = (shell: ShellRow): boolean => shell === 'gitbash';

// ---------------------------------------------------------------------------
// member-home.ts + orphan-recovery.ts: no registry involved, agent/params are
// passed directly, so only strategy.js needs mocking.
// ---------------------------------------------------------------------------

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

import { getMemberHomeDir, clearMemberHomeDirCache } from '../src/services/member-home.js';
import { isRemoteProcessAlive, readDurableOutput } from '../src/services/orphan-recovery.js';

function makeWindowsRemoteAgent(shell: ShellRow, idSuffix: string): Agent {
  return {
    id: `shell-matrix-${idSuffix}`,
    friendlyName: `shell-matrix-${idSuffix}`,
    agentType: 'remote',
    host: '10.0.0.9',
    port: 22,
    username: 'bella',
    authType: 'password',
    encryptedPassword: 'fake',
    workFolder: 'C:\\Users\\bella\\project',
    createdAt: new Date().toISOString(),
    os: 'windows',
    shell,
  } as Agent;
}

describe('member-home.ts home-dir probe: shell matrix', () => {
  beforeEach(() => {
    mockExecCommand.mockReset();
    clearMemberHomeDirCache();
  });

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    const agent = makeWindowsRemoteAgent(shell, `home-${shell ?? 'unset'}`);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (isPosixRow(shell)) return { stdout: '/c/Users/bella\n', stderr: '', code: 0 };
      return { stdout: 'D:\\Profiles\\bella', stderr: '', code: 0 };
    });

    const home = await getMemberHomeDir(agent);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const cmd = mockExecCommand.mock.calls[0][0] as string;

    if (isPosixRow(shell)) {
      expect(cmd).toBe('printf \'%s\' "$HOME"');
      expect(cmd).not.toMatch(/powershell/i);
      expect(cmd).not.toMatch(/EncodedCommand/i);
      expect(home).toBe('/c/Users/bella');
    } else {
      expect(cmd).toMatch(/^powershell -EncodedCommand /);
      const decoded = decodePowerShellEncodedCommand(cmd);
      // Golden: today's exact guarded PowerShell probe script.
      expect(decoded).toBe(
        "$ErrorActionPreference = 'Stop'; try { [Console]::Out.Write($env:USERPROFILE); if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }"
      );
      expect(home).toBe('D:\\Profiles\\bella');
    }
  });

  it('pwsh7, powershell5 and unset all produce byte-identical commands (unchanged from today)', async () => {
    const cmds: string[] = [];
    for (const shell of ['pwsh7', 'powershell5', undefined] as ShellRow[]) {
      mockExecCommand.mockReset();
      clearMemberHomeDirCache();
      mockExecCommand.mockResolvedValue({ stdout: 'D:\\Profiles\\bella', stderr: '', code: 0 });
      await getMemberHomeDir(makeWindowsRemoteAgent(shell, `same-${shell ?? 'unset'}`));
      cmds.push(mockExecCommand.mock.calls[0][0] as string);
    }
    expect(new Set(cmds).size).toBe(1);
  });
});

describe('orphan-recovery.ts process-alive check: shell matrix', () => {
  it.each(SHELL_ROWS)('isRemoteProcessAlive shell=%s', async (shell) => {
    const exec = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>()
      .mockResolvedValue({ stdout: 'ALIVE\n', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    const alive = await isRemoteProcessAlive(strategy, 4242, 'windows', shell);
    expect(alive).toBe(true);
    const cmd = exec.mock.calls[0][0] as string;

    if (isPosixRow(shell)) {
      expect(cmd).toBe('kill -0 4242 2>/dev/null && echo ALIVE || echo DEAD');
      expect(cmd).not.toMatch(/powershell/i);
      expect(cmd).not.toMatch(/EncodedCommand/i);
    } else {
      expect(cmd).toMatch(/^powershell -EncodedCommand /);
      const decoded = decodePowerShellEncodedCommand(cmd);
      expect(decoded).toBe(
        "$ErrorActionPreference = 'Stop'; try { if (Get-Process -Id 4242 -ErrorAction SilentlyContinue) { echo ALIVE } else { echo DEAD }; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }"
      );
    }
  });
});

describe('orphan-recovery.ts durable-file read: shell matrix', () => {
  it.each(SHELL_ROWS)('readDurableOutput shell=%s', async (shell) => {
    const exec = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>()
      .mockResolvedValue({ stdout: 'the durable payload', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;
    const path = isPosixRow(shell) ? '/c/Users/bella/.fleet-out-abc.json' : 'C:\\Users\\bella\\.fleet-out-abc.json';

    const out = await readDurableOutput(strategy, path, 'windows', shell);
    expect(out).toBe('the durable payload');
    const cmd = exec.mock.calls[0][0] as string;

    if (isPosixRow(shell)) {
      expect(cmd).toBe(`cat "${path}" 2>/dev/null`);
      expect(cmd).not.toMatch(/powershell/i);
      expect(cmd).not.toMatch(/EncodedCommand/i);
    } else {
      expect(cmd).toMatch(/^powershell -EncodedCommand /);
      const decoded = decodePowerShellEncodedCommand(cmd);
      expect(decoded).toBe(
        `$ErrorActionPreference = 'Stop'; try { if (Test-Path "${path}") { Get-Content -Path "${path}" -Raw } else { echo '' }; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// find-log-file.ts / read-log-tail.ts / stall-poller.ts: these look the agent
// up by id via registry.js internally, so that module needs mocking (but NOT
// agent-helpers.js -- the whole point of this file is to exercise its real
// isPosixShell wiring).
// ---------------------------------------------------------------------------

const { mockGetAgent } = vi.hoisted(() => ({
  mockGetAgent: vi.fn<(id: string) => Agent | undefined>(),
}));

vi.mock('../src/services/registry.js', () => ({
  getAgent: mockGetAgent,
  updateAgent: vi.fn(),
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: vi.fn(),
  logWarn: vi.fn(),
}));

import { findLogFile } from '../src/services/stall/find-log-file.js';
import { readLogTail } from '../src/services/stall/read-log-tail.js';
import { pollLogFile } from '../src/services/stall/stall-poller.js';

function makeWindowsRemoteAgentFor(shell: ShellRow, idSuffix: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: `shell-matrix-${idSuffix}`,
    friendlyName: `shell-matrix-${idSuffix}`,
    agentType: 'remote',
    host: '10.0.0.9',
    port: 22,
    username: 'bella',
    workFolder: 'C:\\Users\\bella\\project',
    createdAt: new Date().toISOString(),
    os: 'windows',
    shell,
    llmProvider: 'claude',
    ...extra,
  } as Agent;
}

describe('find-log-file.ts log-file discovery: shell matrix', () => {
  beforeEach(() => {
    mockExecCommand.mockReset();
    mockGetAgent.mockReset();
  });

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    // No sessionId -> the mtime-scan branch (findRemoteMtimeCandidates),
    // returning a single candidate so the tie-break (grep/Select-String)
    // branch is never reached.
    const agent = makeWindowsRemoteAgentFor(shell, `find-${shell ?? 'unset'}`, { sessionId: undefined });
    mockGetAgent.mockReturnValue(agent);
    const candidate = isPosixRow(shell) ? '/home/bella/.claude/projects/p/session.jsonl' : 'C:\\Users\\bella\\.claude\\projects\\p\\session.jsonl';
    mockExecCommand.mockResolvedValue({ stdout: `${candidate}\n`, stderr: '', code: 0 });

    const result = await findLogFile('shell-matrix-find', 1_000_000_000, 'inv-1', 'C:\\Users\\bella\\.claude\\projects\\p');
    expect(result).toBe(candidate);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const cmd = mockExecCommand.mock.calls[0][0] as string;

    if (isPosixRow(shell)) {
      expect(cmd).toMatch(/^find "/);
      expect(cmd).not.toMatch(/powershell/i);
      expect(cmd).not.toMatch(/EncodedCommand/i);
    } else {
      // Golden: today's exact raw (non-encoded) PowerShell one-liner.
      expect(cmd).toBe(
        `powershell -c "Get-ChildItem -Path 'C:\\Users\\bella\\.claude\\projects\\p' -Filter '*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt [DateTime]::Parse('1970-01-12T13:46:40') } | ForEach-Object { $_.FullName }"`
      );
      expect(cmd).not.toMatch(/EncodedCommand/i);
    }
  });
});

describe('read-log-tail.ts log-tail read: shell matrix', () => {
  beforeEach(() => {
    mockExecCommand.mockReset();
    mockGetAgent.mockReset();
  });

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    const agent = makeWindowsRemoteAgentFor(shell, `tail-${shell ?? 'unset'}`);
    mockGetAgent.mockReturnValue(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await readLogTail('shell-matrix-tail', 'C:\\Users\\bella\\.claude\\session.jsonl');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const cmd = mockExecCommand.mock.calls[0][0] as string;

    if (isPosixRow(shell)) {
      expect(cmd).toBe('tail -c 512 "C:\\Users\\bella\\.claude\\session.jsonl"');
      expect(cmd).not.toMatch(/powershell/i);
    } else {
      // Golden: today's exact raw PowerShell tail command.
      expect(cmd).toBe(`powershell -c "Get-Content -Tail 5 -Path 'C:\\Users\\bella\\.claude\\session.jsonl'"`);
    }
  });
});

describe('stall-poller.ts poller mtime fetch: shell matrix', () => {
  beforeEach(() => {
    mockExecCommand.mockReset();
    mockGetAgent.mockReset();
  });

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    const agent = makeWindowsRemoteAgentFor(shell, `mtime-${shell ?? 'unset'}`);
    mockGetAgent.mockReturnValue(agent);
    const posix = isPosixRow(shell);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (/^stat -c %Y|DateTimeOffset/.test(cmd)) {
        return posix ? { stdout: '1700000000\n', stderr: '', code: 0 } : { stdout: '1700000000000\n', stderr: '', code: 0 };
      }
      // The content-tail call -- irrelevant to this test, return empty.
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await pollLogFile('shell-matrix-mtime', 'C:\\Users\\bella\\.claude\\session.jsonl');
    expect(result.mtimeMs).toBe(1_700_000_000_000);
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
    const mtimeCmd = mockExecCommand.mock.calls[0][0] as string;

    if (posix) {
      expect(mtimeCmd).toBe(
        'stat -c %Y "C:\\Users\\bella\\.claude\\session.jsonl" 2>/dev/null || stat -f %m "C:\\Users\\bella\\.claude\\session.jsonl" 2>/dev/null'
      );
      expect(mtimeCmd).not.toMatch(/powershell/i);
    } else {
      // Golden: today's exact raw PowerShell mtime one-liner.
      expect(mtimeCmd).toBe(
        `powershell -c "[DateTimeOffset]::new((Get-Item -LiteralPath 'C:\\Users\\bella\\.claude\\session.jsonl' -ErrorAction SilentlyContinue).LastWriteTimeUtc, [TimeSpan]::Zero).ToUnixTimeMilliseconds()"`
      );
    }
  });
});
