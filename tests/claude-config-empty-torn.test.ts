/**
 * The two fleet writers of the member-side Claude config file
 * (ClaudeProvider.ensureWorkspaceTrusted and ClaudeProvider.syncMemberMcpEntry)
 * never replace a file they could not understand, and never lose a change
 * another program made between their read and their write.
 *
 * For a LOCAL member that file is the host user's own ~/.claude.json, which
 * Claude Code rewrites on its own. A read that catches it empty or torn
 * mid-rewrite used to parse as {} and the writer then replaced the whole file
 * with just the fleet keys, dropping install's user-scope mcpServers.apra-fleet
 * entry with everything else.
 *
 * For each writer, on a POSIX and a PowerShell member:
 *  (a) an existing EMPTY file -> E-MEMBER-CONFIG-NOT-JSON, no move, unchanged;
 *  (b) an existing TRUNCATED-JSON file -> the same;
 *  (c) a MISSING file -> seeded normally;
 *  (d) a change made between the first read and the write (user-scope
 *      mcpServers.apra-fleet plus an unrelated key) survives alongside the
 *      fleet change, because the writer re-reads right before the move.
 *
 * The member is an in-memory fake: no test here touches any real file.
 */

import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../src/providers/claude.js';
import { MEMBER_FILE_PRESENT_MARKER, memberMcpUrl, MEMBER_MCP_SERVER_NAME } from '../src/services/member-config-io.js';
import type { SSHExecResult } from '../src/types.js';
import type { MemberShell } from '../src/os/os-commands.js';
import { makeTestAgent } from './test-helpers.js';
import { parseLandingMove } from './helpers/landing-move.js';

const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', code: 0 });

interface ShellCase {
  name: string;
  agentOs: 'linux' | 'windows';
  shell?: MemberShell;
  home: string;
  workFolder: string;
}

const SHELLS: ShellCase[] = [
  { name: 'POSIX member', agentOs: 'linux', home: '/home/member', workFolder: '/home/member/work/project-a' },
  { name: 'PowerShell member', agentOs: 'windows', shell: 'powershell5', home: 'C:\\Users\\member', workFolder: 'C:/Users/member/work/project-a' },
];

/** A member holding one Claude config file in memory. `content` null = missing.
 *  `concurrent`, when set, replaces the file right before the SECOND read of
 *  it (Claude Code rewriting the file between the writer's read and write). */
function fakeMember(initial: string | null, concurrent?: string) {
  let content: string | null = initial;
  let staged: string | null = null;
  let configReads = 0;
  const commands: string[] = [];
  const moves: string[] = [];

  const readConfig = (): string => {
    configReads++;
    if (configReads === 2 && concurrent !== undefined) content = concurrent;
    return content ?? '';
  };

  const exec = async (cmd: string): Promise<SSHExecResult> => {
    commands.push(cmd);
    // Presence probe (positive marker) used after an empty read.
    if (cmd.includes(MEMBER_FILE_PRESENT_MARKER)) return ok(content !== null ? MEMBER_FILE_PRESENT_MARKER : '');
    // Trust seeding's combined read: ~/.claude.json, split marker, .mcp.json (none here).
    if (cmd.includes('FLEET_MCP_SPLIT')) return ok(`${readConfig()}\n---FLEET_MCP_SPLIT---\n`);
    // syncMemberMcpEntry's read (readMemberFileCommand).
    if (/^if test -e "[^"]+"; then cat "[^"]+"; fi$/.test(cmd) || /^if \(Test-Path -LiteralPath "[^"]+"\) \{ Get-Content/.test(cmd)) {
      return ok(readConfig());
    }
    // Repository-root probe: not a git repo, so the key is the work folder.
    if (cmd.startsWith('git -C ')) return { stdout: '', stderr: 'fatal: not a git repository', code: 128 };
    // Content-free move of the staged file over the config.
    if (parseLandingMove(cmd)) {
      moves.push(cmd);
      if (staged === null) return { stdout: '', stderr: 'nothing staged', code: 1 };
      content = staged;
      staged = null;
      return ok();
    }
    // CLAUDE_CONFIG_DIR probe (unset) and anything else.
    return ok();
  };
  const transport = { writeHomeFile: async (_rel: string, c: string) => { staged = c; } };
  return { exec, transport, commands, moves, file: () => content, reads: () => configReads };
}

const projectKey = (sc: ShellCase) => sc.workFolder.replace(/\\/g, '/').replace(/\/+$/, '');

interface Writer {
  name: string;
  run(sc: ShellCase, m: ReturnType<typeof fakeMember>): Promise<unknown>;
  /** Asserts the fleet's own change is present in the parsed final file. */
  expectFleetChange(sc: ShellCase, config: any): void;
}

function agentFor(sc: ShellCase) {
  return makeTestAgent({ llmProvider: 'claude', agentType: 'local', os: sc.agentOs, workFolder: sc.workFolder, ...(sc.shell ? { shell: sc.shell } : {}) } as any);
}

const WRITERS: Writer[] = [
  {
    name: 'ensureWorkspaceTrusted',
    run: (sc, m) => new ClaudeProvider().ensureWorkspaceTrusted(sc.workFolder, m.exec, sc.agentOs, sc.shell, m.transport, sc.home),
    expectFleetChange: (sc, config) => {
      expect(config.projects[projectKey(sc)].hasTrustDialogAccepted).toBe(true);
    },
  },
  {
    name: 'syncMemberMcpEntry',
    run: (sc, m) => {
      const agent = agentFor(sc);
      return new ClaudeProvider().syncMemberMcpEntry({
        agent, execCommand: m.exec, memberHomeDir: sc.home, agentOs: sc.agentOs, shell: sc.shell, transport: m.transport, url: memberMcpUrl(agent),
      } as any);
    },
    expectFleetChange: (sc, config) => {
      const entry = config.projects[projectKey(sc)].mcpServers[MEMBER_MCP_SERVER_NAME];
      expect(entry.type).toBe('http');
      expect(entry.url).toMatch(/\/mcp\?member=/);
    },
  },
];

for (const writer of WRITERS) {
  for (const sc of SHELLS) {
    describe(`${writer.name} on a ${sc.name}`, () => {
      it('(a) an existing EMPTY file is refused with E-MEMBER-CONFIG-NOT-JSON; no move, file unchanged', async () => {
        const m = fakeMember('');
        await expect(writer.run(sc, m)).rejects.toThrow(/E-MEMBER-CONFIG-NOT-JSON/);
        expect(m.moves).toEqual([]);
        expect(m.file()).toBe('');
      });

      it('(b) an existing TRUNCATED-JSON file is refused with E-MEMBER-CONFIG-NOT-JSON; no move, file unchanged', async () => {
        const torn = '{"numStartups": 3, "mcpServers": {"apra-fleet": {"type": "ht';
        const m = fakeMember(torn);
        await expect(writer.run(sc, m)).rejects.toThrow(/E-MEMBER-CONFIG-NOT-JSON/);
        expect(m.moves).toEqual([]);
        expect(m.file()).toBe(torn);
      });

      it('(c) a MISSING file is seeded with the fleet change', async () => {
        const m = fakeMember(null);
        await writer.run(sc, m);
        expect(m.moves).toHaveLength(1);
        writer.expectFleetChange(sc, JSON.parse(m.file()!));
      });

      it('(d) a change made between the first read and the write survives alongside the fleet change', async () => {
        const original = { numStartups: 3, projects: {} };
        const userEntry = { type: 'http', url: 'http://localhost:4545/mcp', headers: { 'X-Apra-Fleet-Member-Secret': 'user-scope' } };
        const concurrent = { ...original, mcpServers: { [MEMBER_MCP_SERVER_NAME]: userEntry }, unrelatedTopLevelKey: { kept: true } };
        const m = fakeMember(JSON.stringify(original), JSON.stringify(concurrent));

        await writer.run(sc, m);

        expect(m.moves).toHaveLength(1);
        const final = JSON.parse(m.file()!);
        expect(final.mcpServers?.[MEMBER_MCP_SERVER_NAME]).toEqual(userEntry);
        expect(final.unrelatedTopLevelKey).toEqual({ kept: true });
        expect(final.numStartups).toBe(3);
        writer.expectFleetChange(sc, final);
        // The writer read the file twice: once to decide, once right before the move.
        expect(m.reads()).toBe(2);
      });
    });
  }
}
