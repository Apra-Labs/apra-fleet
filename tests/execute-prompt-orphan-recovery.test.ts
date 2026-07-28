import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import type { SSHExecResult } from '../src/types.js';

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
