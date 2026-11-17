/**
 * execute_prompt integration: a stale project-level doer.md on the member must
 * either be quarantined (untracked) with the dispatch proceeding, or be
 * reported in the dispatch result (tracked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { shadowCheckCache } from '../src/services/agent-shadow.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const OK_RESPONSE: SSHExecResult = { stdout: JSON.stringify({ result: 'ok', session_id: 'sess-ok' }), stderr: '', code: 0 };
let probeStdout = '';
const execCalls: string[] = [];
const mockExecCommand = vi.fn(async (cmd: string): Promise<SSHExecResult> => {
  execCalls.push(cmd);
  if (cmd.includes('FLEETSHADOW_GIT')) return { stdout: probeStdout, stderr: '', code: 0 };
  if (cmd.includes('FLEETQUARANTINE_DONE')) {
    const moved = [...cmd.matchAll(/FLEETMOVED\\t%s\\n' '([^']+)'/g)].map(m => `FLEETMOVED\t${m[1]}\n`).join('');
    return { stdout: `${moved}FLEETQUARANTINE_DONE\n`, stderr: '', code: 0 };
  }
  if (cmd.includes('"$HOME"')) return { stdout: '/home/testuser', stderr: '', code: 0 };
  return OK_RESPONSE;
});
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn(), transferFiles: vi.fn(), close: vi.fn() }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: () => '.claude/agents',
  loadCanonicalAgentSet: () => [
    { relPath: 'doer.md', content: '---\nname: doer\n---\n', sha256: 'x' },
    { relPath: 'reviewer.md', content: '---\nname: reviewer\n---\n', sha256: 'y' },
  ],
}));

describe('execute_prompt: project-level agent shadow check', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    provisionedRemoteAgents.clear();
    shadowCheckCache.clear();
    execCalls.length = 0;
  });
  afterEach(() => restoreRegistry());

  it('quarantines an untracked stale doer.md and the dispatch proceeds', async () => {
    probeStdout = 'FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tU\tdoer.md\tdoer\nFLEETSHADOW_DONE\n';
    const member = makeTestAgent({ friendlyName: 'shadow-untracked', os: 'linux' });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    const text = resultText(result);

    expect(text).toContain('ok');
    const q = execCalls.find(c => c.includes('FLEETQUARANTINE_DONE'));
    expect(q).toBeDefined();
    expect(q).toContain("mv -f -- '/home/testuser/project/.claude/agents/doer.md' '/home/testuser/project/.claude/agents-shadowed-by-fleet/");
    expect(text).toContain('[WARN] Quarantined 1 untracked project-level agent file(s)');
    // The quarantine must run before the LLM dispatch.
    const qIdx = execCalls.findIndex(c => c.includes('FLEETQUARANTINE_DONE'));
    // First dispatch-side command: the prompt-file write that precedes the CLI run.
    const dispatchIdx = execCalls.findIndex(c => c.includes('.fleet-task.md'));
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(qIdx).toBeLessThan(dispatchIdx);

    // Second dispatch: cached, no re-probe, no repeat of the one-shot notice.
    execCalls.length = 0;
    const second = resultText(await executePrompt({ member_id: member.id, prompt: 'again', resume: false, timeout_s: 5 }));
    expect(execCalls.some(c => c.includes('FLEETSHADOW_GIT'))).toBe(false);
    expect(second).not.toContain('Quarantined');
  });

  it('reports a tracked shadow in the result on every dispatch and never moves it', async () => {
    probeStdout = 'FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tT\tdoer.md\tdoer\nFLEETSHADOW_DONE\n';
    const member = makeTestAgent({ friendlyName: 'shadow-tracked', os: 'linux' });
    addAgent(member);

    const first = resultText(await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 }));
    const second = resultText(await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 }));

    for (const text of [first, second]) {
      expect(text).toContain('ok');
      expect(text).toContain('[WARN] Project-level agent file(s) on "shadow-tracked" shadow fleet\'s managed role prompts and are tracked in git');
      expect(text).toContain('doer.md');
    }
    expect(execCalls.some(c => c.includes('FLEETQUARANTINE_DONE'))).toBe(false);
    expect(execCalls.filter(c => c.includes('FLEETSHADOW_GIT'))).toHaveLength(1);
  });

  it('a probe failure warns but never blocks the dispatch', async () => {
    probeStdout = 'garbage';
    const member = makeTestAgent({ friendlyName: 'shadow-probe-fail', os: 'linux' });
    addAgent(member);
    const text = resultText(await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 }));
    expect(text).toContain('ok');
    expect(text).toContain('[WARN] Could not check');
  });
});
