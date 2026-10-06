/**
 * Per-step bounds for register_member (apra-fleet-njeb).
 *
 * RegistrationTimer unit behaviour, plus one end-to-end registration whose
 * Windows shell probe never answers: the call must return within the
 * shell-probe bound, register the member, and name the probe as degraded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec } from './test-helpers.js';
import { RegistrationTimer, DEFAULT_STEP_BOUNDS_MS, formatBound } from '../src/services/registration-steps.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    receiveFiles: vi.fn(),
    deleteFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

function decodeIfEncoded(command: string): string {
  const m = /-EncodedCommand\s+(\S+)/.exec(command);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : command;
}

/** A shell-probe command (Git-bash discovery or a PowerShell smoke probe). */
function isShellProbe(cmd: string): boolean {
  const script = decodeIfEncoded(cmd);
  return script.includes('BASHCAND:') || script.includes('PSMAJOR:') || script.includes('PSEDITION:');
}

describe('RegistrationTimer', () => {
  it('records a step that settles within its bound as ok', async () => {
    const timer = new RegistrationTimer({ 'shell-probe': 1_000 });
    const r = await timer.run('shell-probe', async () => 'pwsh7');
    expect(r).toEqual({ timedOut: false, value: 'pwsh7' });
    expect(timer.degraded()).toEqual([]);
    expect(timer.steps[0]).toMatchObject({ step: 'shell-probe', outcome: 'ok' });
  });

  it('stops waiting for a step that never settles and reports it timed out', async () => {
    const timer = new RegistrationTimer({ 'cli-version': 30 });
    const started = Date.now();
    const r = await timer.run('cli-version', () => new Promise<never>(() => {}));
    expect(r).toEqual({ timedOut: true, boundMs: 30 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(timer.degraded()).toEqual(['cli-version']);
    expect(timer.summary()).toMatch(/^cli-version=\d+ms\(timed-out\) total=\d+ms$/);
  });

  it('propagates a step rejection unchanged', async () => {
    const timer = new RegistrationTimer();
    await expect(timer.run('connect', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('keeps the defaults for steps the override does not name', () => {
    const timer = new RegistrationTimer({ 'shell-probe': 5 });
    expect(timer.boundFor('shell-probe')).toBe(5);
    expect(timer.boundFor('compose-permissions')).toBe(DEFAULT_STEP_BOUNDS_MS['compose-permissions']);
    expect(formatBound(30_000)).toBe('30s');
    expect(formatBound(250)).toBe('250ms');
  });
});

describe('register_member: a hanging probe is bounded, not waited on', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns within the shell-probe bound with the member registered and shell-probe degraded', async () => {
    const configExec = makeConfigAwareExec('');
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      // Windows member: OS detection answers; the shell probe never does.
      if (cmd === 'ver') return { stdout: 'Microsoft Windows [Version 10.0.19045]', stderr: '', code: 0 };
      if (cmd === 'uname -s' || cmd === 'echo $env:OS') return { stdout: '', stderr: '', code: 0 };
      if (isShellProbe(cmd)) return new Promise<SSHExecResult>(() => {});
      return configExec(cmd);
    });

    const BOUND = 300;
    const started = Date.now();
    const result = await registerMember({
      friendly_name: 'win-hang', member_type: 'remote', host: '10.0.0.9', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: 'C:\\fleet\\work', llm_provider: 'none',
    } as never, { stepBoundsMs: { 'shell-probe': BOUND }, skipFleetMcp: true });
    const elapsed = Date.now() - started;

    expect(result).toContain('registered successfully');
    expect(result).toContain('Degraded: shell-probe (timed out after 300ms)');
    expect(elapsed).toBeLessThan(BOUND + 5_000);
    const agent = getAllAgents().find(a => a.friendlyName === 'win-hang');
    expect(agent?.shell).toBe('powershell5');
  });

  it('local member: a CLI version probe that never returns is bounded and reported degraded', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'njeb-local-'));
    try {
      const configExec = makeConfigAwareExec('');
      mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 0 });
      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (/claude\b.*--version/.test(cmd)) return new Promise<SSHExecResult>(() => {});
        return configExec(cmd);
      });

      const BOUND = 300;
      const started = Date.now();
      const result = await registerMember({
        friendly_name: 'local-hang', member_type: 'local', work_folder: workFolder, llm_provider: 'claude',
      } as never, { stepBoundsMs: { 'cli-version': BOUND }, skipFleetMcp: true });
      const elapsed = Date.now() - started;

      expect(result).toContain('registered successfully');
      expect(result).toContain('Degraded: cli-version (timed out after 300ms)');
      expect(result).toMatch(/cli-version did not finish within 300ms/);
      expect(elapsed).toBeLessThan(BOUND + 5_000);
      expect(getAllAgents().some(a => a.friendlyName === 'local-hang')).toBe(true);
    } finally {
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  });
});
