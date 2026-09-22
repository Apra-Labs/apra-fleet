import { describe, it, expect, vi } from 'vitest';
import { loadAgentAssets } from '../src/cli/install.js';
import {
  transformAgentForAgy,
  transformAgentForOpenCode,
  transformAgentForClaude,
  OPENCODE_NATIVE_TOOLS,
} from '../src/cli/agent-transform.js';

/**
 * Closes the loop on the parent bug: a transformed role prompt must never reference a
 * tool that the same transform removed from its own frontmatter -- in body text OR
 * frontmatter. Dropping the tools line entry while leaving the prose that says to call
 * it just moves the broken instruction from one part of the file to another.
 *
 * FALSIFIABILITY (recorded per the task's criterion 1): the assertion that catches the
 * original bug is "no transformed role prompt mentions a tool its own transform
 * dropped", below. Before this lane's prompt changes, every role's Step 0 named its
 * discovery tool in prose while the agy transform stripped that tool from the
 * frontmatter, so that assertion failed for ALL 11 roles. Verified by restoring the
 * pre-lane role prompts (git checkout 97877f5e -- packages/apra-fleet-se/apra-pm/agents)
 * and running this file: 11 failures, one per role, each reporting the dropped tool name
 * still present in the transformed output. Restoring the prompts makes it green again.
 *
 * Everything here is driven off loadAgentAssets() -- the same asset set the installer
 * writes -- rather than inline fixtures, so a twelfth role prompt is covered the day it
 * is added, with no edit to this file. Read-only: no network, no filesystem install, no
 * files written.
 */

/** Conditional-marker syntax, which must never survive into any provider's output. */
const MARKER_SYNTAX = /<!--\s*(?:if|else|end)-tool:/;

function assets(): Array<{ relPath: string; content: string }> {
  return loadAgentAssets();
}

/** Top-level `<role>.md` assets -- the role prompts, as opposed to _shared/ and schemas/. */
function rolePrompts(): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const { relPath, content } of assets()) {
    const m = /^([^/\\]+)\.md$/.exec(relPath);
    if (m) out.push({ role: m[1], content });
  }
  return out;
}

function frontmatterTools(content: string): string[] {
  const m = /^tools:\s*\[([^\]]*)\]/m.exec(content);
  return m ? m[1].split(',').map(t => t.trim()).filter(Boolean) : [];
}

/**
 * Run the agy transform and capture the drop list it reports for itself.
 *
 * The transform warns which tools it removed, so this reads the transform's OWN account
 * of what it dropped rather than re-importing its tool map -- a test that re-derived the
 * map would agree with a broken map just as happily as a correct one.
 */
function agyTransformAndDrops(content: string, role: string): { output: string; dropped: string[] } {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const output = transformAgentForAgy(content, `${role}.md`);
    const dropped: string[] = [];
    for (const call of warnSpy.mock.calls) {
      const line = String(call[0]);
      const m = /dropping tools with no Antigravity equivalent from agent "[^"]*": (.+)$/.exec(line);
      if (m) dropped.push(...m[1].split(',').map(t => t.trim()).filter(Boolean));
    }
    return { output, dropped };
  } finally {
    warnSpy.mockRestore();
  }
}

const ROLE_PROMPTS = rolePrompts();

describe('the shipped asset set is what these assertions run against', () => {
  it('loads role prompts from the installer asset set, not fixtures', () => {
    expect(ROLE_PROMPTS.length).toBeGreaterThanOrEqual(11);
    for (const { role, content } of ROLE_PROMPTS) {
      expect(content, `${role} should be non-empty`).not.toBe('');
    }
  });
});

describe('no transformed role prompt mentions a tool its own transform dropped', () => {
  it.each(ROLE_PROMPTS.map(r => [r.role, r.content] as const))(
    'agy: %s',
    (role, content) => {
      const { output, dropped } = agyTransformAndDrops(content, role);
      // Nothing to prove if this role loses no tools on agy; the loop below is the check.
      for (const tool of dropped) {
        expect(
          output.includes(tool),
          `${role}: agy dropped "${tool}" from its frontmatter but the transformed file ` +
            `still references it -- the agent is told to use a tool it does not have`
        ).toBe(false);
      }
      // Frontmatter half of the same property, asserted explicitly.
      const toolsLine = output.split('\n').find(l => l.startsWith('tools:')) ?? '';
      for (const tool of dropped) expect(toolsLine).not.toContain(tool);
    }
  );

  it.each(ROLE_PROMPTS.map(r => [r.role, r.content] as const))(
    'opencode: %s',
    (role, content) => {
      // OpenCode emits no tools line, so availability comes from the known-tool set the
      // transform is built on rather than from the emitted frontmatter.
      const native = new Set(OPENCODE_NATIVE_TOOLS);
      const dropped = frontmatterTools(content).filter(t => !native.has(t));
      const output = transformAgentForOpenCode(content, `${role}.md`);
      for (const tool of dropped) {
        expect(
          output.includes(tool),
          `${role}: "${tool}" is not an OpenCode tool but the transformed file still ` +
            `references it`
        ).toBe(false);
      }
    }
  );

  it('at least one role actually loses a tool -- otherwise the above is vacuous', () => {
    const anyDropped = ROLE_PROMPTS.some(
      ({ role, content }) => agyTransformAndDrops(content, role).dropped.length > 0
    );
    expect(anyDropped).toBe(true);
  });
});

describe('no conditional-marker syntax survives into any provider output', () => {
  it.each([
    ['agy', (c: string, f: string) => transformAgentForAgy(c, f)],
    ['opencode', (c: string, f: string) => transformAgentForOpenCode(c, f)],
    ['claude', (c: string, f: string) => transformAgentForClaude(c, f)],
  ])('%s leaves no markers in any shipped asset', (_provider, transform) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const { relPath, content } of assets()) {
        const output = transform(content, relPath);
        expect(output, `${relPath} shipped raw marker syntax`).not.toMatch(MARKER_SYNTAX);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the markers exist in the source, so the check above has something to strip', () => {
    const marked = ROLE_PROMPTS.filter(({ content }) => MARKER_SYNTAX.test(content));
    expect(marked.length).toBeGreaterThan(0);
  });
});

/**
 * Independent oracle for the Claude path: resolving for Claude should be exactly
 * "delete the marker lines and every line inside an else-branch", leaving the if-branch
 * prose byte-identical. Written as its own small line scanner rather than by calling the
 * production resolver, so agreement between the two means something.
 */
function claudeExpectation(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let depth = 0;
  let inElse = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^<!--\s*if-tool:/.test(t)) { depth++; continue; }
    if (/^<!--\s*else-tool:/.test(t)) { if (depth > 0) inElse = depth; continue; }
    if (/^<!--\s*end-tool:/.test(t)) { if (inElse === depth) inElse = 0; depth--; continue; }
    if (inElse > 0) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

describe('the Claude path is not regressed by the conditional mechanism', () => {
  it.each(ROLE_PROMPTS.map(r => [r.role, r.content] as const))(
    '%s keeps its if-branch prose byte-for-byte, markers aside',
    (_role, content) => {
      const output = transformAgentForClaude(content, 'role.md');
      expect(output).toBe(claudeExpectation(content));
    }
  );

  it.each(ROLE_PROMPTS.map(r => [r.role, r.content] as const))(
    '%s still tells the Claude agent to load the KB tools, and still names them',
    (role, content) => {
      const output = transformAgentForClaude(content, `${role}.md`);
      expect(output).toMatch(/^## Step 0[a-z]? -- Knowledge Bank/m);
      // The discovery step and its query survive intact on the Claude path.
      const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(output);
      expect(query, `${role}: Claude output lost its Step 0 tool-discovery query`).not.toBeNull();
      expect(query![1]).toContain('mcp__apra-fleet__kb_');
      // Every KB tool the source names is still named after transformation.
      for (const tool of frontmatterTools(content)) {
        expect(output, `${role}: Claude output lost tool "${tool}"`).toContain(tool);
      }
    }
  );
});
