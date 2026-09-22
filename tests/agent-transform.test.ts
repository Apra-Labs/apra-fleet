import { describe, it, expect, vi, afterEach } from 'vitest';
import { transformAgentForOpenCode, transformAgentForAgy } from '../src/cli/agent-transform.js';

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
