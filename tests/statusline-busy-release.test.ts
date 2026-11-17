import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { FLEET_DIR } from '../src/paths.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { sendFiles } from '../src/tools/send-files.js';
import { receiveFiles } from '../src/tools/receive-files.js';
import { stopPrompt } from '../src/tools/stop-prompt.js';
import { buildFleetSnapshot } from '../src/tools/fleet-snapshot.js';
import {
  readMemberStatus, writeStatusline, reconcileStaleBusy, isOrphanedBusy,
} from '../src/services/statusline.js';
import { markBusy } from '../src/services/member-busy.js';
import type { SSHExecResult } from '../src/types.js';

// Busy must be released on every exit path: a success path that only
// re-rendered (bare writeStatusline()) left members busy forever.

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTransferFiles = vi.fn();
const mockReceiveFiles = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    transferFiles: mockTransferFiles,
    receiveFiles: mockReceiveFiles,
    testConnection: vi.fn(),
    close: vi.fn(),
  }),
}));

const STATE_PATH = path.join(FLEET_DIR, 'statusline-state.json');
const OWNERS_PATH = path.join(FLEET_DIR, 'statusline-owners.json');

function resetStatusFiles(): void {
  for (const p of [STATE_PATH, OWNERS_PATH]) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid as number;
}

function snapshotStatus(id: string): string | undefined {
  return buildFleetSnapshot().members.find(m => m.id === id)?.status;
}

describe('busy is released after every tool exit path', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    resetStatusFiles();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-busy-release-'));
  });

  afterEach(() => {
    resetStatusFiles();
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sync execute_command success -> idle (status file and fleet_snapshot)', async () => {
    const m = makeTestAgent();
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
    await executeCommand({ member_id: m.id, command: 'echo ok', timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('idle');
    expect(snapshotStatus(m.id)).toBe('idle');
  });

  it('sync execute_command non-zero exit -> idle', async () => {
    const m = makeTestAgent();
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'boom', code: 2 });
    await executeCommand({ member_id: m.id, command: 'false', timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('idle');
  });

  it('execute_command is busy while running', async () => {
    const m = makeTestAgent();
    addAgent(m);
    let seen = '';
    mockExecCommand.mockImplementation(async () => {
      seen = readMemberStatus(m.id);
      return { stdout: '', stderr: '', code: 0 };
    });
    await executeCommand({ member_id: m.id, command: 'true', timeout_s: 5 });
    expect(seen).toBe('busy');
    expect(readMemberStatus(m.id)).toBe('idle');
  });

  it('long_running execute_command launch success -> idle', async () => {
    const m = makeTestAgent({ os: 'linux' });
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '12345\n', stderr: '', code: 0 });
    const r = await executeCommand({ member_id: m.id, command: 'sleep 100', long_running: true, timeout_s: 5 });
    expect(String(typeof r === 'string' ? r : r.text)).toContain('Task launched');
    expect(readMemberStatus(m.id)).toBe('idle');
    expect(snapshotStatus(m.id)).toBe('idle');
  });

  it('execute_command on an llmProvider none member -> idle', async () => {
    const m = makeTestAgent({ llmProvider: 'none' } as any);
    addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    await executeCommand({ member_id: m.id, command: 'true', timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('idle');
  });

  it('execute_command connection failure still writes offline (not clobbered by idle)', async () => {
    const m = makeTestAgent();
    addAgent(m);
    mockExecCommand.mockRejectedValue(new Error('ssh: connect ECONNREFUSED'));
    await executeCommand({ member_id: m.id, command: 'true', timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('offline');
  });

  it('execute_command non-connection failure writes idle', async () => {
    const m = makeTestAgent();
    addAgent(m);
    mockExecCommand.mockRejectedValue(new Error('something else broke'));
    await executeCommand({ member_id: m.id, command: 'true', timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('idle');
  });

  it('long_running launch connection failure still writes offline', async () => {
    const m = makeTestAgent({ os: 'linux' });
    addAgent(m);
    mockExecCommand.mockRejectedValue(new Error('network unreachable'));
    await executeCommand({ member_id: m.id, command: 'sleep 1', long_running: true, timeout_s: 5 });
    expect(readMemberStatus(m.id)).toBe('offline');
  });

  it('send_files success -> idle; connection failure -> offline', async () => {
    const m = makeTestAgent();
    addAgent(m);
    const f = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(f, 'x');
    mockTransferFiles.mockResolvedValue({ success: [f], failed: [] });
    await sendFiles({ member_id: m.id, local_paths: [f] });
    expect(readMemberStatus(m.id)).toBe('idle');
    expect(snapshotStatus(m.id)).toBe('idle');

    mockTransferFiles.mockRejectedValue(new Error('ssh handshake failed'));
    await sendFiles({ member_id: m.id, local_paths: [f] });
    expect(readMemberStatus(m.id)).toBe('offline');
  });

  it('receive_files success -> idle; connection failure -> offline', async () => {
    const m = makeTestAgent({ workFolder: '/home/testuser/project' });
    addAgent(m);
    mockReceiveFiles.mockResolvedValue({ success: ['out.txt'], failed: [] });
    await receiveFiles({ member_id: m.id, remote_paths: ['out.txt'], local_dest_dir: tmpDir });
    expect(readMemberStatus(m.id)).toBe('idle');
    expect(snapshotStatus(m.id)).toBe('idle');

    mockReceiveFiles.mockRejectedValue(new Error('connection timed out'));
    await receiveFiles({ member_id: m.id, remote_paths: ['out.txt'], local_dest_dir: tmpDir });
    expect(readMemberStatus(m.id)).toBe('offline');
  });

  it('regression: N sequential execute_command calls across members leave 0 busy', async () => {
    const members = Array.from({ length: 4 }, (_, i) => makeTestAgent({ friendlyName: `m${i}` }));
    for (const m of members) addAgent(m);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    for (let round = 0; round < 3; round++) {
      for (const m of members) {
        await executeCommand({ member_id: m.id, command: 'dolt status', timeout_s: 5 });
      }
    }
    const busy = buildFleetSnapshot().members.filter(s => s.status === 'busy');
    expect(busy).toEqual([]);
  });

  it('stop_prompt clears a stored busy', async () => {
    const m = makeTestAgent();
    addAgent(m);
    writeStatusline(new Map([[m.id, 'busy']]));
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    await stopPrompt({ member_id: m.id });
    expect(readMemberStatus(m.id)).toBe('idle');
  });
});

describe('markBusy', () => {
  beforeEach(() => { backupAndResetRegistry(); resetStatusFiles(); });
  afterEach(() => { resetStatusFiles(); restoreRegistry(); });

  it('releases in finally when the body throws', () => {
    const m = makeTestAgent();
    addAgent(m);
    const run = () => {
      const release = markBusy(m.id);
      try {
        expect(readMemberStatus(m.id)).toBe('busy');
        throw new Error('boom');
      } finally {
        release();
      }
    };
    expect(run).toThrow('boom');
    expect(readMemberStatus(m.id)).toBe('idle');
  });

  it('first release wins: a later bare release does not clobber offline', () => {
    const m = makeTestAgent();
    addAgent(m);
    const release = markBusy(m.id);
    release('offline');
    release();
    expect(readMemberStatus(m.id)).toBe('offline');
  });
});

describe('stale busy from a dead server process', () => {
  beforeEach(() => { backupAndResetRegistry(); resetStatusFiles(); });
  afterEach(() => { resetStatusFiles(); restoreRegistry(); });

  it('records this process as the busy owner and drops it on release', () => {
    const m = makeTestAgent();
    addAgent(m);
    writeStatusline(new Map([[m.id, 'busy']]));
    expect(JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf-8'))[m.id]).toBe(process.pid);
    writeStatusline(new Map([[m.id, 'idle']]));
    expect(JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf-8'))[m.id]).toBeUndefined();
  });

  it('fleet_snapshot reports idle for a busy whose owner pid is dead', () => {
    const m = makeTestAgent();
    addAgent(m);
    fs.writeFileSync(STATE_PATH, JSON.stringify({ [m.id]: 'busy(01:00)' }));
    fs.writeFileSync(OWNERS_PATH, JSON.stringify({ [m.id]: deadPid() }));
    expect(isOrphanedBusy(m.id)).toBe(true);
    expect(snapshotStatus(m.id)).toBe('idle');
  });

  it('fleet_snapshot keeps busy owned by a live process or with no recorded owner', () => {
    const live = makeTestAgent();
    const legacy = makeTestAgent();
    addAgent(live);
    addAgent(legacy);
    fs.writeFileSync(STATE_PATH, JSON.stringify({ [live.id]: 'busy', [legacy.id]: 'busy' }));
    fs.writeFileSync(OWNERS_PATH, JSON.stringify({ [live.id]: process.ppid }));
    expect(snapshotStatus(live.id)).toBe('busy');
    expect(snapshotStatus(legacy.id)).toBe('busy');
  });

  it('startup reconcile resets busy with dead/missing/own-pid owner, keeps live foreign owner', () => {
    const dead = makeTestAgent();
    const missing = makeTestAgent();
    const own = makeTestAgent();
    const live = makeTestAgent();
    const offline = makeTestAgent();
    for (const a of [dead, missing, own, live, offline]) addAgent(a);
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      [dead.id]: 'busy', [missing.id]: 'busy(00:30)', [own.id]: 'busy', [live.id]: 'busy', [offline.id]: 'offline',
    }));
    fs.writeFileSync(OWNERS_PATH, JSON.stringify({
      [dead.id]: deadPid(), [own.id]: process.pid, [live.id]: process.ppid,
    }));
    const cleared = reconcileStaleBusy();
    expect(new Set(cleared)).toEqual(new Set([dead.id, missing.id, own.id]));
    expect(readMemberStatus(dead.id)).toBe('idle');
    expect(readMemberStatus(missing.id)).toBe('idle');
    expect(readMemberStatus(own.id)).toBe('idle');
    expect(readMemberStatus(live.id)).toBe('busy');
    expect(readMemberStatus(offline.id)).toBe('offline');
  });
});
