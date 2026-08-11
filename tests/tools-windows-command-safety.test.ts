/**
 * Guards apra-fleet-ot2z.8 (monitor-task.ts + remove-member.ts): on Windows
 * members these tools must dispatch valid PowerShell (no POSIX-only tokens
 * like ~/, bare $HOME, xargs, kill -0, tail, 2>/dev/null) rooted at a
 * concrete $env:USERPROFILE path, while Linux/macOS behavior stays exactly
 * what it was before that fix. Cleanup-command failures must also be
 * surfaced as warnings, not swallowed.
 *
 * Kept as a single self-contained file per apra-fleet-ot2z.9 -- no shared
 * cross-suite assertion helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();
const mockClose = vi.fn();
const mockReadMemberStatus = vi.fn<(id: string) => string>(() => 'idle');
const mockCancelCredentialCleanup = vi.fn();
const mockEnsureCloudReady = vi.fn<(agent: any) => Promise<any>>((a) => Promise.resolve(a));
const mockStopInstance = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    close: mockClose,
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: (agent: any) => mockEnsureCloudReady(agent),
}));

vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: {
    stopInstance: (...args: any[]) => mockStopInstance(...args),
  },
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: (id: string) => mockReadMemberStatus(id),
}));

vi.mock('../src/services/credential-cleanup.js', () => ({
  cancelCredentialCleanup: (id: string) => mockCancelCredentialCleanup(id),
}));

vi.mock('../src/services/vcs/github.js', () => ({
  githubProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/bitbucket.js', () => ({
  bitbucketProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/azure-devops.js', () => ({
  azureDevOpsProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/known-hosts.js', () => ({
  removeKnownHost: vi.fn(),
}));

import { monitorTask } from '../src/tools/monitor-task.js';
import { removeMember } from '../src/tools/remove-member.js';

// ---------------------------------------------------------------------------
// Local helpers (kept private to this file -- see apra-fleet-ot2z.9)
// ---------------------------------------------------------------------------

/**
 * monitor-task.ts and remove-member.ts wrap Windows-bound scripts as
 * `powershell -EncodedCommand <base64 utf16le>` (wrapPowerShellEncoded).
 * Decode back to the underlying script so assertions can inspect it.
 */
function decodeIfEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  if (!m) return cmd;
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

/**
 * Defect-class assertion for item 6: rejects POSIX-expansion-pasted paths
 * ("$HOME/x", "~/x") while accepting legitimate PowerShell forms
 * ($env:USERPROFILE, `Join-Path $HOME 'x'`, in-script $vars where $HOME is
 * not followed by a literal "/").
 */
function assertNoPosixExpansionPastedPath(script: string): void {
  expect(script).not.toMatch(/~\//);
  expect(script).not.toMatch(/\$HOME\//);
}

describe('defect-class assertion sanity (item 6)', () => {
  it('passes for legitimate PowerShell forms, fails for expansion-pasted POSIX paths', () => {
    // PASS case: $env:USERPROFILE and Join-Path $HOME 'x' (no literal $HOME/ or ~/)
    expect(() => assertNoPosixExpansionPastedPath(
      '$env:USERPROFILE\\.fleet-tasks\\task-abc; Join-Path $HOME \'x\'',
    )).not.toThrow();

    // FAIL case: an expansion-pasted POSIX path leaked into the script
    expect(() => assertNoPosixExpansionPastedPath('cat $HOME/.fleet-tasks/task-abc/status.json')).toThrow();
    expect(() => assertNoPosixExpansionPastedPath('cat ~/.fleet-tasks/task-abc/status.json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1 + 2 + 3: monitor_task
// ---------------------------------------------------------------------------

function makeMonitorAgent(overrides: Record<string, unknown> = {}) {
  return makeTestAgent({
    cloud: {
      provider: 'aws' as const,
      instanceId: 'i-0abc1234def567890',
      region: 'us-east-1',
      idleTimeoutMin: 60,
    },
    ...overrides,
  } as any);
}

describe('monitor_task command safety', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockEnsureCloudReady.mockImplementation((a) => Promise.resolve(a));
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });

  afterEach(() => restoreRegistry());

  it('item 1: dispatches Windows-valid commands with no POSIX-only tokens, rooted at a concrete $env:USERPROFILE path', async () => {
    const member = makeMonitorAgent({ friendlyName: 'win-monitor', os: 'windows' });
    addAgent(member);

    await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' });

    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    const cmds = mockExecCommand.mock.calls.map((c) => c[0] as string);

    for (const raw of cmds) {
      const decoded = decodeIfEncoded(raw);
      expect(decoded).not.toContain('~/');
      expect(decoded).not.toMatch(/\$HOME\b/);
      expect(decoded).not.toContain('xargs');
      expect(decoded).not.toContain('kill -0');
      expect(decoded).not.toContain('tail');
      expect(decoded).not.toContain('2>/dev/null');
    }

    // status/pid/log commands must reference a concrete $env:USERPROFILE-rooted task dir
    const statusAndPidAndLog = cmds.slice(0, 2).concat(cmds.slice(3, 4)).map(decodeIfEncoded);
    for (const decoded of statusAndPidAndLog) {
      expect(decoded).toContain('$env:USERPROFILE\\.fleet-tasks\\task-abcd1234');
    }
  });

  it('item 2: Linux commands are byte-identical to pre-fix behavior', async () => {
    const member = makeMonitorAgent({ friendlyName: 'linux-monitor', os: 'linux' });
    addAgent(member);

    await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' });

    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    const cmds = mockExecCommand.mock.calls.map((c) => c[0] as string);

    expect(cmds[0]).toBe("cat ~/.fleet-tasks/task-abcd1234/status.json 2>/dev/null || echo '{}'");
    expect(cmds[1]).toBe(
      'cat ~/.fleet-tasks/task-abcd1234/task.pid 2>/dev/null | xargs -r kill -0 2>/dev/null && echo alive || echo dead',
    );
    expect(cmds[2]).toBe(
      'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d " "',
    );
    expect(cmds[3]).toBe("tail -20 ~/.fleet-tasks/task-abcd1234/task.log 2>/dev/null || echo ''");
  });

  it('item 3: Windows with a nonexistent task dir returns the normal empty-status result -- no throw, not a bogus "alive"', async () => {
    const member = makeMonitorAgent({ friendlyName: 'win-monitor-missing', os: 'windows' });
    addAgent(member);

    // Stub the exec layer's empty/error output for a nonexistent task dir --
    // this mirrors what the PowerShell Test-Path branches produce today.
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    let result: string | undefined;
    await expect((async () => {
      result = await monitorTask({ member_id: member.id, task_id: 'task-doesnotexist' });
    })()).resolves.not.toThrow();

    const parsed = JSON.parse(result!);
    expect(parsed.status).toBe('unknown');
    expect(parsed.pidAlive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5: remove_member authorized_keys cleanup
// ---------------------------------------------------------------------------

describe('remove_member authorized_keys cleanup command safety', () => {
  let tmpDir: string;
  let keyPath: string;
  const pubKeyLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest0000000000000000000000000000000000 fleet@apra';

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockReadMemberStatus.mockReturnValue('idle');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-key-test-'));
    keyPath = path.join(tmpDir, 'id_ed25519');
    fs.writeFileSync(`${keyPath}.pub`, `${pubKeyLine}\n`, 'utf-8');
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('item 4 (windows): cleanup command has no sed, no ~/.ssh/..., targets the concrete Windows path', async () => {
    const member = makeTestAgent({ friendlyName: 'win-remove', os: 'windows' as any, keyPath });
    addAgent(member);

    await removeMember({ member_id: member.id });

    const cmds = mockExecCommand.mock.calls.map((c) => c[0] as string);
    const akCmdRaw = cmds.find((c) => decodeIfEncoded(c).includes('authorized_keys'));
    expect(akCmdRaw).toBeDefined();
    const decoded = decodeIfEncoded(akCmdRaw!);

    expect(decoded).not.toContain('sed');
    expect(decoded).not.toContain('~/.ssh/');
    expect(decoded).toContain('$env:USERPROFILE\\.ssh\\authorized_keys');
  });

  it('item 4 (linux): cleanup command is byte-identical to today\'s sed command', async () => {
    const member = makeTestAgent({ friendlyName: 'linux-remove', os: 'linux' as any, keyPath });
    addAgent(member);

    await removeMember({ member_id: member.id });

    const cmds = mockExecCommand.mock.calls.map((c) => c[0] as string);
    const akCmd = cmds.find((c) => c.includes('authorized_keys'));
    expect(akCmd).toBeDefined();

    const keyMatch = pubKeyLine.split(/\s+/).slice(0, 2).join(' ');
    const escaped = keyMatch.replace(/\//g, '\\/');
    expect(akCmd).toBe(`sed -i '/${escaped}/d' ~/.ssh/authorized_keys`);
  });

  it('item 5 (windows): cleanup command failure is surfaced as a warning, not swallowed', async () => {
    const member = makeTestAgent({ friendlyName: 'win-remove-fail', os: 'windows' as any, keyPath });
    addAgent(member);

    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (decodeIfEncoded(cmd).includes('authorized_keys')) {
        throw new Error('ssh exec failed');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('Warnings');
    expect(result.toLowerCase()).toContain('authorized_keys');
  });

  it('item 5 (linux/posix): cleanup command failure is surfaced as a warning, not swallowed', async () => {
    const member = makeTestAgent({ friendlyName: 'linux-remove-fail', os: 'linux' as any, keyPath });
    addAgent(member);

    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('authorized_keys')) {
        throw new Error('ssh exec failed');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('Warnings');
    expect(result.toLowerCase()).toContain('authorized_keys');
  });
});
