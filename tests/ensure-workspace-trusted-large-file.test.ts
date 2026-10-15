/**
 * Regression tests for GitHub #499: ensureWorkspaceTrusted used to embed the ENTIRE
 * merged ~/.claude.json in one command string (`WriteAllText(..., '<84 KB>')` /
 * `bash -c '<heredoc>'`). On a Windows host that command line exceeds the
 * CreateProcess limit (32767 chars; cmd.exe 8191) and the spawn fails with
 * ENAMETOOLONG, so trust was never seeded.
 *
 * Since apra-fleet-b4g.101 the content NEVER rides a command line at all (not raw,
 * base64 or chunked): it goes through the file channel (transport.writeHomeFile:
 * node:fs locally, SFTP over SSH) or the owner-only secret file, followed by a
 * content-free Move-Item / mv; with neither channel the write fails loudly.
 *
 * Covers:
 * - the file channel on PowerShell, gitbash and Linux members (tiny move only)
 * - no channel at all -> E-MEMBER-CONFIG-NO-FILE-CHANNEL, nothing inline
 * - the secret-file fallback and its cleanup
 * - workspaceTrustTransportFor composes getMemberHomeDir + strategy.transferFiles
 *   and is absent for relay members
 *
 * Everything here runs against FAKES: a virtual member filesystem driven by the
 * command strings, temp directories for the local-strategy case. No real
 * ~/.claude.json, no real shell, no credentials.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider, workspaceTrustStagingNames } from '../src/providers/claude.js';
import type { WorkspaceTrustTransport } from '../src/providers/provider.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/member-home.js', () => ({
  getMemberHomeDir: vi.fn(),
}));
import { getMemberHomeDir } from '../src/services/member-home.js';
import { workspaceTrustTransportFor, sftpHomePath } from '../src/utils/workspace-trust.js';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';

/** JS-resolved member homes (getMemberHomeDir) every caller passes; the fake
 *  member fs is keyed by the literal paths built from them. */
const WIN_HOME = 'C:\\Users\\member';
const POSIX_HOME = '/home/member';
const TEST_HOME = (agentOs?: string, shell?: string) => (agentOs === 'windows' && shell !== 'gitbash' ? WIN_HOME : POSIX_HOME);

const KEY = 'C:/akhil/git/project-a';
const HARD_LIMIT = 30000;

/** A ~/.claude.json that is comfortably larger than the 32767-char command-line
 *  cap: lots of history entries, quotes, apostrophes and unicode escapes so any
 *  quoting bug would show up as a content mismatch. */
function makeLargeClaudeJson(): Record<string, unknown> {
  const history: Array<{ display: string; pastedContents: Record<string, unknown> }> = [];
  for (let i = 0; i < 700; i++) {
    history.push({
      display: `entry ${i}: it's a "quoted" line with $env:VAR and \`backticks\` and a backslash \\ and unicode \u00e9`,
      pastedContents: { id: i, text: 'x'.repeat(40) },
    });
  }
  return {
    numStartups: 42,
    oauthAccount: { emailAddress: 'fake@example.invalid', organizationUuid: '0000' },
    projects: {
      'C:/other/project': { allowedTools: ['Bash(git:*)'], history, hasTrustDialogAccepted: true },
      [KEY]: { allowedTools: ['Read'], history: history.slice(0, 50) },
    },
  };
}

function expectedMerged(existing: Record<string, unknown>, key: string): string {
  const projects = existing.projects as Record<string, Record<string, unknown>>;
  return JSON.stringify({
    ...existing,
    projects: { ...projects, [key]: { ...projects[key], hasTrustDialogAccepted: true } },
  }, null, 2);
}

/**
 * Virtual member filesystem keyed by the literal path strings the impl uses
 * (`C:\Users\member\.claude.json`, `/home/member/.claude.json`, ...). It
 * understands ONLY the reads and the content-free moves ensureWorkspaceTrusted
 * may emit: any other command (in particular one carrying file content) throws,
 * so a regression to inline delivery fails loudly here.
 */
function makeMemberFs(initialHome: string | null, posixFlavour = false) {
  const files = new Map<string, string>();
  if (initialHome !== null) {
    files.set(`${WIN_HOME}\\.claude.json`, initialHome);
    files.set(`${POSIX_HOME}/.claude.json`, initialHome);
  }
  const calls: string[] = [];

  const exec = vi.fn(async (cmd: string): Promise<SSHExecResult> => {
    calls.push(cmd);
    let m: RegExpMatchArray | null;

    // --- reads ---
    if ((m = cmd.match(/^Get-Content -Raw "([^"]+)"/)) || (m = cmd.match(/^cat "([^"]+)"/))) {
      const marker = cmd.match(/(?:echo|Write-Output) "([^"]+)"/)![1];
      return { stdout: `${files.get(m[1]) ?? ''}\n${marker}\n`, stderr: '', code: 0 };
    }
    // --- PowerShell move only (file channel) ---
    if ((m = cmd.match(/^Move-Item -Force "([^"]+)" "([^"]+)"$/))) {
      if (!files.has(m[1])) return { stdout: '', stderr: `Cannot find path '${m[1]}'`, code: 1 };
      files.set(m[2], files.get(m[1])!);
      files.delete(m[1]);
      return { stdout: '', stderr: '', code: 0 };
    }
    // --- POSIX move only (file channel) ---
    if ((m = cmd.match(/^mv "([^"]+)" "([^"]+)"$/))) {
      if (!files.has(m[1])) return { stdout: '', stderr: 'No such file', code: 1 };
      files.set(m[2], files.get(m[1])!);
      files.delete(m[1]);
      return { stdout: '', stderr: '', code: 0 };
    }

    throw new Error(`fake member fs: unrecognised command: ${cmd.slice(0, 120)}`);
  });

  /** transport.writeHomeFile fake: stages under the spelling the member's shell
   *  flavour's Move-Item/mv will look for. */
  const transport: WorkspaceTrustTransport & { writes: Array<{ relPath: string; content: string }> } = {
    writes: [],
    writeHomeFile: async (relPath, content) => {
      transport.writes.push({ relPath, content });
      files.set(posixFlavour ? `${POSIX_HOME}/${relPath}` : `${WIN_HOME}\\${relPath}`, content);
    },
  };

  return {
    exec,
    calls,
    files,
    transport,
    home: (posix: boolean) => files.get(posix ? `${POSIX_HOME}/.claude.json` : `${WIN_HOME}\\.claude.json`),
    leftovers: () => [...files.keys()].filter(k => k.includes('fleet-trust')),
  };
}

describe('ensureWorkspaceTrusted with a >80 KB ~/.claude.json (GitHub #499, apra-fleet-b4g.101)', () => {
  const existing = makeLargeClaudeJson();
  const existingStr = JSON.stringify(existing, null, 2);
  const expected = expectedMerged(existing, KEY);

  it('fixture really is over the Windows command-line limit', () => {
    expect(existingStr.length).toBeGreaterThan(80 * 1024);
    expect(expected.length).toBeGreaterThan(HARD_LIMIT);
  });

  it('Windows PowerShell member with a file channel: content never rides a command line', async () => {
    const member = makeMemberFs(existingStr);
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, member.transport, TEST_HOME('windows', undefined));

    expect(result.seeded).toBe(true);
    expect(member.transport.writes).toHaveLength(1);
    expect(member.transport.writes[0].relPath).toMatch(/^\.claude\.json\.fleet-trust-\d+-[a-z0-9]+\.tmp$/);
    expect(member.transport.writes[0].content).toBe(expected);
    // read + one tiny move; nothing else
    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toMatch(/^Move-Item -Force "C:\\Users\\member\\\.claude\.json\.fleet-trust-\d+-[a-z0-9]+\.tmp" "C:\\Users\\member\\\.claude\.json"$/);
    expect(member.calls[1].length).toBeLessThan(200);
    expect(member.home(false)).toBe(expected);
    expect(member.leftovers()).toEqual([]);
  });

  it('gitbash Windows member with a file channel: POSIX mv, nothing else on the command line', async () => {
    const member = makeMemberFs(existingStr, true);
    await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', 'gitbash', member.transport, TEST_HOME('windows', 'gitbash'));

    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toMatch(/^mv "\/home\/member\/\.claude\.json\.fleet-trust-\d+-[a-z0-9]+\.tmp" "\/home\/member\/\.claude\.json"$/);
    expect(member.home(true)).toBe(expected);
  });

  it('Linux member with a file channel: same content-free mv', async () => {
    const member = makeMemberFs(existingStr, true);
    const linuxKey = '/home/member/work/project-a';
    await new ClaudeProvider().ensureWorkspaceTrusted(linuxKey, member.exec, 'linux', undefined, member.transport, TEST_HOME('linux', undefined));
    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toMatch(/^mv "/);
    expect(member.home(true)).toBe(expectedMerged(existing, linuxKey));
  });

  it('NO file channel and no secret-file channel: fails loudly naming the missing channels -- no inline fallback', async () => {
    for (const [os, shell] of [['windows', undefined], ['windows', 'gitbash'], ['linux', undefined]] as const) {
      const member = makeMemberFs(existingStr);
      await expect(new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, os, shell, undefined, TEST_HOME(os, shell)))
        .rejects.toThrow(/E-MEMBER-CONFIG-NO-FILE-CHANNEL.*file channel.*not available.*secret-file channel: not available/s);
      // Only the read ever ran; no command carries content.
      expect(member.calls).toHaveLength(1);
      expect(member.home(os !== 'windows' || shell === 'gitbash')).toBe(existingStr);
    }
  });

  it('a failing file channel falls back to the owner-only secret file, then a content-free move', async () => {
    const member = makeMemberFs(existingStr);
    const broken: WorkspaceTrustTransport = { writeHomeFile: async () => { throw new Error('sftp subsystem disabled'); } };
    const secret = {
      write: vi.fn(async (content: string) => { member.files.set('C:\\Users\\member\\.apra-fleet-claude-config-1', content); return 'C:\\Users\\member\\.apra-fleet-claude-config-1'; }),
      remove: vi.fn(async () => undefined),
    };
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, broken, TEST_HOME('windows', undefined), secret);

    expect(result.seeded).toBe(true);
    expect(secret.write).toHaveBeenCalledWith(expected);
    expect(member.calls[member.calls.length - 1]).toBe('Move-Item -Force "C:\\Users\\member\\.apra-fleet-claude-config-1" "C:\\Users\\member\\.claude.json"');
    for (const c of member.calls) expect(c.length).toBeLessThan(400);
    expect(member.home(false)).toBe(expected);
  });

  it('a file channel whose move step fails does not fall back inline: it fails naming both channels', async () => {
    const member = makeMemberFs(existingStr);
    // Stages nothing, so the Move-Item exits 1.
    const silent: WorkspaceTrustTransport = { writeHomeFile: async () => undefined };
    await expect(new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, silent, TEST_HOME('windows', undefined)))
      .rejects.toThrow(/E-MEMBER-CONFIG-NO-FILE-CHANNEL.*file channel: move into place failed/s);
    expect(member.home(false)).toBe(existingStr);
  });

  it('a failed secret-file move cleans the staged secret file up', async () => {
    const member = makeMemberFs(existingStr);
    const secret = { write: vi.fn(async () => 'C:\\Users\\member\\missing-secret'), remove: vi.fn(async () => undefined) };
    await expect(new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, undefined, TEST_HOME('windows', undefined), secret))
      .rejects.toThrow(/secret-file channel: move into place failed/);
    expect(secret.remove).toHaveBeenCalledWith('C:\\Users\\member\\missing-secret');
  });

  it('staging file names are unique per call and shared by the file channel and the move command', async () => {
    const a = makeMemberFs(existingStr);
    const b = makeMemberFs(existingStr);
    await new ClaudeProvider().ensureWorkspaceTrusted(KEY, a.exec, 'windows', undefined, a.transport, TEST_HOME('windows', undefined));
    await new ClaudeProvider().ensureWorkspaceTrusted(KEY, b.exec, 'windows', undefined, b.transport, TEST_HOME('windows', undefined));
    const relA = a.transport.writes[0].relPath;
    const relB = b.transport.writes[0].relPath;
    expect(relA).not.toBe(relB);
    expect(a.calls[1]).toContain(relA);
    expect(b.calls[1]).toContain(relB);
  });
});

describe('workspaceTrustTransportFor', () => {
  it('is undefined for a relay member (relay transferFiles lands in the spoke sandbox, not home)', () => {
    const relay = makeTestAgent({ agentType: 'relay', relayMemberId: 'm1' } as any);
    const strat = getStrategy(makeTestAgent());
    expect(workspaceTrustTransportFor(relay, strat)).toBeUndefined();
  });

  it('local member: stages on this host and copies into the member home via the real LocalStrategy.transferFiles', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-499-home-'));
    try {
      vi.mocked(getMemberHomeDir).mockResolvedValue(fakeHome);
      const agent = makeTestLocalAgent({ llmProvider: 'claude', os: 'windows', workFolder: fakeHome });
      const transport = workspaceTrustTransportFor(agent, getStrategy(agent))!;
      const content = JSON.stringify({ projects: { [KEY]: { history: 'y'.repeat(90 * 1024) } } }, null, 2);
      const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync');

      await transport.writeHomeFile!('.claude.json.fleet-trust-1-abc.tmp', content);

      const landed = fs.readFileSync(path.join(fakeHome, '.claude.json.fleet-trust-1-abc.tmp'));
      expect(landed.toString('utf8')).toBe(content);
      expect(landed.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      // THIS call's staging dir is cleaned up (not a scan of the shared tmpdir,
      // which parallel workers also use).
      expect(mkdtempSpy).toHaveBeenCalledTimes(1);
      const staging = mkdtempSpy.mock.results[0].value as string;
      expect(path.basename(staging)).toMatch(/^apra-fleet-trust-/);
      expect(fs.existsSync(staging)).toBe(false);
      mkdtempSpy.mockRestore();
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('remote member: hands the staged file to strategy.transferFiles with the probed home as destination', async () => {
    vi.mocked(getMemberHomeDir).mockResolvedValue('C:\\Users\\member');
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'windows', workFolder: 'C:\\work\\p' });
    const seen: Array<{ paths: string[]; dest?: string; content: string }> = [];
    const strat = {
      transferFiles: vi.fn(async (paths: string[], dest?: string) => {
        seen.push({ paths, dest, content: fs.readFileSync(paths[0], 'utf8') });
        return { success: [path.basename(paths[0])], failed: [] };
      }),
    } as any;

    await workspaceTrustTransportFor(agent, strat)!.writeHomeFile!('.claude.json.fleet-trust-tmp', '{"a":1}');

    expect(seen).toHaveLength(1);
    expect(seen[0].dest).toBe('C:\\Users\\member');
    expect(path.basename(seen[0].paths[0])).toBe('.claude.json.fleet-trust-tmp');
    expect(seen[0].content).toBe('{"a":1}');
    expect(fs.existsSync(seen[0].paths[0])).toBe(false);
  });

  it('remote gitbash Windows member: an MSYS home (/c/Users/member) is handed to transferFiles as C:/Users/member', async () => {
    vi.mocked(getMemberHomeDir).mockResolvedValue('/c/Users/member');
    const agent = makeTestAgent({ llmProvider: 'claude', os: 'windows', shell: 'gitbash', workFolder: 'C:/work/p' } as any);
    const dests: Array<string | undefined> = [];
    const strat = { transferFiles: vi.fn(async (paths: string[], dest?: string) => { dests.push(dest); return { success: [path.basename(paths[0])], failed: [] }; }) } as any;

    await workspaceTrustTransportFor(agent, strat)!.writeHomeFile!('.claude.json.fleet-trust-1-abc.tmp', '{}');

    expect(dests).toEqual(['C:/Users/member']);
    // Non-Windows members and already-Windows spellings pass through untouched.
    expect(sftpHomePath('/home/member', 'linux')).toBe('/home/member');
    expect(sftpHomePath('C:\\Users\\member', 'windows')).toBe('C:\\Users\\member');
    expect(sftpHomePath('/d/Users/x', 'windows')).toBe('D:/Users/x');
  });

  it('remote member: a failed transfer or unknown home throws so the adapter can fall back', async () => {
    const agent = makeTestAgent({ llmProvider: 'claude' });
    vi.mocked(getMemberHomeDir).mockResolvedValue(null);
    await expect(workspaceTrustTransportFor(agent, { transferFiles: vi.fn() } as any)!.writeHomeFile!('f', 'c'))
      .rejects.toThrow(/home directory could not be resolved/);

    vi.mocked(getMemberHomeDir).mockResolvedValue('/home/member');
    const failing = { transferFiles: vi.fn(async () => ({ success: [], failed: [{ path: 'f', error: 'sftp: permission denied' }] })) } as any;
    await expect(workspaceTrustTransportFor(agent, failing)!.writeHomeFile!('f', 'c'))
      .rejects.toThrow(/sftp: permission denied/);
  });
});

describe('workspaceTrustStagingNames', () => {
  it('derives the staging-name token from a CSPRNG, not Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const a = workspaceTrustStagingNames();
      const b = workspaceTrustStagingNames();
      expect(a.tmpRel).toMatch(/^\.claude\.json\.fleet-trust-\d+-[a-f0-9]{8}\.tmp$/);
      expect(a.tmpRel).not.toBe(b.tmpRel);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
