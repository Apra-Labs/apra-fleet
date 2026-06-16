import { describe, it, expect } from 'vitest';
import { transformAgentForOpenCode } from '../src/cli/agent-transform.js';

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
