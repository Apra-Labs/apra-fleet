import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { Agent, SSHExecResult } from '../src/types.js';

// GitHub #563 review: when timeout_s >= max_total_s the exec-level inactivity
// timer and the max-total timer come due together and the inactivity one
// (armed first) wins the tie. Driven here with REAL timers against the REAL
// LocalStrategy running a silent, harmless node child (never a provider CLI):
// the dispatch must still come back as the typed max_total_time error.

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const { realExec } = vi.hoisted(() => ({
  realExec: { fn: null as null | ((cmd: string, t?: number, m?: number, p?: (pid: number) => void, s?: AbortSignal) => Promise<SSHExecResult>) },
}));

vi.mock('../src/services/strategy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/strategy.js')>();
  return {
    ...actual,
    getStrategy: () => ({
      execCommand: (cmd: string, t?: number, m?: number, onPid?: (pid: number) => void, signal?: AbortSignal) =>
        // The main dispatch passes onPidCaptured; setup/cleanup calls do not.
        onPid ? realExec.fn!(cmd, t, m, onPid, signal) : Promise.resolve({ stdout: '', stderr: '', code: 0 }),
      testConnection: vi.fn(),
      transferFiles: vi.fn(),
      close: vi.fn(),
    }),
  };
});

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

const { cloudHang } = vi.hoisted(() => ({ cloudHang: { on: false } }));
vi.mock('../src/services/cloud/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/cloud/lifecycle.js')>();
  return {
    ...actual,
    ensureCloudReady: (agent: Agent) => (cloudHang.on ? new Promise<Agent>(() => {}) : actual.ensureCloudReady(agent)),
  };
});

import { executePrompt } from '../src/tools/execute-prompt.js';

describe('execute_prompt max_total_s with real timers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    backupAndResetRegistry();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-maxtotal-real-'));
    const actual = await vi.importActual<typeof import('../src/services/strategy.js')>('../src/services/strategy.js');
    const sleeper: Agent = makeTestLocalAgent({ friendlyName: 'sleeper', workFolder: tmpDir });
    const local = actual.getStrategy(sleeper);
    // Ignore the provider command: run a silent node child for 30s instead.
    const silent = 'node -e "setTimeout(function () {}, 30000)"';
    realExec.fn = (_cmd, t, m, p, s) => local.execCommand(silent, t, m, p, s);
  });

  afterEach(() => {
    cloudHang.on = false;
    restoreRegistry();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* child may still hold it briefly */ }
  });

  it('timeout_s == max_total_s: the tie-winning inactivity kill is reported as max_total_time, within max_total_s + 30s', async () => {
    const member = makeTestAgent({ friendlyName: 'tie' });
    addAgent(member);
    const start = Date.now();
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 3, max_total_s: 3 });
    const elapsed = Date.now() - start;
    expect((result as any).structuredContent).toMatchObject({ isError: true, reason: 'max_total_time' });
    // The agent ran: not marked as a setup-time (nothing dispatched) failure.
    expect((result as any).structuredContent.dispatched).toBeUndefined();
    expect(elapsed).toBeLessThan(3000 + 30_000);
  }, 30_000);

  it('timeout_s < max_total_s: a genuine inactivity kill stays a dispatch failure (not max_total_time)', async () => {
    // codex arms the exec timer from timeout_s (inactivity_timeout), so there is no tie.
    const member = makeTestAgent({ friendlyName: 'inactive', llmProvider: 'codex' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 1, max_total_s: 20 });
    expect((result as any).structuredContent?.reason).not.toBe('max_total_time');
  }, 60_000);

  it('a cloud start slower than max_total_s returns max_total_time instead of outliving the client deadline', async () => {
    cloudHang.on = true;
    const member = makeTestAgent({ friendlyName: 'cold-cloud' });
    addAgent(member);
    const start = Date.now();
    // max_total_s 4 (cloud budget ~3.6s) rather than 2: a 1.8s budget left only
    // tens of ms of scheduling slack under a loaded full-suite run.
    const maxTotalS = 4;
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: maxTotalS, max_total_s: maxTotalS });
    const elapsed = Date.now() - start;
    // Nothing was dispatched: callers must not publish post-dispatch work.
    // Asserting on the whole result so a failure prints what actually came back.
    expect(result).toMatchObject({ structuredContent: { isError: true, reason: 'max_total_time', dispatched: false } });
    // It waited for the budget (did not return early) and came back before the
    // client's own deadline (max_total_s + grace), with generous load slack.
    expect(elapsed).toBeGreaterThanOrEqual(maxTotalS * 1000 * 0.5);
    expect(elapsed).toBeLessThan(maxTotalS * 1000 + 5000);
  }, 30_000);
});
