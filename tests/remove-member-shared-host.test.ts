// remove_member must not strip credentials another member on the same host
// and user still uses (LLM login files, shell-profile auth exports, the git
// credential helper). Every member-side command is captured by a mocked
// strategy; nothing reaches a real member, and the registry lives in the
// throwaway test data dir (tests/setup.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { getOsCommands } from '../src/os/index.js';
import { unsetEnvSedExpr, FLEET_ENV_MARKER } from '../src/os/os-commands.js';
import { getProvider } from '../src/providers/index.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRealBash } from './helpers/real-bash.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();
const mockRevokeGithub = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: () => 'idle',
}));
vi.mock('../src/services/credential-cleanup.js', () => ({
  cancelCredentialCleanup: vi.fn(),
}));
vi.mock('../src/services/vcs/github.js', () => ({
  githubProvider: { revoke: (...args: any[]) => mockRevokeGithub(...args), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/bitbucket.js', () => ({
  bitbucketProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/azure-devops.js', () => ({
  azureDevOpsProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/known-hosts.js', () => ({ removeKnownHost: vi.fn() }));

import { removeMember } from '../src/tools/remove-member.js';

const sent = (): string[] => mockExecCommand.mock.calls.map(c => c[0]);

/** Every credential-cleanup command remove_member could send for this member. */
function credentialCommands(agent: Agent): string[] {
  const cmds = getOsCommands(agent.os ?? 'linux', agent.shell);
  const provider = getProvider(agent.llmProvider);
  const out: string[] = [];
  for (const f of provider.oauthCredentialFiles() ?? []) out.push(cmds.credentialFileRemove(f.remotePath));
  const vars = new Set([provider.authEnvVar, ...(provider.authEnvVarNames?.() ?? [])].filter(Boolean));
  for (const v of vars) out.push(...cmds.unsetEnv(v).filter(c => !c.startsWith('unset ')));
  return out;
}

/** A delivery record covering every credential file and auth var of the provider. */
function fullRecord(llmProvider?: Agent['llmProvider']): NonNullable<Agent['llmAuthDelivered']> {
  const provider = getProvider(llmProvider);
  return {
    files: (provider.oauthCredentialFiles() ?? []).map(f => f.remotePath),
    envVars: [...new Set([provider.authEnvVar, ...(provider.authEnvVarNames?.() ?? [])].filter(Boolean))],
  };
}

describe('removeMember - host+user sharer leaves credentials in place', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockRevokeGithub.mockResolvedValue({ success: true, message: 'revoked' });
  });
  afterEach(() => restoreRegistry());

  it('two remote members on one host+user: no credential remove, unset or VCS revoke; result names the sharer', async () => {
    const member = makeTestAgent({ friendlyName: 'throwaway', os: 'linux', host: 'build.example', username: 'ci', vcsProvider: 'github', llmAuthDelivered: fullRecord() });
    const sibling = makeTestAgent({ friendlyName: 'keeper', os: 'linux', host: 'BUILD.example', username: 'ci', vcsProvider: 'github', llmAuthDelivered: fullRecord() });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('has been removed');
    const forbidden = credentialCommands(member);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const cmd of forbidden) expect(sent()).not.toContain(cmd);
    expect(sent().some(c => c.includes('sed -i'))).toBe(false);
    expect(mockRevokeGithub).not.toHaveBeenCalled();
    expect(result).toContain(`"keeper" (${sibling.id})`);
    expect(result).toContain('left in place');
  });

  it('host+user sharer: no label of a multi-label member is revoked, and the note names every label', async () => {
    const member = makeTestAgent({
      friendlyName: 'two-labels', os: 'linux', host: 'build.example', username: 'ci', vcsProvider: 'github',
      vcsCredentials: {
        github: { provider: 'github', scopeUrl: 'https://github.com' },
        'github-issues': { provider: 'github', scopeUrl: 'https://github.com' },
      },
    });
    const sibling = makeTestAgent({ friendlyName: 'keeper', os: 'linux', host: 'build.example', username: 'ci' });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    expect(mockRevokeGithub).not.toHaveBeenCalled();
    expect(result).toContain('(label github)');
    expect(result).toContain('(label github-issues)');
  });

  it('a single member on that host+user still gets the cleanup commands', async () => {
    const member = makeTestAgent({ friendlyName: 'solo', os: 'linux', host: 'build.example', username: 'ci', vcsProvider: 'github', llmAuthDelivered: fullRecord() });
    // Same host, different user: not a sharer.
    const other = makeTestAgent({ friendlyName: 'other-user', os: 'linux', host: 'build.example', username: 'someone-else' });
    addAgent(member);
    addAgent(other);

    const result = await removeMember({ member_id: member.id });

    for (const cmd of credentialCommands(member)) expect(sent()).toContain(cmd);
    expect(mockRevokeGithub).toHaveBeenCalledOnce();
    expect(result).not.toContain('left in place');
  });

  it('POSIX member: unsets with the marked-only form and notes that unmarked exports may remain', async () => {
    const member = makeTestAgent({ friendlyName: 'posix-solo', os: 'linux', llmAuthDelivered: fullRecord() });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    const markedOnly = `sed -i '${unsetEnvSedExpr('ANTHROPIC_API_KEY')}' ~/.bashrc 2>/dev/null || true`;
    expect(sent()).toContain(markedOnly);
    expect(sent().some(c => c.includes(unsetEnvSedExpr('ANTHROPIC_API_KEY', { all: true })))).toBe(false);
    expect(result).toContain('unmarked export line');
    expect(result).toContain('ANTHROPIC_API_KEY');
  });

  it('Windows PowerShell member: no unmarked-export note (User env vars carry no marker)', async () => {
    const member = makeTestAgent({ friendlyName: 'ps-solo', os: 'windows', workFolder: 'C:\\work', llmAuthDelivered: fullRecord() });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    expect(result).not.toContain('unmarked export line');
  });

  it('treats localhost and 127.0.0.1 as the same host', async () => {
    const member = makeTestAgent({ friendlyName: 'loop-a', os: 'linux', host: 'localhost', username: 'ci' });
    const sibling = makeTestAgent({ friendlyName: 'loop-b', os: 'linux', host: '127.0.0.1', username: 'ci' });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    for (const cmd of credentialCommands(member)) expect(sent()).not.toContain(cmd);
    expect(result).toContain('"loop-b"');
  });

  it('a local member running as the same user counts as a sharer of a loopback remote', async () => {
    const local = makeTestLocalAgent({ friendlyName: 'local-me' });
    const user = (await import('node:os')).userInfo().username;
    const member = makeTestAgent({ friendlyName: 'loop-remote', os: 'linux', host: '::1', username: user });
    addAgent(local);
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    for (const cmd of credentialCommands(member)) expect(sent()).not.toContain(cmd);
    expect(result).toContain('"local-me"');
  });
});

describe('removeMember - removes only LLM credentials the fleet recorded delivering', () => {
  const decode = (cmd: string): string => {
    const m = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(cmd);
    return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
  };

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });
  afterEach(() => restoreRegistry());

  it('no delivery record: no credential file removal, no unset, and the result lists what was left', async () => {
    const member = makeTestAgent({ friendlyName: 'owner-login', os: 'linux' });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    for (const cmd of credentialCommands(member)) expect(sent()).not.toContain(cmd);
    expect(sent().some(c => c.startsWith('sed -i') || c.startsWith('unset '))).toBe(false);
    expect(result).toContain('No record that apra-fleet delivered LLM credentials');
    expect(result).toContain('~/.claude/.credentials.json');
    expect(result).toContain('ANTHROPIC_API_KEY');
  });

  it('with a record: removes exactly the recorded file and var, nothing else', async () => {
    const member = makeTestAgent({
      friendlyName: 'recorded', os: 'linux',
      llmAuthDelivered: { files: ['~/.claude/.credentials.json'], envVars: ['CLAUDE_CODE_OAUTH_TOKEN'] },
    });
    addAgent(member);
    const cmds = getOsCommands('linux');

    const result = await removeMember({ member_id: member.id });

    const credSent = sent().filter(c => c.startsWith('rm -f') || c.startsWith('sed -i') || c.startsWith('unset '));
    expect(credSent.sort()).toEqual([
      cmds.credentialFileRemove('~/.claude/.credentials.json'),
      ...cmds.unsetEnv('CLAUDE_CODE_OAUTH_TOKEN'),
    ].sort());
    expect(result).not.toContain('No record that apra-fleet delivered');
  });

  it('Windows PowerShell: unsetEnv is issued only for recorded var names', async () => {
    const member = makeTestAgent({
      friendlyName: 'ps-recorded', os: 'windows', workFolder: 'C:\\work',
      llmAuthDelivered: { files: [], envVars: ['ANTHROPIC_API_KEY'] },
    });
    addAgent(member);

    await removeMember({ member_id: member.id });

    const envCmds = sent().map(decode).filter(c => c.includes('SetEnvironmentVariable'));
    expect(envCmds).toEqual([`[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')`]);
    expect(sent().some(c => c.startsWith('Remove-Item') && c.includes('.credentials.json'))).toBe(false);
  });

  it('Windows PowerShell with no record: no User env var is cleared', async () => {
    const member = makeTestAgent({ friendlyName: 'ps-none', os: 'windows', workFolder: 'C:\\work' });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    expect(sent().map(decode).some(c => c.includes('SetEnvironmentVariable'))).toBe(false);
    expect(result).toContain('No record that apra-fleet delivered LLM credentials');
  });

  // Single member with a record, on every command set: only the recorded
  // file and var are targeted (POSIX: marked-only profile lines).
  const RECORD = { files: ['~/.claude/.credentials.json'], envVars: ['CLAUDE_CODE_OAUTH_TOKEN'] };
  const SETS: Array<[string, Partial<Agent>]> = [
    ['linux', { os: 'linux' }],
    ['macos', { os: 'macos' }],
    ['windows-gitbash', { os: 'windows', shell: 'gitbash', workFolder: 'C:\\work' }],
    ['windows-powershell', { os: 'windows', workFolder: 'C:\\work' }],
  ];
  for (const [label, fields] of SETS) {
    it(`${label}: removes only the recorded file and var`, async () => {
      const member = makeTestAgent({ friendlyName: `rec-${label}`, ...fields, llmAuthDelivered: RECORD });
      addAgent(member);
      const cmds = getOsCommands(member.os!, member.shell);

      await removeMember({ member_id: member.id });

      const all = sent().map(decode);
      const expected = [cmds.credentialFileRemove(RECORD.files[0]), ...cmds.unsetEnv('CLAUDE_CODE_OAUTH_TOKEN')];
      for (const c of expected) expect(sent()).toContain(c);
      // Never a var the fleet did not record, never the remove-all form.
      expect(all.some(c => c.includes('ANTHROPIC_API_KEY'))).toBe(false);
      expect(all.some(c => c.includes(unsetEnvSedExpr('CLAUDE_CODE_OAUTH_TOKEN', { all: true })))).toBe(false);
      if (label !== 'windows-powershell') {
        expect(all.filter(c => c.includes('sed -i')).every(c => c.includes(FLEET_ENV_MARKER))).toBe(true);
      }
    });
  }
});

// Round trip on real profile files in a temp HOME: a provision-style
// (marked) line plus a hand-written unmarked export of the same NAME; after
// the unset commands remove_member actually sent are run, only the unmarked
// hand-written line remains.
describe('removeMember - POSIX profile round trip in a sandboxed HOME', () => {
  const bash = findRealBash();
  if (!bash.path) console.warn(`remove-member round trip skipped -- ${bash.reason}`);

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });
  afterEach(() => restoreRegistry());

  it.skipIf(!bash.path)('only the hand-written export survives', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-rm-roundtrip-'));
    try {
      const linux = getOsCommands('linux');
      const fleetLine = linux.persistEnvFileContent('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-FLEETFAKE');
      const handLine = 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-OWNERFAKE"\n';
      for (const f of ['.bashrc', '.profile']) fs.writeFileSync(path.join(home, f), `# owner\n${handLine}${fleetLine}`);
      const member = makeTestAgent({ friendlyName: 'roundtrip', os: 'linux', llmAuthDelivered: { files: [], envVars: ['CLAUDE_CODE_OAUTH_TOKEN'] } });
      addAgent(member);

      await removeMember({ member_id: member.id });

      const unsetCmds = sent().filter(c => c.startsWith('sed -i'));
      expect(unsetCmds.length).toBeGreaterThan(0);
      const h = home.split(path.sep).join('/');
      for (const cmd of unsetCmds) {
        const r = spawnSync(bash.path!, ['--noprofile', '--norc', '-c', cmd], { env: { ...process.env, HOME: h, USERPROFILE: home } });
        expect(r.error).toBeUndefined();
      }
      for (const f of ['.bashrc', '.profile']) {
        expect(fs.readFileSync(path.join(home, f), 'utf-8'), f).toBe(`# owner\n${handLine}`);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
