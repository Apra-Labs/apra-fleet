import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect fleet dir to a per-test temp directory so we operate on a real
// filesystem sandbox — writeStatusline uses real fs I/O, not mocks.
const TMP_DIR = path.join(os.tmpdir(), `fleet-statusline-test-${process.pid}`);
process.env.APRA_FLEET_DATA_DIR = TMP_DIR;

// Import AFTER setting the env var so paths.ts picks it up.
const { writeStatusline } = await import('../src/services/statusline.js');
const { addAgent, removeAgent, getAllAgents } = await import('../src/services/registry.js');

const STATUSLINE_PATH = path.join(TMP_DIR, 'statusline.txt');
const STATE_PATH = path.join(TMP_DIR, 'statusline-state.json');
const REGISTRY_PATH = path.join(TMP_DIR, 'registry.json');

function makeAgent(id: string, name: string): any {
  return {
    id,
    friendlyName: name,
    agentType: 'local',
    workFolder: '/tmp/work',
    os: 'linux',
    createdAt: '2026-01-01T00:00:00.000Z',
    icon: '🔵',
  };
}

describe('writeStatusline — #39 statusline clears after remove_member', () => {
  beforeEach(() => {
    // Fresh sandbox per test.
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('clears statusline file when last member is removed', () => {
    // 1. Register one member and mark it busy.
    addAgent(makeAgent('member-a', 'member-a'));
    writeStatusline(new Map([['member-a', 'busy']]));

    // Sanity: statusline file should now contain the busy icon for member-a.
    expect(fs.existsSync(STATUSLINE_PATH)).toBe(true);
    const before = fs.readFileSync(STATUSLINE_PATH, 'utf-8');
    expect(before).toContain('member-a');
    expect(before.trim()).not.toBe('');

    // 2. Remove the last member, then call writeStatusline (mirrors remove-member.ts).
    removeAgent('member-a');
    expect(getAllAgents()).toHaveLength(0);
    writeStatusline();

    // 3. Statusline should be effectively empty (no lingering icon under Claude input).
    expect(fs.existsSync(STATUSLINE_PATH)).toBe(true);
    const after = fs.readFileSync(STATUSLINE_PATH, 'utf-8');
    expect(after.trim()).toBe('');
    // State file should also be reset so stale "busy" doesn't come back on next write.
    const state = fs.readFileSync(STATE_PATH, 'utf-8');
    expect(JSON.parse(state)).toEqual({});
  });

  it('does not clobber statusline when a later removal leaves other agents', () => {
    addAgent(makeAgent('member-a', 'member-a'));
    addAgent(makeAgent('member-b', 'member-b'));
    writeStatusline(new Map([['member-a', 'busy'], ['member-b', 'idle']]));

    removeAgent('member-a');
    writeStatusline();

    const content = fs.readFileSync(STATUSLINE_PATH, 'utf-8');
    expect(content).toContain('member-b');
    expect(content).not.toContain('member-a');
  });
});
