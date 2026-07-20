/**
 * Tests for agent-provisioner.ts -- hash-based detection + provider-aware
 * provisioning of role-agent definition files (planner.md, doer.md, etc.)
 * onto remote fleet members.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import type { SSHExecResult } from '../src/types.js';
import { getOsCommands } from '../src/os/index.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

const FAKE_AGENT_ASSETS = [
  { relPath: 'planner.md', content: '---\nname: planner\ndescription: Plans work\ntools: [Read, Grep]\n---\nPlanner body' },
  { relPath: 'doer.md', content: '---\nname: doer\ndescription: Does work\ntools: [Read, Edit, Write, Bash]\n---\nDoer body' },
  { relPath: '_shared/conventions.md', content: 'Shared conventions text -- no frontmatter here' },
  { relPath: 'schemas/plan.schema.json', content: '{"type":"object","properties":{}}' },
];

vi.mock('../src/cli/install.js', () => ({
  loadAgentAssets: () => FAKE_AGENT_ASSETS,
}));

const mockUploadContentToHome = vi.fn();
vi.mock('../src/services/sftp.js', () => ({
  uploadContentToHome: (...args: any[]) => mockUploadContentToHome(...args),
}));

import {
  loadCanonicalAgentSet,
  remoteAgentsDir,
  probeRemoteAgentHashes,
  diffAgentSet,
  provisionAgents,
} from '../src/services/agent-provisioner.js';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

const OK: SSHExecResult = { stdout: '', stderr: '', code: 0 };

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });
});

afterEach(() => {
  restoreRegistry();
});

// ---------------------------------------------------------------------------
// loadCanonicalAgentSet
// ---------------------------------------------------------------------------

describe('loadCanonicalAgentSet', () => {
  it('includes role agents, _shared/, and schemas/ with correct hashes for claude', () => {
    const set = loadCanonicalAgentSet('claude');
    expect(set.map(f => f.relPath).sort()).toEqual([
      '_shared/conventions.md',
      'doer.md',
      'planner.md',
      'schemas/plan.schema.json',
    ]);

    const planner = set.find(f => f.relPath === 'planner.md')!;
    expect(planner.content).toBe(FAKE_AGENT_ASSETS[0].content);
    expect(planner.sha256).toBe(sha256(FAKE_AGENT_ASSETS[0].content));
    expect(planner.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('transforms .md files for opencode before hashing (mode: subagent)', () => {
    const set = loadCanonicalAgentSet('opencode');
    const planner = set.find(f => f.relPath === 'planner.md')!;
    expect(planner.content).toContain('mode: subagent');
    expect(planner.content).not.toBe(FAKE_AGENT_ASSETS[0].content);
    expect(planner.sha256).toBe(sha256(planner.content));
    // Hash differs from the untransformed claude set for the same file.
    const claudeSet = loadCanonicalAgentSet('claude');
    expect(planner.sha256).not.toBe(claudeSet.find(f => f.relPath === 'planner.md')!.sha256);
  });

  it('passes schemas/*.json through unchanged for opencode (no-op transform, no frontmatter)', () => {
    const set = loadCanonicalAgentSet('opencode');
    const schema = set.find(f => f.relPath === 'schemas/plan.schema.json')!;
    expect(schema.content).toBe(FAKE_AGENT_ASSETS[3].content);
    expect(schema.sha256).toBe(sha256(FAKE_AGENT_ASSETS[3].content));
  });
});

// ---------------------------------------------------------------------------
// remoteAgentsDir
// ---------------------------------------------------------------------------

describe('remoteAgentsDir', () => {
  it('maps each provider to its home-relative agents dir', () => {
    expect(remoteAgentsDir('claude')).toBe('.claude/agents');
    expect(remoteAgentsDir('gemini')).toBe('.gemini/agents');
    expect(remoteAgentsDir('agy')).toBe('.gemini/antigravity-cli/agents');
    expect(remoteAgentsDir('opencode')).toBe('.config/opencode/agents');
  });

  it('returns null for codex and copilot (no agents dir)', () => {
    expect(remoteAgentsDir('codex')).toBeNull();
    expect(remoteAgentsDir('copilot')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// probeRemoteAgentHashes
// ---------------------------------------------------------------------------

describe('probeRemoteAgentHashes', () => {
  const agent = makeTestAgent({ os: 'linux' });

  it('parses sha256sum-style output (linux)', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: 'aaaa000000000000000000000000000000000000000000000000000000000001  ./planner.md\n'
        + 'bbbb000000000000000000000000000000000000000000000000000000000002  ./_shared/conventions.md\n',
      stderr: '',
      code: 0,
    });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(false);
    expect(hashes!.get('planner.md')).toBe('aaaa000000000000000000000000000000000000000000000000000000000001');
    expect(hashes!.get('_shared/conventions.md')).toBe('bbbb000000000000000000000000000000000000000000000000000000000002');
  });

  it('parses shasum -a 256-style output (macos, single space separator with *)', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: 'cccc000000000000000000000000000000000000000000000000000000000003 *./doer.md\n',
      stderr: '',
      code: 0,
    });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(false);
    expect(hashes!.get('doer.md')).toBe('cccc000000000000000000000000000000000000000000000000000000000003');
  });

  it('parses Windows Get-FileHash output: backslash paths + uppercase hash normalized', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: 'DDDD000000000000000000000000000000000000000000000000000000000004  ./_shared/conventions.md\n'
        + 'EEEE000000000000000000000000000000000000000000000000000000000005  ./schemas\\plan.schema.json\n',
      stderr: '',
      code: 0,
    });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(false);
    expect(hashes!.get('_shared/conventions.md')).toBe('dddd000000000000000000000000000000000000000000000000000000000004');
    expect(hashes!.get('schemas/plan.schema.json')).toBe('eeee000000000000000000000000000000000000000000000000000000000005');
  });

  it('treats empty output as an empty map (missing/empty dir), not a failure', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(false);
    expect(hashes).not.toBeNull();
    expect(hashes!.size).toBe(0);
  });

  it('treats non-zero exit code as a failed probe', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(true);
    expect(hashes).toBeNull();
  });

  it('treats garbled output as a failed probe (no blind push)', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'not a hash listing at all\njust noise', stderr: '', code: 0 });

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(true);
    expect(hashes).toBeNull();
  });

  it('treats a transport/exec error as a failed probe', async () => {
    mockExecCommand.mockRejectedValue(new Error('ssh timeout'));

    const { hashes, failed } = await probeRemoteAgentHashes(agent, '.claude/agents');
    expect(failed).toBe(true);
    expect(hashes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// diffAgentSet
// ---------------------------------------------------------------------------

describe('diffAgentSet', () => {
  it('pushes everything when the remote map is empty', () => {
    const canonical = loadCanonicalAgentSet('claude');
    const stale = diffAgentSet(canonical, new Map());
    expect(stale.length).toBe(canonical.length);
  });

  it('pushes nothing when every hash matches', () => {
    const canonical = loadCanonicalAgentSet('claude');
    const remote = new Map(canonical.map(f => [f.relPath, f.sha256]));
    const stale = diffAgentSet(canonical, remote);
    expect(stale).toEqual([]);
  });

  it('pushes only stale/missing files, leaves extra remote files alone', () => {
    const canonical = loadCanonicalAgentSet('claude');
    const remote = new Map(canonical.map(f => [f.relPath, f.sha256]));
    remote.set('planner.md', 'stale-hash-does-not-match');
    remote.set('extra-file-not-in-canonical.md', sha256('whatever'));

    const stale = diffAgentSet(canonical, remote);
    expect(stale.map(f => f.relPath)).toEqual(['planner.md']);
  });
});

// ---------------------------------------------------------------------------
// provisionAgents
// ---------------------------------------------------------------------------

describe('provisionAgents', () => {
  it('is a no-op for local members', async () => {
    const local = makeTestLocalAgent();
    const result = await provisionAgents(local);
    expect(result.pushed).toEqual([]);
    expect(result.skippedReason).toBe('local member shares operator home');
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('skips codex members (no agents dir)', async () => {
    const agent = makeTestAgent({ llmProvider: 'codex', os: 'linux' });
    const result = await provisionAgents(agent);
    expect(result.pushed).toEqual([]);
    expect(result.skippedReason).toContain('codex');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('skips copilot members (no agents dir)', async () => {
    const agent = makeTestAgent({ llmProvider: 'copilot', os: 'linux' });
    const result = await provisionAgents(agent);
    expect(result.pushed).toEqual([]);
    expect(result.skippedReason).toContain('copilot');
  });

  it('warns without throwing when the probe fails, and does not push', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'linux' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });

    const result = await provisionAgents(agent);
    expect(result.pushed).toEqual([]);
    expect(result.warning).toBeDefined();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('never throws even if execCommand rejects', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'linux' });
    mockExecCommand.mockRejectedValue(new Error('connection reset'));

    await expect(provisionAgents(agent)).resolves.toEqual(
      expect.objectContaining({ pushed: [], warning: expect.any(String) })
    );
  });

  it('pushes only stale/missing files when the remote is partially up to date', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'linux' });
    const canonical = loadCanonicalAgentSet('claude');
    const plannerHash = canonical.find(f => f.relPath === 'planner.md')!.sha256;
    const doerHash = canonical.find(f => f.relPath === 'doer.md')!.sha256;

    // planner.md is already up to date; doer.md is missing entirely; _shared/conventions.md
    // is present but its hash doesn't match canonical (a valid 64-char hex hash, just the wrong one).
    const wrongHash = 'deadbeef'.repeat(8);
    mockExecCommand.mockResolvedValue({
      stdout: `${plannerHash}  ./planner.md\n${wrongHash}  ./_shared/conventions.md\n`,
      stderr: '',
      code: 0,
    });
    mockUploadContentToHome.mockResolvedValue({
      success: ['_shared/conventions.md', 'doer.md', 'schemas/plan.schema.json'],
      failed: [],
    });

    const result = await provisionAgents(agent);

    expect(mockUploadContentToHome).toHaveBeenCalledTimes(1);
    const [calledAgent, calledFiles, calledDir] = mockUploadContentToHome.mock.calls[0];
    expect(calledAgent).toBe(agent);
    expect(calledDir).toBe('.claude/agents');
    expect(calledFiles.map((f: any) => f.relPath).sort()).toEqual(
      ['_shared/conventions.md', 'doer.md', 'schemas/plan.schema.json'].sort()
    );
    expect(result.pushed.length).toBe(3);
    expect(result.warning).toBeUndefined();
    void doerHash; // referenced for readability of the fixture above
  });

  it('reports upload failures as a warning without throwing', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'linux' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 }); // empty remote -> push all
    mockUploadContentToHome.mockResolvedValue({
      success: ['planner.md'],
      failed: [{ path: 'doer.md', error: 'permission denied' }],
    });

    const result = await provisionAgents(agent);
    expect(result.pushed).toEqual(['planner.md']);
    expect(result.warning).toContain('doer.md');
  });

  it('returns no-op when everything is already up to date', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'linux' });
    const canonical = loadCanonicalAgentSet('claude');
    const stdout = canonical.map(f => `${f.sha256}  ./${f.relPath}\n`).join('');
    mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

    const result = await provisionAgents(agent);
    expect(result.pushed).toEqual([]);
    expect(result.warning).toBeUndefined();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// os-commands hashFilesRecursive per-OS shape
// ---------------------------------------------------------------------------

describe('provisionAgents: OS x provider matrix -- axes never mix', () => {
  // OS picks the probe command syntax (hashFilesRecursive); provider picks
  // the probed directory AND the expected (possibly transformed) content
  // hashes. Neither axis should ever leak into the other: probing a windows
  // member must use windows syntax regardless of provider, and diffing must
  // use the requested provider's directory/hashes regardless of member OS.
  const OSES = ['linux', 'macos', 'windows'] as const;
  const PROVIDERS = ['claude', 'opencode'] as const;

  for (const os of OSES) {
    for (const provider of PROVIDERS) {
      it(`${os} x ${provider}: probes with ${os} syntax against the ${provider} dir and provider-correct hashes`, async () => {
        const agent = makeTestAgent({ llmProvider: provider, os });
        mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 }); // empty remote -> push all
        mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });

        await provisionAgents(agent);

        expect(mockExecCommand).toHaveBeenCalledTimes(1);
        const [probedCmd] = mockExecCommand.mock.calls[0];
        const expectedDir = remoteAgentsDir(provider)!;

        // OS axis: the probe command must match this member's OS syntax, not any other OS's.
        const expectedCmd = getOsCommands(os).hashFilesRecursive(expectedDir);
        expect(probedCmd).toBe(expectedCmd);
        for (const otherOs of OSES.filter(o => o !== os)) {
          expect(probedCmd).not.toBe(getOsCommands(otherOs).hashFilesRecursive(expectedDir));
        }

        // Provider axis: the files pushed must carry this provider's (possibly
        // transformed) hashes, never the other provider's.
        expect(mockUploadContentToHome).toHaveBeenCalledTimes(1);
        const [, pushedFiles, calledDir] = mockUploadContentToHome.mock.calls[0];
        expect(calledDir).toBe(expectedDir);
        const plannerPushed = pushedFiles.find((f: any) => f.relPath === 'planner.md');
        const expectedContent = loadCanonicalAgentSet(provider).find(f => f.relPath === 'planner.md')!.content;
        const otherProviderContent = loadCanonicalAgentSet(
          PROVIDERS.find(p => p !== provider)!
        ).find(f => f.relPath === 'planner.md')!.content;
        expect(plannerPushed.content).toBe(expectedContent);
        expect(plannerPushed.content).not.toBe(otherProviderContent);
      });
    }
  }

  it('a claude-hashed remote listing never satisfies an opencode diff (and vice versa)', () => {
    const claudeSet = loadCanonicalAgentSet('claude');
    const opencodeSet = loadCanonicalAgentSet('opencode');
    const remoteHasClaudeHashes = new Map(claudeSet.map(f => [f.relPath, f.sha256]));

    // Diffing opencode's canonical set against a remote that actually holds
    // untransformed claude hashes must treat every .md file as stale --
    // the transform means the hashes can never coincidentally match.
    const staleAgainstClaudeRemote = diffAgentSet(opencodeSet, remoteHasClaudeHashes);
    expect(staleAgainstClaudeRemote.map(f => f.relPath).sort()).toEqual(
      ['doer.md', 'planner.md'].sort()
    );

    // The reverse also holds.
    const remoteHasOpencodeHashes = new Map(opencodeSet.map(f => [f.relPath, f.sha256]));
    const staleAgainstOpencodeRemote = diffAgentSet(claudeSet, remoteHasOpencodeHashes);
    expect(staleAgainstOpencodeRemote.map(f => f.relPath).sort()).toEqual(
      ['doer.md', 'planner.md'].sort()
    );
  });
});

describe('hashFilesRecursive (os-commands)', () => {
  it('linux: cd into dir + find/sha256sum, non-fatal on missing dir', () => {
    const cmd = getOsCommands('linux').hashFilesRecursive('.claude/agents');
    expect(cmd).toContain('cd ".claude/agents"');
    expect(cmd).toContain('sha256sum');
    expect(cmd).toContain('find . -type f');
    expect(cmd).toContain('|| true');
  });

  it('macos: uses shasum -a 256 instead of sha256sum', () => {
    const cmd = getOsCommands('macos').hashFilesRecursive('.claude/agents');
    expect(cmd).toContain('cd ".claude/agents"');
    expect(cmd).toContain('shasum -a 256');
    expect(cmd).not.toContain('sha256sum');
  });

  it('windows: emits a base64-encoded PowerShell -EncodedCommand', () => {
    const cmd = getOsCommands('windows').hashFilesRecursive('.claude/agents');
    expect(cmd.startsWith('powershell -EncodedCommand ')).toBe(true);
    const encoded = cmd.replace('powershell -EncodedCommand ', '');
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toContain('Join-Path $HOME');
    expect(decoded).toContain('.claude\\agents');
    expect(decoded).toContain('Get-FileHash');
    expect(decoded).toContain('SHA256');
    expect(decoded).toContain('.ToLower()');
  });
});
