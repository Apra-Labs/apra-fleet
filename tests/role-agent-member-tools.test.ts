import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  transformAgentForClaude,
  transformAgentForAgy,
  transformAgentForOpenCode,
  memberMcpToolGrants,
} from '../src/cli/agent-transform.js';
import { loadCanonicalAgentSet, rolesMissingMemberToolGrant, checkRoleAgentMemberTools } from '../src/services/agent-provisioner.js';
import { MEMBER_DENIED_TOOLS } from '../src/services/member-tool-allowlist.js';
import { LinuxCommands } from '../src/os/linux.js';
import { WindowsCommands } from '../src/os/windows.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';

// Sprint roles are dispatched as `claude --agent <role>` (execute_prompt's
// `agent`), and an agent's `tools:` frontmatter is an allowlist for the whole
// session. A role list without mcp__ entries hides the member's kb_*/code_*
// tools even though its apra-fleet server is connected -- every sprint
// dispatch then ran with 0 kb/code calls.

const AGENTS_DIR = path.join(__dirname, '..', 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
const roleFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
const read = (f: string) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8').replace(/\r\n/g, '\n');
const toolsLine = (content: string) => content.match(/^---\n[\s\S]*?^tools:\s*(.+)$/m)?.[1] ?? null;

describe('claude role transform grants the member MCP tools', () => {
  it('the grant set is exactly the registered kb_*/code_* tools, in mcp__apra-fleet__<tool> form', () => {
    const grants = memberMcpToolGrants();
    expect(grants).toContain('mcp__apra-fleet__kb_query');
    expect(grants).toContain('mcp__apra-fleet__code_context');
    for (const g of grants) expect(g).toMatch(/^mcp__apra-fleet__(kb|code)_[a-z_]+$/);
  });

  it('the source role files reproduce the bug: restrictive tools lists with no member tools', () => {
    const raw = roleFiles.map(f => ({ relPath: f, content: read(f) }));
    expect(rolesMissingMemberToolGrant(raw)).toEqual(expect.arrayContaining(['doer.md', 'reviewer.md', 'planner.md']));
  });

  for (const f of roleFiles) {
    it(`${f}: every member kb_*/code_* tool is granted, nothing outside the member allowlist is`, () => {
      const out = transformAgentForClaude(read(f), f);
      const line = toolsLine(out);
      if (line === null) return; // no list: inherits every tool already
      for (const g of memberMcpToolGrants()) expect(line).toContain(g);
      // Exact names only: never the server-level pattern (a role run as a local
      // subagent of an orchestrator reaches the FULL fleet server).
      expect(line).not.toMatch(/mcp__apra-fleet(?:__\*)?\s*(?:,|\])/);
      for (const denied of MEMBER_DENIED_TOOLS) expect(line).not.toContain(`mcp__apra-fleet__${denied},`);
      for (const denied of MEMBER_DENIED_TOOLS) expect(line).not.toContain(`mcp__apra-fleet__${denied}]`);
      // The role's own built-in tools survive, in order, ahead of the grants.
      const before = toolsLine(read(f))!.replace(/^\[|\]$/g, '').split(',').map(t => t.trim());
      expect(line.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).slice(0, before.length)).toEqual(before);
    });
  }

  it('is idempotent and leaves no-tools / wildcard files untouched', () => {
    const once = transformAgentForClaude(read('doer.md'), 'doer.md');
    expect(transformAgentForClaude(once, 'doer.md')).toBe(once);
    const none = '---\nname: x\ndescription: y\n---\n\nbody\n';
    expect(transformAgentForClaude(none, 'x.md')).toBe(none);
    const wild = '---\nname: x\ndescription: y\ntools: [*]\n---\n\nbody\n';
    expect(transformAgentForClaude(wild, 'x.md')).toBe(wild);
  });

  it('agy and opencode transforms carry no apra-fleet MCP grant (no per-tool MCP allowlist there)', () => {
    for (const f of roleFiles) {
      expect(transformAgentForAgy(read(f), f)).not.toContain('mcp__apra-fleet');
      expect(transformAgentForOpenCode(read(f), f)).not.toContain('mcp__apra-fleet');
    }
  });

  it('the canonical claude set provisioned to members grants the tools in every restrictive role', () => {
    expect(rolesMissingMemberToolGrant(loadCanonicalAgentSet('claude'))).toEqual([]);
  });
});

describe('a dispatched sprint role session includes the member MCP tools', () => {
  const provider = new ClaudeProvider();
  const cases = [
    { name: 'POSIX', cmd: () => new LinuxCommands().buildAgentPromptCommand(provider, { folder: '/home/u/repo', promptFile: '.fleet-task.md', agentName: 'doer' }) },
    { name: 'PowerShell', cmd: () => new WindowsCommands().buildAgentPromptCommand(provider, { folder: 'C:\\Users\\u\\repo', promptFile: '.fleet-task.md', agentName: 'doer' }) },
  ];
  for (const c of cases) {
    it(`${c.name}: --agent "doer" loads a definition whose tools allowlist includes kb_query and code_context`, () => {
      expect(c.cmd()).toContain('--agent "doer"');
      const doer = loadCanonicalAgentSet('claude').find(f => f.relPath === 'doer.md')!;
      const line = toolsLine(doer.content)!;
      expect(line).toContain('mcp__apra-fleet__kb_query');
      expect(line).toContain('mcp__apra-fleet__code_context');
      // No flag on the dispatch hides MCP on top of the allowlist.
      for (const re of [/--bare\b/, /--strict-mcp-config/, /--disallowed-?[Tt]ools/, /--tools\b/]) expect(c.cmd()).not.toMatch(re);
    });
  }
});

describe('member-init role check (checkRoleAgentMemberTools), local member', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function homeWith(files: Record<string, string>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'role-tools-'));
    dirs.push(home);
    const agents = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(agents, n), c);
    return home;
  }

  it('installed role files from before the fix -> fails loudly, naming them', async () => {
    const home = homeWith({ 'doer.md': read('doer.md'), 'reviewer.md': read('reviewer.md') });
    const r = await checkRoleAgentMemberTools(makeTestLocalAgent({ llmProvider: 'claude' }), home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/doer\.md.*reviewer\.md|reviewer\.md.*doer\.md/);
  });

  it('installed role files from the current transform -> ok', async () => {
    const home = homeWith({
      'doer.md': transformAgentForClaude(read('doer.md'), 'doer.md'),
      'reviewer.md': transformAgentForClaude(read('reviewer.md'), 'reviewer.md'),
    });
    expect(await checkRoleAgentMemberTools(makeTestLocalAgent({ llmProvider: 'claude' }), home)).toEqual({ ok: true });
  });

  it('non-claude members are not subject to the claude --agent allowlist', async () => {
    expect(await checkRoleAgentMemberTools(makeTestAgent({ llmProvider: 'opencode' }))).toEqual({ ok: true });
  });
});
