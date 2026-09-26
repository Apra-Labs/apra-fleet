import { describe, it, expect, vi, afterEach } from 'vitest';
import { transformAgentForOpenCode, transformAgentForAgy, transformAgentForClaude } from '../src/cli/agent-transform.js';

const DOER_SOURCE = `---
name: doer
description: Executes plan tasks in order, commits after each, stops at VERIFY checkpoints.
tools: [Read, Edit, Write, Bash, Grep, Glob, Agent]
---

# Plan Execution
Body content here.`;

const PLANNER_SOURCE = `---
name: planner
description: Reads requirements and produces PLAN.md with phase-ordered tasks, each assigned a concrete model.
tools: [Read, Grep, Glob, Bash, Write]
---

# Plan Generation
Body content here.`;

const PLAN_REVIEWER_SOURCE = `---
name: plan-reviewer
description: Reviews PLAN.md against requirements; writes feedback.md verdict (APPROVED or CHANGES NEEDED).
tools: [Read, Grep, Glob, Bash, Write]
---

# Plan Review
Body content here.`;

const REVIEWER_SOURCE = `---
name: reviewer
description: Reviews diff against plan and requirements; writes feedback.md verdict (APPROVED or CHANGES NEEDED).
tools: [Read, Grep, Glob, Bash, Write]
---

# Code Review
Body content here.`;

describe('transformAgentForOpenCode', () => {
  it('transforms doer.md with correct permissions (edit+write+bash allow)', () => {
    const result = transformAgentForOpenCode(DOER_SOURCE, 'doer.md');
    expect(result).toContain('mode: subagent');
    expect(result).toContain('edit: allow');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: allow');
    expect(result).not.toContain('name: doer');
    expect(result).toContain('description: Executes plan tasks in order');
    expect(result).toContain('# Plan Execution');
    expect(result).toContain('Body content here.');
  });

  it('transforms planner.md with edit deny (no Edit tool)', () => {
    const result = transformAgentForOpenCode(PLANNER_SOURCE, 'planner.md');
    expect(result).toContain('mode: subagent');
    expect(result).toContain('edit: deny');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: allow');
    expect(result).not.toContain('name: planner');
    expect(result).toContain('description: Reads requirements and produces PLAN.md');
  });

  it('transforms plan-reviewer.md with edit deny', () => {
    const result = transformAgentForOpenCode(PLAN_REVIEWER_SOURCE, 'plan-reviewer.md');
    expect(result).toContain('mode: subagent');
    expect(result).toContain('edit: deny');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: allow');
    expect(result).not.toContain('name: plan-reviewer');
    expect(result).toContain('description: Reviews PLAN.md against requirements');
  });

  it('transforms reviewer.md with edit deny', () => {
    const result = transformAgentForOpenCode(REVIEWER_SOURCE, 'reviewer.md');
    expect(result).toContain('mode: subagent');
    expect(result).toContain('edit: deny');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: allow');
    expect(result).not.toContain('name: reviewer');
    expect(result).toContain('description: Reviews diff against plan and requirements');
  });

  it('preserves body content verbatim', () => {
    const result = transformAgentForOpenCode(DOER_SOURCE, 'doer.md');
    const bodyStart = result.indexOf('# Plan Execution');
    expect(bodyStart).toBeGreaterThan(0);
    expect(result.slice(bodyStart)).toBe('# Plan Execution\nBody content here.');
  });

  it('handles missing tools field with safe defaults', () => {
    const noTools = `---
name: agent
description: An agent without tools.
---

# Content`;
    const result = transformAgentForOpenCode(noTools, 'agent.md');
    expect(result).toContain('mode: subagent');
    expect(result).toContain('edit: deny');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: deny');
    expect(result).toContain('description: An agent without tools.');
  });

  it('ignores unknown tool names gracefully', () => {
    const unknownTools = `---
name: agent
description: Agent with unknown tools.
tools: [Read, Edit, FutureTool, Write, Bash]
---

# Content`;
    const result = transformAgentForOpenCode(unknownTools, 'agent.md');
    expect(result).toContain('edit: allow');
    expect(result).toContain('write: allow');
    expect(result).toContain('bash: allow');
  });

  it('returns content unchanged when no frontmatter present', () => {
    const noFm = '# Just a markdown file\nNo frontmatter here.';
    const result = transformAgentForOpenCode(noFm, 'test.md');
    expect(result).toBe(noFm);
  });
});

describe('transformAgentForAgy', () => {
  it('transforms doer.md with XML auto_approve permission rules', () => {
    const result = transformAgentForAgy(DOER_SOURCE, 'doer.md');
    expect(result).toContain('<rule>');
    expect(result).toContain('<auto_approve>');
    expect(result).toContain('<permission action="read_file" target="*" />');
    expect(result).toContain('<permission action="write_file" target="*" />');
    expect(result).toContain('<permission action="command" target="*" />');
    expect(result).toContain('</auto_approve>');
    expect(result).toContain('</rule>');
    expect(result).toContain('# Plan Execution');
  });

  it('transforms planner.md with read and write rules without edit capability', () => {
    const result = transformAgentForAgy(PLANNER_SOURCE, 'planner.md');
    expect(result).toContain('<permission action="read_file" target="*" />');
    expect(result).toContain('<permission action="write_file" target="*" />');
    expect(result).toContain('# Plan Generation');
  });

  it('returns non-frontmatter files unchanged', () => {
    const raw = '# Plain Agent\nNo frontmatter.';
    const result = transformAgentForAgy(raw, 'plain.md');
    expect(result).toBe(raw);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops tools with no Antigravity mapping and never emits them verbatim', () => {
    const source = `---
name: doer
description: Executes plan tasks.
tools: [Read, Edit, Write, Bash, Grep, Glob, Agent, ToolSearch]
---

# Body`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = transformAgentForAgy(source, 'doer.md');

    const toolsLine = result.split('\n').find(l => l.startsWith('tools:'));
    expect(toolsLine).toBeDefined();
    expect(toolsLine).toContain('view_file');
    expect(toolsLine).toContain('replace_file_content');
    expect(toolsLine).toContain('write_to_file');
    expect(toolsLine).toContain('run_command');
    expect(toolsLine).toContain('grep_search');
    expect(toolsLine).toContain('list_dir');
    expect(toolsLine).toContain('invoke_subagent');
    expect(toolsLine).toContain('send_message');
    expect(toolsLine).not.toContain('ToolSearch');
    expect(toolsLine).not.toContain('multi_replace_file_content');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ToolSearch');
  });

  it('drops mcp__ tool names with no Antigravity mapping', () => {
    const source = `---
name: doer
description: Executes plan tasks.
tools: [Read, mcp__apra-fleet__compose_permissions]
---

# Body`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = transformAgentForAgy(source, 'doer.md');

    const toolsLine = result.split('\n').find(l => l.startsWith('tools:'));
    expect(toolsLine).toBeDefined();
    expect(toolsLine).toContain('view_file');
    expect(toolsLine).not.toContain('mcp__apra-fleet__compose_permissions');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('mcp__apra-fleet__compose_permissions');
  });

  it('omits the tools line entirely when every tool is unmapped', () => {
    const source = `---
name: doer
description: Executes plan tasks.
tools: [ToolSearch]
---

# Body`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = transformAgentForAgy(source, 'doer.md');

    expect(result.split('\n').some(l => l.startsWith('tools:'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Provider-conditional body blocks (apra-fleet-oomh.1).
 *
 * Dropping a tool from the transformed frontmatter without dropping the prose that
 * tells the agent to call it leaves the installed prompt instructing an agent to use
 * a tool it does not have. These cover the generic mechanism that keeps the two in
 * step, on every provider path including the Claude/raw one.
 *
 * The mechanism is tool-name-generic, so most cases here use invented tool names
 * (`Telepathy`, `Divination`) that no tool map has ever heard of -- if any of these
 * only passed for a specific real tool name, the mechanism would be special-casing it.
 */
const MARKER_SYNTAX = /<!--\s*(?:if|else|end)-tool:/;

function agentWith(tools: string, body: string): string {
  return `---\nname: sample\ndescription: A sample agent.\ntools: [${tools}]\n---\n\n${body}`;
}

const IF_ELSE_BODY = [
  '# Sample',
  '',
  '<!-- if-tool: Telepathy -->',
  'Read the user mind with Telepathy.',
  '<!-- else-tool: Telepathy -->',
  'Ask the user directly.',
  '<!-- end-tool: Telepathy -->',
  '',
  'Trailing prose.',
].join('\n');

describe('conditional body blocks: a surviving tool keeps its if-branch', () => {
  // Telepathy is in the frontmatter AND mapped for agy / native for opencode? No --
  // it is unmapped everywhere, so a *real* surviving tool is used for the keep cases.
  const body = IF_ELSE_BODY.replace(/Telepathy/g, 'Bash').replace(
    'Read the user mind with Bash',
    'Run the suite with Bash'
  );

  it.each([
    ['agy', (c: string) => transformAgentForAgy(c, 'sample.md')],
    ['opencode', (c: string) => transformAgentForOpenCode(c, 'sample.md')],
    ['claude', (c: string) => transformAgentForClaude(c, 'sample.md')],
  ])('%s keeps the if-branch and drops the else-branch', (_name, transform) => {
    const result = transform(agentWith('Read, Bash', body));
    expect(result).toContain('Run the suite with Bash.');
    expect(result).not.toContain('Ask the user directly.');
    expect(result).not.toMatch(MARKER_SYNTAX);
    expect(result).toContain('Trailing prose.');
  });
});

describe('conditional body blocks: a dropped tool keeps its else-branch', () => {
  // Telepathy has no agy mapping and is not an OpenCode native tool, so both
  // transforms drop it from what the agent can actually call.
  it.each([
    ['agy', (c: string) => transformAgentForAgy(c, 'sample.md')],
    ['opencode', (c: string) => transformAgentForOpenCode(c, 'sample.md')],
  ])('%s keeps the else-branch and drops the if-branch', (_name, transform) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = transform(agentWith('Read, Telepathy', IF_ELSE_BODY));
    expect(result).toContain('Ask the user directly.');
    expect(result).not.toContain('Read the user mind with Telepathy.');
    // The whole point: the dropped tool's NAME is gone from the body too.
    expect(result).not.toContain('Telepathy');
    expect(result).not.toMatch(MARKER_SYNTAX);
    expect(result).toContain('Trailing prose.');
    warnSpy.mockRestore();
  });

  it('claude keeps the if-branch for the same source -- it has the tool', () => {
    const result = transformAgentForClaude(agentWith('Read, Telepathy', IF_ELSE_BODY), 'sample.md');
    expect(result).toContain('Read the user mind with Telepathy.');
    expect(result).not.toContain('Ask the user directly.');
    expect(result).not.toMatch(MARKER_SYNTAX);
  });

  it('drops an else-less block entirely when the tool is unavailable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = [
      '# Sample',
      '<!-- if-tool: Telepathy -->',
      'Mind-read step.',
      '<!-- end-tool: Telepathy -->',
      'Trailing prose.',
    ].join('\n');
    const result = transformAgentForAgy(agentWith('Read, Telepathy', body), 'sample.md');
    expect(result).not.toContain('Mind-read step.');
    expect(result).toContain('Trailing prose.');
    expect(result).not.toMatch(MARKER_SYNTAX);
    warnSpy.mockRestore();
  });
});

describe('conditional body blocks: nesting and repetition', () => {
  const NESTED = [
    '# Sample',
    '<!-- if-tool: Bash -->',
    'outer-if',
    '<!-- if-tool: Telepathy -->',
    'inner-if',
    '<!-- else-tool: Telepathy -->',
    'inner-else',
    '<!-- end-tool: Telepathy -->',
    '<!-- else-tool: Bash -->',
    'outer-else',
    '<!-- if-tool: Telepathy -->',
    'discarded-inner',
    '<!-- end-tool: Telepathy -->',
    '<!-- end-tool: Bash -->',
    'tail',
  ].join('\n');

  it('resolves an inner block inside the kept outer branch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = transformAgentForAgy(agentWith('Bash, Telepathy', NESTED), 'sample.md');
    expect(result).toContain('outer-if');
    expect(result).toContain('inner-else');
    expect(result).not.toContain('inner-if');
    expect(result).not.toContain('outer-else');
    expect(result).not.toContain('discarded-inner');
    expect(result).not.toMatch(MARKER_SYNTAX);
    warnSpy.mockRestore();
  });

  it('discards an inner block that sits in a discarded outer branch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No Bash in frontmatter -> outer condition false -> outer-else wins.
    const result = transformAgentForAgy(agentWith('Read, Telepathy', NESTED), 'sample.md');
    expect(result).toContain('outer-else');
    expect(result).not.toContain('outer-if');
    expect(result).not.toContain('inner-if');
    expect(result).not.toContain('inner-else');
    expect(result).not.toContain('discarded-inner');
    expect(result).not.toMatch(MARKER_SYNTAX);
    warnSpy.mockRestore();
  });

  it('resolves repeated sibling blocks for the same tool independently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = [
      '<!-- if-tool: Telepathy -->A-if<!-- else-tool: Telepathy -->A-else<!-- end-tool: Telepathy -->',
      '<!-- if-tool: Telepathy -->B-if<!-- else-tool: Telepathy -->B-else<!-- end-tool: Telepathy -->',
      '<!-- if-tool: Bash -->C-if<!-- else-tool: Bash -->C-else<!-- end-tool: Bash -->',
    ].join('\n');
    const result = transformAgentForAgy(agentWith('Bash, Telepathy', body), 'sample.md');
    expect(result).toContain('A-else');
    expect(result).toContain('B-else');
    expect(result).toContain('C-if');
    expect(result).not.toContain('A-if');
    expect(result).not.toContain('B-if');
    expect(result).not.toContain('C-else');
    expect(result).not.toMatch(MARKER_SYNTAX);
    warnSpy.mockRestore();
  });
});

describe('conditional body blocks: malformed input fails loudly', () => {
  const transforms: Array<[string, (c: string) => string]> = [
    ['agy', (c: string) => transformAgentForAgy(c, 'broken.md')],
    ['opencode', (c: string) => transformAgentForOpenCode(c, 'broken.md')],
    ['claude', (c: string) => transformAgentForClaude(c, 'broken.md')],
  ];

  it.each(transforms)('%s throws on an unclosed if-tool marker', (_name, transform) => {
    const body = '<!-- if-tool: Divination -->\nnever closed\n';
    expect(() => transform(agentWith('Read, Divination', body))).toThrow(/unclosed/i);
    expect(() => transform(agentWith('Read, Divination', body))).toThrow(/broken\.md/);
  });

  it.each(transforms)('%s throws on an end-tool with no open block', (_name, transform) => {
    const body = 'prose\n<!-- end-tool: Divination -->\n';
    expect(() => transform(agentWith('Read', body))).toThrow(/no matching/i);
  });

  it.each(transforms)('%s throws on an else-tool with no open block', (_name, transform) => {
    const body = 'prose\n<!-- else-tool: Divination -->\n';
    expect(() => transform(agentWith('Read', body))).toThrow(/no matching/i);
  });

  it.each(transforms)('%s throws when end-tool names a different tool', (_name, transform) => {
    const body = '<!-- if-tool: Divination -->\nx\n<!-- end-tool: Telepathy -->\n';
    expect(() => transform(agentWith('Read', body))).toThrow(/does not match the open/i);
  });

  it.each(transforms)('%s throws on a duplicated else-tool', (_name, transform) => {
    const body = [
      '<!-- if-tool: Divination -->',
      'a',
      '<!-- else-tool: Divination -->',
      'b',
      '<!-- else-tool: Divination -->',
      'c',
      '<!-- end-tool: Divination -->',
    ].join('\n');
    expect(() => transform(agentWith('Read', body))).toThrow(/duplicate/i);
  });

  it('names the offending file so an install failure is actionable', () => {
    expect(() => transformAgentForClaude(agentWith('Read', '<!-- if-tool: X -->\n'), 'planner.md'))
      .toThrow(/\[agent-transform\] planner\.md/);
  });
});

describe('conditional body blocks: files without frontmatter still get stripped', () => {
  it.each([
    ['agy', (c: string) => transformAgentForAgy(c, 'shared.md')],
    ['opencode', (c: string) => transformAgentForOpenCode(c, 'shared.md')],
    ['claude', (c: string) => transformAgentForClaude(c, 'shared.md')],
  ])('%s resolves markers in a frontmatter-less asset', (_name, transform) => {
    const raw = '# Shared doc\n<!-- if-tool: Bash -->\nkeep me\n<!-- end-tool: Bash -->\n';
    const result = transform(raw);
    expect(result).toContain('keep me');
    expect(result).not.toMatch(MARKER_SYNTAX);
  });

  it('leaves ordinary HTML comments alone', () => {
    const raw = '# Doc\n<!-- just a note -->\nbody\n';
    expect(transformAgentForClaude(raw, 'doc.md')).toContain('<!-- just a note -->');
  });
});
