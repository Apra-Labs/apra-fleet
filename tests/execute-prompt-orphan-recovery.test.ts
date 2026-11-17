import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import { isRemoteProcessAlive, readDurableOutput } from '../src/services/orphan-recovery.js';
import type { SSHExecResult } from '../src/types.js';

/**
 * monitor-task.ts / remove-member.ts wrap Windows-bound scripts as
 * `powershell -EncodedCommand <base64 utf16le>` (wrapPowerShellEncoded);
 * orphan-recovery.ts's Windows branch does too. Decode back to the
 * underlying script so assertions can inspect it -- mirrors the helper in
 * tests/tools-windows-command-safety.test.ts.
 */
function decodeIfEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  if (!m) return cmd;
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

/**
 * apra-fleet-6z8.1 -- lease-of-life recovery for a FALSE-ALARM empty_response.
 *
 * ssh.ts substitutes exit code 0 when the exec channel closes without ever
 * receiving an 'exit' event, so "exit 0 + empty stdout" is also exactly what a
 * torn-down channel over a still-running turn looks like (live evidence
 * 2026-07-27: pid 89858 alive 2+ minutes after the channel resolved, which then
 * produced a duplicate concurrent Planner dispatch). These tests pin the
 * PID-liveness gate that tells the two apart.
 */

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

const CAPTURED_PID = 89858;

interface Recorder {
  cmds: string[];
  livenessAnswers: string[];
  durableOutput: string | null;
}

/**
 * Routes the mocked exec by command shape rather than by call index, so the
 * recovery path's extra probes cannot silently shift a positional queue.
 */
function installExecRouter(rec: Recorder): void {
  mockExecCommand.mockImplementation(
    async (cmd: string, _t?: number, _m?: number, onPid?: (pid: number) => void): Promise<SSHExecResult> => {
      rec.cmds.push(cmd);
      if (/^kill -0 /.test(cmd)) {
        const answer = rec.livenessAnswers.length > 1 ? rec.livenessAnswers.shift()! : rec.livenessAnswers[0];
        return { stdout: `${answer}\n`, stderr: '', code: 0 };
      }
      if (/^cat "/.test(cmd)) {
        return rec.durableOutput === null
          ? { stdout: '', stderr: '', code: 1 }
          : { stdout: rec.durableOutput, stderr: '', code: 0 };
      }
      if (cmd.includes('FLEET_PID')) {
        // The dispatch itself: emit the pid, then resolve exit=0 with EMPTY
        // stdout -- the fabricated-success shape from a torn-down channel.
        onPid?.(CAPTURED_PID);
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  );
}

describe('execute_prompt orphan lease-of-life recovery (apra-fleet-6z8.1)', () => {
  let rec: Recorder;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    process.env['ORPHAN_RECOVERY_POLL_MS'] = '1';
    delete process.env['ORPHAN_RECOVERY_MAX_WAIT_MS'];
    rec = { cmds: [], livenessAnswers: ['DEAD'], durableOutput: null };
    installExecRouter(rec);
  });

  afterEach(() => {
    restoreRegistry();
    delete process.env['ORPHAN_RECOVERY_POLL_MS'];
    delete process.env['ORPHAN_RECOVERY_MAX_WAIT_MS'];
  });

  it('recovers the real result from the durable output file when the pid is still alive', async () => {
    const member = makeTestAgent({ friendlyName: 'orphan-live', os: 'macos' });
    addAgent(member);
    // ALIVE on the first probe (the false alarm), then the process finishes.
    rec.livenessAnswers = ['ALIVE', 'DEAD'];
    rec.durableOutput = JSON.stringify({ result: 'the real planner answer', session_id: 'sess-recovered' });

    const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('the real planner answer');
    const structured = (result as any).structuredContent;
    expect(structured.isError).toBeUndefined();
    expect(structured.response).toContain('the real planner answer');
    // Liveness was probed over a FRESH exec, not the dead original channel.
    expect(rec.cmds.some(c => c === `kill -0 ${CAPTURED_PID} 2>/dev/null && echo ALIVE || echo DEAD`)).toBe(true);
    // The durable per-invocation file was read back.
    expect(rec.cmds.some(c => /^cat ".*\.fleet-out-.*\.json"/.test(c))).toBe(true);
    // No second LLM dispatch was spawned -- exactly one FLEET_PID invocation.
    expect(rec.cmds.filter(c => c.includes('FLEET_PID')).length).toBe(1);
  });

  it('returns orphan_recovery_timeout (never empty_response) and kills the pid when the wait cap is hit', async () => {
    const member = makeTestAgent({ friendlyName: 'orphan-stuck', os: 'macos' });
    addAgent(member);
    rec.livenessAnswers = ['ALIVE'];
    process.env['ORPHAN_RECOVERY_MAX_WAIT_MS'] = '5';

    const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });

    const structured = (result as any).structuredContent;
    expect(structured.isError).toBe(true);
    expect(structured.reason).toBe('orphan_recovery_timeout');
    expect(structured.reason).not.toBe('empty_response');
    // The wedged remote process was actually killed, not left orphaned.
    const killCmd = getOsCommands('macos').killPid(CAPTURED_PID);
    expect(rec.cmds).toContain(killCmd);
  });

  it('keeps the pre-existing empty_response behavior when the pid is confirmed dead', async () => {
    const member = makeTestAgent({ friendlyName: 'orphan-dead', os: 'macos' });
    addAgent(member);
    rec.livenessAnswers = ['DEAD'];

    const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });

    const structured = (result as any).structuredContent;
    expect(structured.isError).toBe(true);
    expect(structured.reason).toBe('empty_response');
    // No durable-file read on the dead path -- behavior is unchanged.
    expect(rec.cmds.some(c => /^cat ".*\.fleet-out-/.test(c))).toBe(false);
  });

  it('falls through to empty_response when the process exits with an empty durable file', async () => {
    const member = makeTestAgent({ friendlyName: 'orphan-empty', os: 'macos' });
    addAgent(member);
    rec.livenessAnswers = ['ALIVE', 'DEAD'];
    rec.durableOutput = null;

    const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });

    expect((result as any).structuredContent.reason).toBe('empty_response');
  });

  it('cleans up the durable output file in the same round trip as the prompt file', async () => {
    const member = makeTestAgent({ friendlyName: 'orphan-cleanup', os: 'macos' });
    addAgent(member);
    rec.livenessAnswers = ['DEAD'];

    await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });

    const rmCmd = rec.cmds.find(c => c.includes('rm -f'));
    expect(rmCmd).toBeDefined();
    expect(rmCmd).toContain('.fleet-out-');
  });
});

describe('durable stdout mirror companion change (apra-fleet-6z8.1)', () => {
  const macos = getOsCommands('macos');
  const claudeProvider = getProvider('claude');

  it('tees the CLI stdout to a per-invocation durable file when an invocation id is present', () => {
    const cmd = macos.buildAgentPromptCommand(claudeProvider, {
      folder: '/home/testuser/project',
      promptFile: '.fleet-task.md',
      inv: 'jhx4x',
    });
    expect(cmd).toContain('| tee "/tmp/.fleet-out-jhx4x.json"');
    // The CLI's own exit code stays authoritative despite the pipe.
    expect(cmd).toContain('set -o pipefail');
    expect(cmd).toContain('FLEET_PID:');
  });

  it('leaves the command unchanged when no invocation id is supplied', () => {
    const cmd = macos.buildAgentPromptCommand(claudeProvider, {
      folder: '/home/testuser/project',
      promptFile: '.fleet-task.md',
    });
    expect(cmd).not.toContain('tee');
  });
});

/**
 * Windows-member OS-branching for orphan-recovery.ts's pid-alive and durable
 * file-read probes. Before this fix, isRemoteProcessAlive/readDurableOutput
 * always dispatched POSIX `kill -0`/`cat` regardless of the member's OS --
 * on a Windows member `kill -0` never emits ALIVE, so a genuinely-live
 * session's lock got wrongly treated as reclaimable (findDeadLockPid in
 * execute-prompt.ts). These pin the Windows branch to a valid PowerShell
 * command using the same Get-Process/Get-Content idiom monitor-task.ts
 * already uses, and confirm the POSIX branch stays byte-identical.
 */
describe('orphan-recovery.ts OS-branched probe commands', () => {
  it('isRemoteProcessAlive dispatches a POSIX kill -0 for a linux/macos member (unchanged)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ALIVE\n', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    await isRemoteProcessAlive(strategy, 4242, 'linux');

    expect(exec).toHaveBeenCalledWith('kill -0 4242 2>/dev/null && echo ALIVE || echo DEAD', expect.any(Number));
  });

  it('isRemoteProcessAlive dispatches valid PowerShell (Get-Process, no POSIX tokens) for a windows member', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ALIVE\n', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    const alive = await isRemoteProcessAlive(strategy, 4242, 'windows');

    expect(alive).toBe(true);
    const raw = exec.mock.calls[0][0] as string;
    const decoded = decodeIfEncoded(raw);
    expect(raw).not.toBe(decoded); // must be -EncodedCommand wrapped
    expect(decoded).toContain('Get-Process -Id 4242 -ErrorAction SilentlyContinue');
    expect(decoded).not.toContain('kill -0');
    expect(decoded).not.toContain('2>/dev/null');
  });

  it('isRemoteProcessAlive reports DEAD from the windows branch when Get-Process finds nothing', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'DEAD\n', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    const alive = await isRemoteProcessAlive(strategy, 4242, 'windows');

    expect(alive).toBe(false);
  });

  it('readDurableOutput dispatches a POSIX cat for a linux/macos member (unchanged)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'the output', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    await readDurableOutput(strategy, '/tmp/.fleet-out-abc.json', 'linux');

    expect(exec).toHaveBeenCalledWith('cat "/tmp/.fleet-out-abc.json" 2>/dev/null', expect.any(Number));
  });

  it('readDurableOutput dispatches valid PowerShell (Get-Content, no POSIX tokens) for a windows member', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'the output', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    const out = await readDurableOutput(strategy, 'C:\\Users\\fleet\\.fleet-out-abc.json', 'windows');

    expect(out).toBe('the output');
    const raw = exec.mock.calls[0][0] as string;
    const decoded = decodeIfEncoded(raw);
    expect(raw).not.toBe(decoded);
    expect(decoded).toContain('Get-Content -Path "C:\\Users\\fleet\\.fleet-out-abc.json" -Raw');
    expect(decoded).not.toContain('cat "');
    expect(decoded).not.toContain('2>/dev/null');
  });

  it('defaults to the POSIX branch when os is omitted (back-compat)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ALIVE\n', stderr: '', code: 0 });
    const strategy = { execCommand: exec } as any;

    await isRemoteProcessAlive(strategy, 99, undefined as any);

    expect(exec.mock.calls[0][0]).toBe('kill -0 99 2>/dev/null && echo ALIVE || echo DEAD');
  });
});
