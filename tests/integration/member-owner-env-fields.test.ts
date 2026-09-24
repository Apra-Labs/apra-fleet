/**
 * [test] apra-fleet-4qtu.1.2: end-to-end check of the field set added by
 * apra-fleet-4qtu.1.1 (owner, env, llmAuthExpiresAt, plus modelTiers/shell/
 * vcsTokenExpiresAt/reservedBy/unreservable emission) -- one integration
 * suite covering the full register -> update -> detail/list round trip
 * rather than extra unit cases in the four tool-level test files.
 *
 * Shared-registry constraint: tests/global-setup.ts computes ONE data dir
 * per vitest run and every worker shares registry.json -- it is never reset
 * per file, and fileParallelism:false only serializes files, it does not
 * isolate them. Every assertion below is therefore scoped to the member ids
 * THIS suite creates (looked up by id, never "the whole list" or a total
 * count); each test registers a uniquely-named/foldered member and removes
 * it in cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { registerMember } from '../../src/tools/register-member.js';
import { updateMember } from '../../src/tools/update-member.js';
import { memberDetail } from '../../src/tools/member-detail.js';
import { listMembers } from '../../src/tools/list-members.js';
import { removeAgent, getAgent } from '../../src/services/registry.js';
import type { SSHExecResult } from '../../src/types.js';

vi.mock('../../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs?: number; error?: string }>>();

vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// compose_permissions issues its own real execCommand round trips through the
// (mocked) strategy above; mocking it directly keeps this suite's focus on
// the owner/env/llmAuthExpiresAt field plumbing, not permission composition
// (already covered by tests/register-member.test.ts).
const mockComposePermissions = vi.fn(async () => '✅ mocked compose_permissions');
vi.mock('../../src/tools/compose-permissions.js', () => ({
  composePermissions: (...args: unknown[]) => mockComposePermissions(...args),
}));

vi.mock('../../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: () => '.claude/agents',
}));

function setupDefaultMocks(): void {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
    if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

// One counter per test run keeps folders/names unique across this suite's
// own tests without colliding with any other file sharing the registry.
let counter = 0;
function uniqueMember() {
  counter += 1;
  const suffix = `4qtu112-${Date.now()}-${counter}`;
  return {
    friendly_name: `owner-env-${suffix}`,
    work_folder: `/srv/${suffix}`,
  };
}

describe('Member owner/env/llmAuthExpiresAt round trip (apra-fleet-4qtu.1.2)', () => {
  const createdIds: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    mockComposePermissions.mockClear();
    mockComposePermissions.mockResolvedValue('✅ mocked compose_permissions');
  });

  afterEach(() => {
    for (const id of createdIds.splice(0)) {
      removeAgent(id);
    }
  });

  async function registerAndTrack(overrides: Record<string, unknown> = {}) {
    const { friendly_name, work_folder } = uniqueMember();
    const result = await registerMember({
      friendly_name,
      member_type: 'remote',
      host: '10.0.0.9',
      username: 'tester',
      auth_type: 'key',
      key_path: '/home/tester/.ssh/id_rsa',
      work_folder,
      llm_provider: 'claude',
      ...overrides,
    } as any);
    const idMatch = result.match(/ID:\s+([0-9a-f-]+)/);
    const id = idMatch?.[1];
    expect(id, `register_member did not report an ID -- result was: ${result}`).toBeTruthy();
    createdIds.push(id!);
    return { id: id!, result, friendly_name, work_folder };
  }

  it('(1)(2) owner and env round-trip exactly through member_detail json and list_members json, alongside the full field set', async () => {
    const { id } = await registerAndTrack({
      owner: { package: 'fleet-sprint', ref: 'sprint-42' },
      env: { MY_VAR: 'value', OTHER_VAR: 'x' },
      model_tiers: { standard: 'sonnet' },
      shell: 'gitbash',
    });
    // vcsTokenExpiresAt is set by provision_vcs_auth, not register_member --
    // patch it directly to prove list_members/member_detail plumb it through
    // once present, independent of how it got there.
    const { updateAgent } = await import('../../src/services/registry.js');
    updateAgent(id, { vcsTokenExpiresAt: '2026-12-01T00:00:00Z' });

    const detail = JSON.parse(await memberDetail({ member_id: id, format: 'json' })) as Record<string, unknown>;
    expect(detail.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-42' });
    expect(detail.env).toEqual({ MY_VAR: 'value', OTHER_VAR: 'x' });
    expect(detail.modelTiers).toEqual({ cheap: 'sonnet', standard: 'sonnet', premium: 'sonnet' });
    expect(detail.shell).toBe('gitbash');
    expect(detail.vcsTokenExpiresAt).toBe('2026-12-01T00:00:00Z');
    // Full field set present on the detail json shape (all always-emitted here
    // since every one of them was explicitly set above).
    for (const key of ['modelTiers', 'shell', 'vcsTokenExpiresAt', 'reservedBy', 'unreservable', 'owner', 'env']) {
      expect(Object.prototype.hasOwnProperty.call(detail, key), `member_detail json missing key: ${key}`).toBe(true);
    }
    // reservedBy stays string-or-null this sprint -- never becomes an object.
    expect(detail.reservedBy === null || typeof detail.reservedBy === 'string').toBe(true);

    const listJson = JSON.parse(await listMembers({ format: 'json' }));
    const listed = listJson.members.find((m: any) => m.id === id);
    expect(listed, 'registered member not found in list_members json').toBeTruthy();
    expect(listed.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-42' });
    expect(listed.env).toEqual({ MY_VAR: 'value', OTHER_VAR: 'x' });
    expect(listed.modelTiers).toEqual({ cheap: 'sonnet', standard: 'sonnet', premium: 'sonnet' });
    expect(listed.shell).toBe('gitbash');
    expect(listed.vcsTokenExpiresAt).toBe('2026-12-01T00:00:00Z');
    for (const key of ['modelTiers', 'shell', 'vcsTokenExpiresAt', 'reservedBy', 'unreservable', 'owner', 'env']) {
      expect(Object.prototype.hasOwnProperty.call(listed, key), `list_members json missing key: ${key}`).toBe(true);
    }
    expect(listed.reservedBy === null || typeof listed.reservedBy === 'string').toBe(true);
  });

  it('(3) compact text output carries an owner= chip only when owner is set, and is otherwise unchanged', async () => {
    const owned = await registerAndTrack({ owner: { package: 'fleet-sprint', ref: 'sprint-7' } });
    const ownedListCompact = await listMembers({ format: 'compact' });
    expect(ownedListCompact).toContain(`owner=fleet-sprint@sprint-7`);
    const ownedDetailCompact = await memberDetail({ member_id: owned.id, format: 'compact' });
    expect(ownedDetailCompact).toContain('owner=fleet-sprint@sprint-7');

    const bare = await registerAndTrack();
    const bareListCompact = await listMembers({ format: 'compact' });
    // The bare member's own row must carry no chip -- scope the check to its line.
    const bareLine = bareListCompact.split('\n').find((l) => l.includes(bare.friendly_name));
    expect(bareLine, 'bare member row not found in compact list output').toBeTruthy();
    expect(bareLine).not.toContain('owner=');
  });

  it('(4) an env name outside the portable pattern is rejected with an error, not silently dropped', async () => {
    const { friendly_name, work_folder } = uniqueMember();
    const result = await registerMember({
      friendly_name,
      member_type: 'remote',
      host: '10.0.0.9',
      username: 'tester',
      auth_type: 'key',
      key_path: '/home/tester/.ssh/id_rsa',
      work_folder,
      llm_provider: 'claude',
      env: { 'not valid!': 'value' },
    } as any);

    expect(result).toContain('❌');
    expect(result).not.toContain('registered successfully');
    // Never silently registered without the env -- the member must not exist at all.
    const list = JSON.parse(await listMembers({ format: 'json' }));
    expect(list.members.find((m: any) => m.name === friendly_name)).toBeUndefined();
  });

  it('(4) an oversized env map is rejected', async () => {
    const { friendly_name, work_folder } = uniqueMember();
    const bigEnv: Record<string, string> = {};
    for (let i = 0; i < 50; i++) bigEnv[`VAR_${i}`] = 'x'.repeat(100);

    const result = await registerMember({
      friendly_name,
      member_type: 'remote',
      host: '10.0.0.9',
      username: 'tester',
      auth_type: 'key',
      key_path: '/home/tester/.ssh/id_rsa',
      work_folder,
      llm_provider: 'claude',
      env: bigEnv,
    } as any);

    expect(result).toContain('❌');
    expect(result).not.toContain('registered successfully');
  });

  it('(5) update_member cannot set owner on a member held by a reservation (reservedBy set)', async () => {
    const { id } = await registerAndTrack();
    // Simulate a live reservation directly on the registry record -- the
    // reservation lifecycle itself (member_reservation) is out of scope here.
    const held = getAgent(id);
    expect(held).toBeDefined();
    held!.reservedBy = 'sprint-99';
    // updateAgent merges partials; write straight through registry helpers
    // used elsewhere in this file to keep this test self-contained.
    const { updateAgent } = await import('../../src/services/registry.js');
    updateAgent(id, { reservedBy: 'sprint-99' });

    const result = await updateMember({
      member_id: id,
      owner: { package: 'fleet-sprint', ref: 'sprint-1' },
    });

    expect(result).toContain('❌');
    expect(result.toLowerCase()).toContain('held');
    expect(getAgent(id)?.owner).toBeUndefined();
  });

  it('(6) llmAuthExpiresAt round-trips through register and detail', async () => {
    const { id } = await registerAndTrack({ llm_auth_expires_at: '2027-06-01T00:00:00Z' });

    const detail = JSON.parse(await memberDetail({ member_id: id, format: 'json' })) as Record<string, unknown>;
    expect(detail.llmAuthExpiresAt).toBe('2027-06-01T00:00:00Z');
  });

  it('(7) the member record carries no project, repo or group field', async () => {
    const { id } = await registerAndTrack({
      owner: { package: 'fleet-sprint', ref: 'sprint-1' },
      env: { MY_VAR: 'value' },
    });

    const stored = getAgent(id) as unknown as Record<string, unknown>;
    for (const forbidden of ['project', 'repo', 'group']) {
      expect(Object.prototype.hasOwnProperty.call(stored, forbidden), `Agent record unexpectedly carries a "${forbidden}" field`).toBe(false);
    }

    const detail = JSON.parse(await memberDetail({ member_id: id, format: 'json' })) as Record<string, unknown>;
    for (const forbidden of ['project', 'repo', 'group']) {
      expect(Object.prototype.hasOwnProperty.call(detail, forbidden), `member_detail json unexpectedly carries a "${forbidden}" field`).toBe(false);
    }
  });

  it('(7) the stored env is not read by any dispatch or provider command path this sprint', () => {
    // Static guard: the carve-out is that Agent.env exists as a plain field
    // only -- DQ-23's dispatch-injection wiring is a later (S9) sprint. Scan
    // the actual dispatch entry points and provider command builders for any
    // reference to it (distinct from Node's own process.env) so a future
    // accidental wire-up fails this test rather than silently landing.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const filesToScan = [
      path.join(repoRoot, 'src', 'tools', 'execute-prompt.ts'),
      path.join(repoRoot, 'src', 'tools', 'execute-command.ts'),
      ...fs.readdirSync(path.join(repoRoot, 'src', 'providers'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(repoRoot, 'src', 'providers', f)),
    ];

    const offenders: string[] = [];
    for (const file of filesToScan) {
      const src = fs.readFileSync(file, 'utf8');
      if (/\b(agent|member|tempAgent|existing|updated)\.env\b/.test(src)) {
        offenders.push(file);
      }
    }

    expect(offenders, `Agent.env must not be read by any dispatch/provider path this sprint: ${offenders.join(', ')}`).toEqual([]);
  });
});
