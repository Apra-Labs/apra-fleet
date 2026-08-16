/**
 * apra-fleet issue #390 -- session-log path resolution must target the MEMBER's
 * machine, not the hub's.
 *
 * ROOT CAUSE (fixed by this suite's subject code):
 *   Every provider's resolveSessionLogPath/resolveSessionLogDir did
 *   `const home = homeDir ?? os.homedir(); return path.join(home, ...)`, and NO
 *   caller ever passed `homeDir`. Two independent defects fell out of that:
 *     1. WRONG USER  -- os.homedir() is the HUB's home ('alice'), never the
 *        remote member's ('bella').
 *     2. WRONG SEPARATOR/ROOT -- `path.join` follows the HUB process's OS, so a
 *        Windows hub emitted backslash paths for a Linux member and vice versa.
 *   Downstream: Claude/Gemini polled a path that can never exist (stall
 *   detection silently inert), while AGY/OpenCode lost their directory-mtime
 *   signal entirely and the provisional baseline timeout FALSE-KILLED healthy
 *   dispatches.
 *
 * TEST MATRIX (all cases below are real parameterized cases, not a comment):
 *   LOCAL  : hub OS {windows, linux, macos} x provider {claude, agy} = 6
 *            Expected: unchanged behavior -- the hub's own home dir and the
 *            hub's own path convention, because a local member IS the hub's OS
 *            user on the hub's OS. Pinned so a future change cannot silently
 *            break the local path (and so no remote probe is ever issued).
 *   REMOTE : hub OS {windows, linux, macos} x member OS {windows, linux, macos}
 *            x provider {claude, agy} = 18
 *            Expected: bella's home in the MEMBER's OS convention
 *            (C:\Users\bella\... backslashes / /home/bella/... /Users/bella/...)
 *            regardless of the hub's OS.
 *
 * Note on simulating the hub OS: `path.join`'s convention is fixed to the
 * process's real platform and cannot be swapped in-process. That is fine and is
 * exactly the point -- the LOCAL expectations are therefore written in terms of
 * the host's own `path.join` (which is the hub's convention by definition), and
 * the REMOTE expectations are written in terms of `path.win32`/`path.posix`
 * chosen by the MEMBER's OS, so a remote path that still leaked the host
 * convention would fail on 2 of every 3 member-OS columns on any given runner.
 * The hub's home directory is varied for real (os.homedir is stubbed), so the
 * "wrong user" half of the bug is caught on every single remote cell.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { Agent, SSHExecResult } from '../src/types.js';

const { mockExecCommand, mockLogWarn } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeoutMs?: number) => Promise<SSHExecResult>>(),
  mockLogWarn: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

vi.mock('../src/services/registry.js', () => ({
  getAgent: vi.fn(),
  findAgentByName: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: vi.fn(),
  logWarn: mockLogWarn,
}));

import {
  getMemberHomeDir,
  getMemberPathContext,
  getCachedMemberPathContext,
  homeDirFromUsername,
  clearMemberHomeDirCache,
} from '../src/services/member-home.js';
import {
  resolveSessionLogPath,
  resolveSessionLogDir,
} from '../src/services/stall/log-path-resolver.js';

type OSName = 'windows' | 'linux' | 'macos';
type Provider = 'claude' | 'agy';

const OSES: OSName[] = ['windows', 'linux', 'macos'];
const PROVIDERS: Provider[] = ['claude', 'agy'];

/** Hub user is ALWAYS 'alice'; remote member user is ALWAYS 'bella'. Any
 *  resolved remote path containing 'alice' is the wrong-user bug returning. */
const HUB_HOME: Record<OSName, string> = {
  windows: 'C:\\Users\\alice',
  linux: '/home/alice',
  macos: '/Users/alice',
};
const MEMBER_HOME: Record<OSName, string> = {
  windows: 'C:\\Users\\bella',
  linux: '/home/bella',
  macos: '/Users/bella',
};
const MEMBER_WORKFOLDER: Record<OSName, string> = {
  windows: 'C:\\Users\\bella\\work\\repo',
  linux: '/home/bella/work/repo',
  macos: '/Users/bella/work/repo',
};

const SESSION_ID = 'sess-390-abc';

function joinerFor(memberOs: OSName) {
  return memberOs === 'windows' ? path.win32.join : path.posix.join;
}

/** Claude Code's on-disk project-dir encoding: every non-alphanumeric -> '-'. */
function encode(workFolder: string): string {
  return workFolder.replace(/[^a-zA-Z0-9]/g, '-');
}

function expectedLogPath(provider: Provider, memberOs: OSName, home: string, workFolder: string): string {
  const join = joinerFor(memberOs);
  return provider === 'claude'
    ? join(home, '.claude', 'projects', encode(workFolder), `${SESSION_ID}.jsonl`)
    : join(home, '.gemini', 'antigravity-cli', 'brain', SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl');
}

function expectedLogDir(provider: Provider, memberOs: OSName, home: string, workFolder: string): string {
  const join = joinerFor(memberOs);
  return provider === 'claude'
    ? join(home, '.claude', 'projects', encode(workFolder))
    : join(home, '.gemini', 'antigravity-cli', 'brain');
}

function remoteAgent(memberOs: OSName, provider: Provider, id = 'member-bella'): Agent {
  return {
    id,
    friendlyName: 'bella-member',
    agentType: 'remote',
    host: '10.0.0.9',
    port: 22,
    username: 'bella',
    workFolder: MEMBER_WORKFOLDER[memberOs],
    os: memberOs,
    llmProvider: provider,
    createdAt: new Date().toISOString(),
  };
}

function localAgent(hubOs: OSName, provider: Provider, id = 'member-alice'): Agent {
  return {
    id,
    friendlyName: 'alice-local',
    agentType: 'local',
    workFolder: MEMBER_WORKFOLDER[hubOs].replace('bella', 'alice'),
    os: hubOs,
    llmProvider: provider,
    createdAt: new Date().toISOString(),
  };
}

/** Make the home-dir probe answer as `memberOs`'s shell would. */
function stubProbe(memberOs: OSName): void {
  mockExecCommand.mockImplementation(async () => ({
    stdout: memberOs === 'windows' ? MEMBER_HOME.windows : `${MEMBER_HOME[memberOs]}\n`,
    stderr: '',
    code: 0,
  }));
}

let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberHomeDirCache();
  homedirSpy = vi.spyOn(os, 'homedir');
});

afterEach(() => {
  homedirSpy.mockRestore();
  clearMemberHomeDirCache();
});

// ---------------------------------------------------------------------------
// LOCAL: 3 hub OSes x 2 providers = 6 cases
// ---------------------------------------------------------------------------
describe('local members -- unchanged by the #390 fix (regression pins)', () => {
  const localCases = OSES.flatMap(hubOs => PROVIDERS.map(provider => ({ hubOs, provider })));
  expect(localCases).toHaveLength(6);

  it.each(localCases)(
    'hub=$hubOs provider=$provider resolves under the HUB home with the HUB path convention, with no remote probe',
    async ({ hubOs, provider }) => {
      homedirSpy.mockReturnValue(HUB_HOME[hubOs]);
      const agent = localAgent(hubOs, provider);

      const ctx = await getMemberPathContext(agent);
      // Local members are the hub's own OS user: home is os.homedir() and the
      // join convention stays the host's (targetOs undefined), byte-identical
      // to the pre-fix behavior.
      expect(ctx.homeDir).toBe(HUB_HOME[hubOs]);
      expect(ctx.targetOs).toBeUndefined();
      expect(ctx.source).toBe('local');
      // Crucially: NO command is ever run against a local member to learn this.
      expect(mockExecCommand).not.toHaveBeenCalled();

      const workFolder = agent.workFolder;
      const logPath = resolveSessionLogPath(provider, SESSION_ID, workFolder, ctx.homeDir, ctx.targetOs);
      const logDir = resolveSessionLogDir(provider, workFolder, ctx.homeDir, ctx.targetOs);

      // Host `path.join` IS the hub's convention, so this is the exact
      // pre-existing expectation, now pinned.
      const hostJoin = path.join;
      expect(logPath).toBe(
        provider === 'claude'
          ? hostJoin(HUB_HOME[hubOs], '.claude', 'projects', encode(workFolder), `${SESSION_ID}.jsonl`)
          : hostJoin(HUB_HOME[hubOs], '.gemini', 'antigravity-cli', 'brain', SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl')
      );
      expect(logDir).toBe(
        provider === 'claude'
          ? hostJoin(HUB_HOME[hubOs], '.claude', 'projects', encode(workFolder))
          : hostJoin(HUB_HOME[hubOs], '.gemini', 'antigravity-cli', 'brain')
      );
      // path.join normalizes the root to the host convention too, so compare
      // against the normalized hub home rather than the raw literal.
      expect(logPath.startsWith(path.join(HUB_HOME[hubOs]))).toBe(true);
      expect(logPath).toContain('alice');
      expect(logPath).not.toContain('bella');
    }
  );
});

// ---------------------------------------------------------------------------
// REMOTE: 3 hub OSes x 3 member OSes x 2 providers = 18 cases
// ---------------------------------------------------------------------------
describe('remote members -- member home dir + member OS path convention (#390)', () => {
  const remoteCases = OSES.flatMap(hubOs =>
    OSES.flatMap(memberOs => PROVIDERS.map(provider => ({ hubOs, memberOs, provider })))
  );
  expect(remoteCases).toHaveLength(18);

  it.each(remoteCases)(
    'hub=$hubOs member=$memberOs provider=$provider resolves under bella\'s home in the member OS convention',
    async ({ hubOs, memberOs, provider }) => {
      homedirSpy.mockReturnValue(HUB_HOME[hubOs]);
      stubProbe(memberOs);

      const agent = remoteAgent(memberOs, provider);
      const ctx = await getMemberPathContext(agent);

      expect(ctx.homeDir).toBe(MEMBER_HOME[memberOs]);
      expect(ctx.targetOs).toBe(memberOs);
      expect(ctx.source).toBe('probe');

      const workFolder = agent.workFolder;
      const logPath = resolveSessionLogPath(provider, SESSION_ID, workFolder, ctx.homeDir, ctx.targetOs);
      const logDir = resolveSessionLogDir(provider, workFolder, ctx.homeDir, ctx.targetOs);

      expect(logPath).toBe(expectedLogPath(provider, memberOs, MEMBER_HOME[memberOs], workFolder));
      expect(logDir).toBe(expectedLogDir(provider, memberOs, MEMBER_HOME[memberOs], workFolder));

      // Defect 1 -- WRONG USER: the remote path must be bella's, never alice's,
      // and must never be rooted at the hub's home.
      expect(logPath).toContain('bella');
      expect(logPath).not.toContain('alice');
      expect(logPath.startsWith(HUB_HOME[hubOs])).toBe(false);
      expect(logDir).toContain('bella');
      expect(logDir).not.toContain('alice');

      // Defect 2 -- WRONG SEPARATOR/ROOT: the separators must follow the
      // MEMBER's OS, whatever the hub runs.
      if (memberOs === 'windows') {
        expect(logPath.startsWith('C:\\Users\\bella\\')).toBe(true);
        expect(logPath).toContain('\\');
      } else {
        expect(logPath.startsWith(`${MEMBER_HOME[memberOs]}/`)).toBe(true);
        expect(logPath).not.toContain('\\');
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Home-dir probe behavior
// ---------------------------------------------------------------------------
describe('getMemberHomeDir -- probe, cache, and graceful failure', () => {
  it.each(OSES)('issues an OS-appropriate probe for a %s member', async memberOs => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    stubProbe(memberOs);

    const home = await getMemberHomeDir(remoteAgent(memberOs, 'claude'));

    expect(home).toBe(MEMBER_HOME[memberOs]);
    const cmd = mockExecCommand.mock.calls[0]![0];
    if (memberOs === 'windows') {
      // Delivered via wrapPowerShellEncoded (base64 -EncodedCommand), not a
      // raw inline string -- decode to inspect the actual script. No
      // fallback to the raw `cmd` here: an un-encoded regression must
      // decode to '' (no USERPROFILE match) instead of silently passing.
      expect(cmd).toContain('powershell');
      const encodedMatch = cmd.match(/-EncodedCommand (\S+)/);
      const decoded = encodedMatch ? Buffer.from(encodedMatch[1], 'base64').toString('utf16le') : '';
      expect(cmd).not.toBe(decoded); // must be -EncodedCommand wrapped
      expect(decoded).toContain('USERPROFILE');
      // Regression guard (fleet-win11 / fleet-win-dev1 live failure): the
      // raw issued command must carry no bare dollar-env reference an
      // outer PowerShell shell could expand.
      expect(cmd).not.toMatch(/\$\w/);
    } else {
      expect(cmd).toContain('$HOME');
      expect(cmd).not.toContain('USERPROFILE');
    }
  });

  it('probes once per member and serves later calls from cache', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.windows);
    stubProbe('linux');
    const agent = remoteAgent('linux', 'agy');

    expect(await getMemberHomeDir(agent)).toBe('/home/bella');
    expect(await getMemberHomeDir(agent)).toBe('/home/bella');
    expect(await getMemberHomeDir(agent)).toBe('/home/bella');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent probes into a single remote exec', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    stubProbe('macos');
    const agent = remoteAgent('macos', 'claude');

    const results = await Promise.all([
      getMemberHomeDir(agent),
      getMemberHomeDir(agent),
      getMemberHomeDir(agent),
    ]);

    expect(results).toEqual(['/Users/bella', '/Users/bella', '/Users/bella']);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('returns null (never throws, never falls back to the hub home) when the probe fails', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.windows);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'ssh: connect failed', code: 255 });

    const home = await getMemberHomeDir(remoteAgent('linux', 'agy'));
    expect(home).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith('member_home_probe', expect.stringContaining('bella-member'));
  });

  it('returns null when the probe throws', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    mockExecCommand.mockRejectedValue(new Error('channel closed'));
    expect(await getMemberHomeDir(remoteAgent('linux', 'claude'))).toBeNull();
  });

  it('rejects a non-path probe answer instead of trusting shell noise', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    mockExecCommand.mockResolvedValue({ stdout: 'command not found: printf', stderr: '', code: 0 });
    expect(await getMemberHomeDir(remoteAgent('linux', 'claude'))).toBeNull();
  });

  it('takes the last non-empty line so a login banner cannot be mistaken for the home dir', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    mockExecCommand.mockResolvedValue({
      stdout: 'Welcome to Ubuntu 24.04 LTS\n\n/home/bella\n',
      stderr: '',
      code: 0,
    });
    expect(await getMemberHomeDir(remoteAgent('linux', 'claude'))).toBe('/home/bella');
  });

  it('does NOT cache a failure, so a transiently unreachable member recovers on the next poll', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    const agent = remoteAgent('linux', 'agy');

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: 'timeout', code: 1 });
    expect(await getMemberHomeDir(agent)).toBeNull();

    stubProbe('linux');
    expect(await getMemberHomeDir(agent)).toBe('/home/bella');
  });
});

// ---------------------------------------------------------------------------
// Unresolvable home dir must degrade to "no path", never to a hub-home path
// ---------------------------------------------------------------------------
describe('username-derived home dir is a LAST-RESORT fallback only', () => {
  it.each(OSES)(
    '%s: getMemberPathContext prefers the PROBE and never falls back when it succeeds',
    async memberOs => {
      homedirSpy.mockReturnValue(HUB_HOME.linux);
      const agent = remoteAgent(memberOs, 'agy');
      // A relocated home the username convention would never have guessed.
      const relocated = memberOs === 'windows' ? 'D:\\profiles\\bella' : '/export/home/bella';
      mockExecCommand.mockResolvedValue({ stdout: relocated, stderr: '', code: 0 });

      const ctx = await getMemberPathContext(agent);
      expect(ctx.homeDir).toBe(relocated);
      expect(ctx.source).toBe('probe');
    }
  );

  it.each(OSES)('%s: falls back to the username convention ONLY when the probe fails', async memberOs => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'unreachable', code: 255 });

    const ctx = await getMemberPathContext(remoteAgent(memberOs, 'agy'));
    expect(ctx.homeDir).toBe(MEMBER_HOME[memberOs]);
    expect(ctx.source).toBe('username-fallback');
    // Still never the hub's home.
    expect(ctx.homeDir).not.toContain('alice');
  });

  it('reports source "unknown" (homeDir null) when the probe fails and no username is recorded', async () => {
    homedirSpy.mockReturnValue(HUB_HOME.windows);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'unreachable', code: 255 });
    const agent = { ...remoteAgent('linux', 'claude'), username: undefined };

    const ctx = await getMemberPathContext(agent);
    expect(ctx.homeDir).toBeNull();
    expect(ctx.source).toBe('unknown');
  });

  it('honors the per-OS root account convention', () => {
    expect(homeDirFromUsername('root', 'linux')).toBe('/root');
    expect(homeDirFromUsername('root', 'macos')).toBe('/var/root');
    expect(homeDirFromUsername('bella', 'linux')).toBe('/home/bella');
    expect(homeDirFromUsername('bella', 'macos')).toBe('/Users/bella');
    expect(homeDirFromUsername('bella', 'windows')).toBe('C:\\Users\\bella');
    expect(homeDirFromUsername(undefined, 'linux')).toBeNull();
  });
});

describe('getCachedMemberPathContext -- synchronous, never issues a command', () => {
  it.each(OSES)('%s member: resolves without any round trip', memberOs => {
    homedirSpy.mockReturnValue(HUB_HOME.windows);
    const ctx = getCachedMemberPathContext(remoteAgent(memberOs, 'claude'));

    expect(ctx.homeDir).toBe(MEMBER_HOME[memberOs]);
    expect(ctx.targetOs).toBe(memberOs);
    expect(ctx.source).toBe('username-fallback');
    expect(mockExecCommand).not.toHaveBeenCalled();
    // The whole point: never the hub's home.
    expect(ctx.homeDir).not.toContain('alice');
  });

  it.each(OSES)('%s member: a probed home dir supersedes the username fallback', async memberOs => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    const agent = remoteAgent(memberOs, 'agy');
    const relocated = memberOs === 'windows' ? 'D:\\profiles\\bella' : '/export/home/bella';

    mockExecCommand.mockResolvedValue({ stdout: relocated, stderr: '', code: 0 });
    await getMemberHomeDir(agent);

    const ctx = getCachedMemberPathContext(agent);
    expect(ctx.homeDir).toBe(relocated);
    expect(ctx.source).toBe('probe');
  });

  it('local member: uses the hub home and the hub path convention, with no probe', () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    const ctx = getCachedMemberPathContext(localAgent('linux', 'claude'));
    expect(ctx.homeDir).toBe(HUB_HOME.linux);
    expect(ctx.targetOs).toBeUndefined();
    expect(ctx.source).toBe('local');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('remote member with no recorded username: resolves to null, never to the hub home', () => {
    homedirSpy.mockReturnValue(HUB_HOME.windows);
    const agent = { ...remoteAgent('linux', 'claude'), username: undefined };
    expect(getCachedMemberPathContext(agent).homeDir).toBeNull();
  });
});

describe('unresolvable member home dir degrades honestly (#390)', () => {
  it.each(PROVIDERS)(
    '%s: a null homeDir yields no log dir and an unresolvable log path -- never a hub-home path',
    provider => {
      homedirSpy.mockReturnValue(HUB_HOME.windows);
      const workFolder = MEMBER_WORKFOLDER.linux;

      // The pre-fix behavior here was to silently substitute os.homedir(), which
      // is exactly how a remote dispatch ended up polling C:\Users\alice\... on
      // a Linux member.
      expect(resolveSessionLogDir(provider, workFolder, null, 'linux')).toBeNull();
      expect(() => resolveSessionLogPath(provider, SESSION_ID, workFolder, null, 'linux')).toThrow(
        /Unsupported log polling/
      );
    }
  );

  it('an omitted homeDir still falls back to the host home (legacy callers unaffected)', () => {
    homedirSpy.mockReturnValue(HUB_HOME.linux);
    expect(resolveSessionLogDir('claude', '/home/alice/work/repo')).toBe(
      path.join('/home/alice', '.claude', 'projects', '-home-alice-work-repo')
    );
  });
});
