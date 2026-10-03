import { describe, it, expect } from 'vitest';
import { ClaudeProvider, claudeMemberMcpEntry, isClaudeMemberMcpEntry } from '../src/providers/claude.js';
import { LinuxCommands } from '../src/os/linux.js';
import { WindowsCommands } from '../src/os/windows.js';
import type { PromptOptions } from '../src/providers/provider.js';

// A dispatched `claude -p` session reaches the member's kb_*/code_* tools only
// through the per-folder LOCAL-scope apra-fleet entry. Two things must hold on
// every OS for that to work:
//   1. the dispatch argv never switches off configured MCP servers or filters
//      MCP tools out (--bare / CLAUDE_CODE_SIMPLE, --strict-mcp-config,
//      --disallowedTools mcp__*, an --agent/--tools restriction it did not ask for);
//   2. the entry itself loads at session start (alwaysLoad), because a deferred
//      server connects in the background after the first request is built.

const provider = new ClaudeProvider();
const MCP_HIDING = [/--bare\b/, /CLAUDE_CODE_SIMPLE/, /--strict-mcp-config/, /--disallowed-?[Tt]ools/, /--tools\b/, /--safe-mode/, /--restricted/, /ENABLE_TOOL_SEARCH/];

function assertNoMcpHiding(cmd: string): void {
  for (const re of MCP_HIDING) expect(cmd).not.toMatch(re);
}

const cases: Array<{ name: string; build: (o: PromptOptions) => string; folder: string }> = [
  { name: 'linux/macos (POSIX)', build: o => new LinuxCommands().buildAgentPromptCommand(provider, o), folder: '/home/u/repo' },
  { name: 'windows (PowerShell)', build: o => new WindowsCommands().buildAgentPromptCommand(provider, o), folder: 'C:\\Users\\u\\repo' },
];

describe('claude dispatch argv keeps configured MCP servers visible', () => {
  for (const c of cases) {
    for (const unattended of [false, 'auto', 'dangerous'] as const) {
      it(`${c.name}, unattended=${String(unattended)}: no flag that disables MCP or filters its tools`, () => {
        const cmd = c.build({
          folder: c.folder, promptFile: '.fleet-task.md', maxTurns: 50, sessionId: '550e8400-e29b-41d4-a716-446655440000',
          unattended, model: 'claude-sonnet-5', inv: 'inv-1',
        });
        expect(cmd).toContain('-p "');
        assertNoMcpHiding(cmd);
        // No subagent restriction unless the caller asked for one.
        expect(cmd).not.toContain('--agent');
      });
    }
  }
});

describe('claude member MCP entry loads at session start', () => {
  const url = 'http://localhost:7523/mcp?member=11111111-2222-3333-4444-555555555555';

  it('is {type: http, url, alwaysLoad: true} -- nothing else (no headers/credentials)', () => {
    expect(claudeMemberMcpEntry(url)).toEqual({ type: 'http', url, alwaysLoad: true });
  });

  it('an entry without alwaysLoad, with alwaysLoad false, another url, or extra keys is not current (compose rewrites it)', () => {
    expect(isClaudeMemberMcpEntry(claudeMemberMcpEntry(url), url)).toBe(true);
    expect(isClaudeMemberMcpEntry({ type: 'http', url }, url)).toBe(false);
    expect(isClaudeMemberMcpEntry({ type: 'http', url, alwaysLoad: false }, url)).toBe(false);
    expect(isClaudeMemberMcpEntry({ type: 'http', url: 'http://localhost:7523/mcp?member=other', alwaysLoad: true }, url)).toBe(false);
    expect(isClaudeMemberMcpEntry({ type: 'http', url, alwaysLoad: true, headers: { Authorization: 'x' } }, url)).toBe(false);
    expect(isClaudeMemberMcpEntry(undefined, url)).toBe(false);
  });

  it('keeps the ?member= scoping: the entry url is used verbatim', () => {
    expect(claudeMemberMcpEntry(url).url).toMatch(/\?member=[0-9a-f-]+$/);
  });
});
