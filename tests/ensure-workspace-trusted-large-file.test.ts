/**
 * Regression tests for GitHub #499: ensureWorkspaceTrusted used to embed the ENTIRE
 * merged ~/.claude.json in one command string (`WriteAllText(..., '<84 KB>')` /
 * `bash -c '<heredoc>'`). On a Windows host that command line exceeds the
 * CreateProcess limit (32767 chars; cmd.exe 8191) and the spawn fails with
 * ENAMETOOLONG, so trust was never seeded.
 *
 * Covers:
 * - a >80 KB ~/.claude.json is delivered to a Windows PowerShell member in base64
 *   chunks, no single command over the limit, and the file lands byte-identical
 * - the same for a gitbash Windows member (bash.exe -c is still one CreateProcess)
 * - the non-Windows POSIX heredoc path is unchanged
 * - the out-of-band file channel (transport.writeHomeFile: node:fs locally, SFTP
 *   over SSH) is preferred when present, leaving only a tiny Move-Item on the
 *   command line -- and its failure falls back to chunked delivery
 * - small files keep the single-exec command they always had
 * - a failing chunk surfaces a specific error (non-fatal contract is the caller's)
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
import { ClaudeProvider, buildChunkedTrustWriteCommands, WORKSPACE_TRUST_MAX_COMMAND_CHARS } from '../src/providers/claude.js';
import type { WorkspaceTrustTransport } from '../src/providers/provider.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/member-home.js', () => ({
  getMemberHomeDir: vi.fn(),
}));
import { getMemberHomeDir } from '../src/services/member-home.js';
import { workspaceTrustTransportFor } from '../src/utils/workspace-trust.js';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';

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
 * (`$env:USERPROFILE\.claude.json`, `$HOME/.claude.json`, ...). Interprets every
 * command shape ensureWorkspaceTrusted can emit, in both shell flavours, so a
 * test can assert on the FINAL file content rather than on command text.
 */
function makeMemberFs(initialHome: string | null, posixFlavour = false) {
  const files = new Map<string, string>();
  if (initialHome !== null) {
    files.set('$env:USERPROFILE\\.claude.json', initialHome);
    files.set('$HOME/.claude.json', initialHome);
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

    // --- PowerShell single write ---
    if ((m = cmd.match(/^\[System\.IO\.File\]::WriteAllText\("([^"]+)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\); Move-Item -Force "([^"]+)" "([^"]+)"$/))) {
      files.set(m[4], m[2].replace(/''/g, "'"));
      return { stdout: '', stderr: '', code: 0 };
    }
    // --- PowerShell base64 chunks ---
    if ((m = cmd.match(/^\[System\.IO\.File\]::(WriteAllText|AppendAllText)\("([^"]+)", '([A-Za-z0-9+/=]*)'\)$/))) {
      files.set(m[2], (m[1] === 'WriteAllText' ? '' : (files.get(m[2]) ?? '')) + m[3]);
      return { stdout: '', stderr: '', code: 0 };
    }
    if ((m = cmd.match(/^\[System\.IO\.File\]::WriteAllBytes\("([^"]+)", \[System\.Convert\]::FromBase64String\(\[System\.IO\.File\]::ReadAllText\("([^"]+)"\)\)\); Remove-Item -Force "([^"]+)"; Move-Item -Force "([^"]+)" "([^"]+)"$/))) {
      const decoded = Buffer.from(files.get(m[2]) ?? '', 'base64').toString('utf8');
      files.delete(m[3]);
      files.set(m[5], decoded);
      return { stdout: '', stderr: '', code: 0 };
    }
    // --- PowerShell move only (file channel) ---
    if ((m = cmd.match(/^Move-Item -Force "([^"]+)" "([^"]+)"$/))) {
      if (!files.has(m[1])) return { stdout: '', stderr: `Cannot find path '${m[1]}'`, code: 1 };
      files.set(m[2], files.get(m[1])!);
      files.delete(m[1]);
      return { stdout: '', stderr: '', code: 0 };
    }

    // --- POSIX heredoc ---
    if ((m = cmd.match(/^cat > "([^"]+)" << 'FLEET_TRUST_EOF'\n([\s\S]*)\nFLEET_TRUST_EOF\nmv "([^"]+)" "([^"]+)"$/))) {
      files.set(m[4], m[2]);
      return { stdout: '', stderr: '', code: 0 };
    }
    // --- POSIX base64 chunks ---
    if ((m = cmd.match(/^printf '%s' '([A-Za-z0-9+/=]*)' (>>?) "([^"]+)"$/))) {
      files.set(m[3], (m[2] === '>' ? '' : (files.get(m[3]) ?? '')) + m[1]);
      return { stdout: '', stderr: '', code: 0 };
    }
    if ((m = cmd.match(/^base64 -d "([^"]+)" > "([^"]+)" && rm -f "([^"]+)" && mv "([^"]+)" "([^"]+)"$/))) {
      const decoded = Buffer.from(files.get(m[1]) ?? '', 'base64').toString('utf8');
      files.delete(m[3]);
      files.set(m[5], decoded);
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

  /** transport.writeHomeFile fake: stages under BOTH path spellings so either
   *  shell flavour's Move-Item/mv finds it. */
  const transport: WorkspaceTrustTransport & { writes: Array<{ relPath: string; content: string }> } = {
    writes: [],
    writeHomeFile: async (relPath, content) => {
      transport.writes.push({ relPath, content });
      // Stage under the spelling the member's shell flavour will look for.
      files.set(posixFlavour ? `$HOME/${relPath}` : `$env:USERPROFILE\\${relPath}`, content);
    },
  };

  return {
    exec,
    calls,
    files,
    transport,
    home: (posix: boolean) => files.get(posix ? '$HOME/.claude.json' : '$env:USERPROFILE\\.claude.json'),
    leftovers: () => [...files.keys()].filter(k => k.includes('fleet-trust')),
  };
}

describe('ensureWorkspaceTrusted with a >80 KB ~/.claude.json (GitHub #499)', () => {
  const existing = makeLargeClaudeJson();
  const existingStr = JSON.stringify(existing, null, 2);
  const expected = expectedMerged(existing, KEY);

  it('fixture really is over the Windows command-line limit', () => {
    expect(existingStr.length).toBeGreaterThan(80 * 1024);
    expect(expected.length).toBeGreaterThan(HARD_LIMIT);
  });

  it('Windows PowerShell member, exec only: chunked delivery, every command under the limit, content byte-identical', async () => {
    const member = makeMemberFs(existingStr);
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', 'powershell5');

    expect(result.seeded).toBe(true);
    expect(member.calls.length).toBeGreaterThan(3);
    for (const c of member.calls) {
      expect(c.length).toBeLessThanOrEqual(WORKSPACE_TRUST_MAX_COMMAND_CHARS);
      expect(c.length).toBeLessThan(HARD_LIMIT);
    }
    expect(member.calls.some(c => c.includes('FromBase64String'))).toBe(true);
    expect(member.home(false)).toBe(expected);
    expect(member.home(false)!.charCodeAt(0)).not.toBe(0xfeff);
    expect(member.leftovers()).toEqual([]);
  });

  it('gitbash Windows member, exec only: chunked POSIX delivery (bash.exe -c is one CreateProcess too)', async () => {
    const member = makeMemberFs(existingStr);
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', 'gitbash');

    expect(result.seeded).toBe(true);
    for (const c of member.calls) {
      expect(c.length).toBeLessThanOrEqual(WORKSPACE_TRUST_MAX_COMMAND_CHARS);
      expect(c).not.toMatch(/Get-Content|WriteAllText|Move-Item/);
    }
    expect(member.calls.some(c => c.startsWith('base64 -d'))).toBe(true);
    expect(member.home(true)).toBe(expected);
    expect(member.leftovers()).toEqual([]);
  });

  it('Linux member: the heredoc path is unchanged (one read, one write) even for a large file', async () => {
    const member = makeMemberFs(existingStr);
    const linuxKey = '/home/member/work/project-a';
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(linuxKey, member.exec, 'linux');

    expect(result.seeded).toBe(true);
    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toContain("<< 'FLEET_TRUST_EOF'");
    expect(member.home(true)).toBe(expectedMerged(existing, linuxKey));
  });

  it('Windows member with a file channel (local node:fs / remote SFTP): content never rides a command line', async () => {
    const member = makeMemberFs(existingStr);
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, member.transport);

    expect(result.seeded).toBe(true);
    expect(member.transport.writes).toHaveLength(1);
    expect(member.transport.writes[0].relPath).toBe('.claude.json.fleet-trust-tmp');
    expect(member.transport.writes[0].content).toBe(expected);
    // read + one tiny move; nothing else
    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toMatch(/^Move-Item -Force "\$env:USERPROFILE\\\.claude\.json\.fleet-trust-tmp" "\$env:USERPROFILE\\\.claude\.json"$/);
    expect(member.calls[1].length).toBeLessThan(200);
    expect(member.home(false)).toBe(expected);
    expect(member.leftovers()).toEqual([]);
  });

  it('gitbash Windows member with a file channel: POSIX mv, nothing else on the command line', async () => {
    const member = makeMemberFs(existingStr, true);
    await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', 'gitbash', member.transport);

    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toBe('mv "$HOME/.claude.json.fleet-trust-tmp" "$HOME/.claude.json"');
    expect(member.home(true)).toBe(expected);
  });

  it('a failing file channel falls back to chunked exec delivery and still lands the file', async () => {
    const member = makeMemberFs(existingStr);
    const broken: WorkspaceTrustTransport = { writeHomeFile: async () => { throw new Error('sftp subsystem disabled'); } };
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, broken);

    expect(result.seeded).toBe(true);
    expect(member.calls.some(c => c.includes('FromBase64String'))).toBe(true);
    for (const c of member.calls) expect(c.length).toBeLessThanOrEqual(WORKSPACE_TRUST_MAX_COMMAND_CHARS);
    expect(member.home(false)).toBe(expected);
  });

  it('a file channel whose move step fails also falls back to chunked delivery', async () => {
    const member = makeMemberFs(existingStr);
    // Stages nothing, so the Move-Item exits 1.
    const silent: WorkspaceTrustTransport = { writeHomeFile: async () => undefined };
    const result = await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows', undefined, silent);

    expect(result.seeded).toBe(true);
    expect(member.home(false)).toBe(expected);
  });

  it('a small ~/.claude.json on Windows keeps the single WriteAllText+Move-Item command (unchanged behaviour)', async () => {
    const small = JSON.stringify({ projects: { [KEY]: { allowedTools: ["it's"] } } }, null, 2);
    const member = makeMemberFs(small);
    await new ClaudeProvider().ensureWorkspaceTrusted(KEY, member.exec, 'windows');

    expect(member.calls).toHaveLength(2);
    expect(member.calls[1]).toMatch(/^\[System\.IO\.File\]::WriteAllText\(.*Move-Item -Force/s);
    expect(member.home(false)).toBe(expectedMerged(JSON.parse(small), KEY));
  });

  it('a failing chunk surfaces a specific error (the caller keeps it non-fatal)', async () => {
    const member = makeMemberFs(existingStr);
    const flaky = vi.fn(async (cmd: string): Promise<SSHExecResult> => {
      if (cmd.includes('AppendAllText')) return { stdout: '', stderr: 'Access to the path is denied.', code: 1 };
      return member.exec(cmd);
    });
    await expect(new ClaudeProvider().ensureWorkspaceTrusted(KEY, flaky, 'windows'))
      .rejects.toThrow(/chunked write of ~\/\.claude\.json failed on a Windows member \(exit 1.*Access to the path is denied/);
  });
});

describe('buildChunkedTrustWriteCommands', () => {
  it('splits an 84 KB payload into commands that each stay under the limit and round-trip exactly', () => {
    const payload = JSON.stringify({ blob: 'a"b\'c\\d'.repeat(84 * 1024 / 8) });
    for (const posix of [false, true]) {
      const cmds = buildChunkedTrustWriteCommands(payload, {
        posix, homeFile: 'H', tmpFile: 'T', b64File: 'B',
      });
      const max = Math.max(...cmds.map(c => c.length));
      expect(max).toBeLessThanOrEqual(WORKSPACE_TRUST_MAX_COMMAND_CHARS);
      expect(cmds.length).toBeGreaterThan(payload.length / WORKSPACE_TRUST_MAX_COMMAND_CHARS);
      const b64 = cmds.slice(0, -1).map(c => c.match(/'([A-Za-z0-9+/=]*)'/)![1]).join('');
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(payload);
    }
  });

  it('honours a custom chunk size and always emits a final decode+move step', () => {
    const cmds = buildChunkedTrustWriteCommands('x'.repeat(100), { posix: false, homeFile: 'H', tmpFile: 'T', b64File: 'B', chunkChars: 16 });
    expect(cmds.length).toBe(Math.ceil(Buffer.from('x'.repeat(100)).toString('base64').length / 16) + 1);
    expect(cmds[0]).toContain('WriteAllText("B"');
    expect(cmds[1]).toContain('AppendAllText("B"');
    expect(cmds[cmds.length - 1]).toContain('Move-Item -Force "T" "H"');
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

      await transport.writeHomeFile!('.claude.json.fleet-trust-tmp', content);

      const landed = fs.readFileSync(path.join(fakeHome, '.claude.json.fleet-trust-tmp'));
      expect(landed.toString('utf8')).toBe(content);
      expect(landed.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      // staging dir cleaned up
      const stale = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('apra-fleet-trust-'));
      expect(stale).toEqual([]);
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
