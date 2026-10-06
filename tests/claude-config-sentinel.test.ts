/**
 * Sentinel scan (apra-fleet-b4g.101): the member's ~/.claude.json can hold other MCP
 * servers' headers/tokens and OAuth state. Its content must never appear in ANY exec
 * string sent to the member -- raw, base64, or inside a powershell -EncodedCommand
 * payload (UTF-16LE base64) -- on every OS/shell/channel combination. With no file
 * channel the write fails loudly instead of falling back inline.
 *
 * The seeded fixture carries a sentinel token inside another MCP server's headers.
 * Both writers are driven: ClaudeProvider.syncMemberMcpEntry (home-anchored or a
 * CLAUDE_CONFIG_DIR override) and ClaudeProvider.ensureWorkspaceTrusted.
 */

import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import type { MemberShell } from '../src/os/os-commands.js';
import type { MemberSecretFileChannel, WorkspaceTrustTransport } from '../src/providers/provider.js';
import type { SSHExecResult } from '../src/types.js';
import { makeTestAgent } from './test-helpers.js';

const SENTINEL = 'SENTINEL-TOKEN-7f3a9c1e-do-not-leak';

const SEED = JSON.stringify({
  numStartups: 3,
  mcpServers: {
    'other-server': { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${SENTINEL}` } },
  },
  projects: {},
}, null, 2);

/** Every way the sentinel could be hidden in a command string. */
export function findSentinel(command: string, sentinel = SENTINEL): string | null {
  const raw = command;
  if (raw.includes(sentinel)) return 'raw';
  const decodeCandidates = (b64: string): Array<[string, string]> => {
    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return []; }
    return [['base64-utf8', buf.toString('utf8')], ['base64-utf16le', buf.toString('utf16le')]];
  };
  // Every base64-looking run, decoded both ways (a UTF-8-only decode would miss UTF-16LE).
  for (const run of command.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    for (const [how, text] of decodeCandidates(run)) if (text.includes(sentinel)) return how;
  }
  // Every -EncodedCommand payload, decoded as UTF-16LE (and, belt and braces, UTF-8).
  for (const m of command.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/gi)) {
    for (const [how, text] of decodeCandidates(m[1])) if (text.includes(sentinel)) return `encoded-command(${how})`;
  }
  return null;
}

describe('sentinel scanner negative controls', () => {
  it('finds the sentinel raw', () => {
    expect(findSentinel(`echo ${SENTINEL}`)).toBe('raw');
  });
  it('finds the sentinel in a UTF-8 base64 run', () => {
    const b64 = Buffer.from(`{"h":"${SENTINEL}"}`, 'utf8').toString('base64');
    expect(findSentinel(`printf '%s' '${b64}' > f`)).toBe('base64-utf8');
  });
  it('finds a sentinel planted in a UTF-16LE -EncodedCommand payload (a UTF-8-only decode would miss it)', () => {
    const payload = Buffer.from(`Write-Output '${SENTINEL}'`, 'utf16le').toString('base64');
    const cmd = `powershell -EncodedCommand ${payload}`;
    expect(Buffer.from(payload, 'base64').toString('utf8').includes(SENTINEL)).toBe(false);
    expect(findSentinel(cmd)).not.toBeNull();
    expect(findSentinel(cmd)).toMatch(/utf16le/);
  });
  it('a clean command has no finding', () => {
    expect(findSentinel('mv "/home/m/.claude.json.tmp" "/home/m/.claude.json"')).toBeNull();
    expect(findSentinel(`powershell -EncodedCommand ${Buffer.from('Get-Date', 'utf16le').toString('base64')}`)).toBeNull();
  });
});

interface Flavour { name: string; agentOs: 'linux' | 'windows'; shell?: MemberShell; home: string; otherDir: string; posix: boolean }
const FLAVOURS: Flavour[] = [
  { name: 'windows/powershell', agentOs: 'windows', shell: 'powershell5', home: 'C:\\Users\\member', otherDir: 'D:\\cfg', posix: false },
  { name: 'windows/gitbash', agentOs: 'windows', shell: 'gitbash', home: '/c/Users/member', otherDir: '/d/cfg', posix: true },
  { name: 'posix', agentOs: 'linux', home: '/home/member', otherDir: '/srv/cfg', posix: true },
];

/** A member whose shell answers reads with the seeded file and records EVERY command. */
function fakeMember(f: Flavour, configDirOverride: boolean) {
  const commands: string[] = [];
  const exec = async (cmd: string): Promise<SSHExecResult> => {
    commands.push(cmd);
    const decoded = cmd.includes('-EncodedCommand')
      ? Buffer.from(cmd.split('-EncodedCommand ')[1].trim(), 'base64').toString('utf16le')
      : cmd;
    if (decoded.includes('CLAUDE_CONFIG_DIR')) {
      return { stdout: configDirOverride ? f.otherDir : '', stderr: '', code: 0 };
    }
    if (/^(?:if test -e|if \(Test-Path)/.test(cmd)) return { stdout: SEED, stderr: '', code: 0 };
    if (/^(?:cat "|Get-Content -Raw ")/.test(cmd)) return { stdout: `${SEED}\n---FLEET_MCP_SPLIT---\n`, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const staged: string[] = [];
  const transport: WorkspaceTrustTransport = { writeHomeFile: async (_rel, content) => { staged.push(content); } };
  const secret: MemberSecretFileChannel = {
    write: async (content) => { staged.push(content); return `${f.home}${f.posix ? '/' : '\\'}.apra-fleet-secret-1`; },
    remove: async () => undefined,
  };
  return { commands, exec, transport, secret, staged };
}

const NO_CHANNEL = /E-MEMBER-CONFIG-NO-FILE-CHANNEL/;

describe('no member exec carries ~/.claude.json content, under any encoding', () => {
  for (const f of FLAVOURS) {
    for (const hasTransport of [true, false]) {
      for (const hasSecret of [true, false]) {
        for (const anchored of [true, false]) {
          const label = `${f.name} | sftp=${hasTransport ? 'yes' : 'no'} | secret-file=${hasSecret ? 'yes' : 'no'} | ${anchored ? 'home-anchored' : 'CLAUDE_CONFIG_DIR override'}`;
          it(`syncMemberMcpEntry: ${label}`, async () => {
            const m = fakeMember(f, !anchored);
            const agent = makeTestAgent({ llmProvider: 'claude', os: f.agentOs, shell: f.shell, workFolder: f.posix ? '/work/repo' : 'C:\\work\\repo' } as any);
            const run = new ClaudeProvider().syncMemberMcpEntry({
              agent, execCommand: m.exec, memberHomeDir: f.home, agentOs: f.agentOs, shell: f.shell,
              transport: hasTransport ? m.transport : undefined,
              secretChannel: hasSecret ? m.secret : undefined,
              url: 'http://localhost:7523/mcp?member=abc',
            });
            // A CLAUDE_CONFIG_DIR override is not home-anchored, so it bypasses the home file
            // channel: only the secret file can carry it. With no usable channel the write
            // must fail loudly rather than go inline.
            const channelAvailable = (hasTransport && anchored) || hasSecret;
            if (channelAvailable) {
              await run;
              expect(m.staged.length).toBe(1);
              expect(m.staged[0]).toContain(SENTINEL); // the staged FILE has it; no command does
            } else {
              await expect(run).rejects.toThrow(NO_CHANNEL);
            }
            for (const c of m.commands) expect(findSentinel(c), `${label}: ${c.slice(0, 120)}`).toBeNull();
          });
        }
      }
    }

    for (const hasTransport of [true, false]) {
      for (const hasSecret of [true, false]) {
        const label = `${f.name} | sftp=${hasTransport ? 'yes' : 'no'} | secret-file=${hasSecret ? 'yes' : 'no'}`;
        it(`ensureWorkspaceTrusted: ${label}`, async () => {
          const m = fakeMember(f, false);
          const folder = f.posix ? '/work/repo' : 'C:\\work\\repo';
          const run = new ClaudeProvider().ensureWorkspaceTrusted(
            folder, m.exec, f.agentOs, f.shell, hasTransport ? m.transport : undefined, f.home, hasSecret ? m.secret : undefined,
          );
          if (hasTransport || hasSecret) {
            const r = await run;
            expect(r.seeded).toBe(true);
            expect(m.staged.length).toBe(1);
            expect(m.staged[0]).toContain(SENTINEL);
          } else {
            await expect(run).rejects.toThrow(NO_CHANNEL);
          }
          for (const c of m.commands) expect(findSentinel(c), `${label}: ${c.slice(0, 120)}`).toBeNull();
        });
      }
    }
  }
});
