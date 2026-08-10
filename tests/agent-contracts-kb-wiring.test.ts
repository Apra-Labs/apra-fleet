import { describe, it, expect } from 'vitest';
import { loadAgentAssets } from '../src/cli/install.js';

/**
 * The KB contracts are only real if they are present in what the installer actually
 * writes. The audit behind docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md
 * found all 8 installed personas carrying `kb_` refs = 0 while the repo copies were
 * correct, so this asserts the wiring on the asset set install sources from.
 *
 * A Step 0 block that says "Run ToolSearch with query ..." is dead prose in a role whose
 * frontmatter has no ToolSearch, so both halves are asserted together.
 */
const ROLES = [
  'backlog-groomer',
  'ci-watcher',
  'deployer',
  'doer',
  'harvester',
  'integ-test-runner',
  'planner',
  'plan-reviewer',
  'regression-test-runner',
  'reviewer',
];

function assetsByRole(): Map<string, string> {
  const byRole = new Map<string, string>();
  for (const { relPath, content } of loadAgentAssets()) {
    const m = /^([^/\\]+)\.md$/.exec(relPath);
    if (m) byRole.set(m[1], content);
  }
  return byRole;
}

function toolsLine(content: string): string {
  const m = /^tools:\s*\[([^\]]*)\]/m.exec(content);
  return m ? m[1] : '';
}

describe('every role contract carries working KB wiring', () => {
  const byRole = assetsByRole();

  it('ships all 10 role contracts', () => {
    expect([...byRole.keys()].sort()).toEqual([...ROLES].sort());
  });

  it.each(ROLES)('%s has a Knowledge Bank step that primes the KB', (role) => {
    const content = byRole.get(role)!;
    expect(content).toMatch(/^## Step 0[a-z]? -- Knowledge Bank/m);
    expect(content).toContain('kb_session_prime');
  });

  it.each(ROLES)('%s can actually reach the KB tools it is told to call', (role) => {
    const content = byRole.get(role)!;
    // Every Knowledge Bank block opens by loading the MCP tools through ToolSearch.
    expect(content).toContain('Run ToolSearch with query');
    expect(toolsLine(content)).toContain('ToolSearch');
  });

  it.each(ROLES)('%s degrades gracefully when the MCP server is not running', (role) => {
    expect(byRole.get(role)!).toContain('If ToolSearch returns no KB tools');
  });
});

describe('promotion stays reviewer-only', () => {
  const byRole = assetsByRole();

  it('reviewer is the sole role instructed to call kb_promote', () => {
    const promoters = ROLES.filter((r) => byRole.get(r)!.includes('kb_promote'));
    expect(promoters).toEqual(['reviewer']);
  });

  it('reviewer still carries the promote contract that mints CONFIRMED', () => {
    const reviewer = byRole.get('reviewer')!;
    expect(reviewer).toMatch(/^## Step 5 -- Promote knowledge you verified/m);
  });

  it('ci-watcher is told not to capture -- it verifies no claim about the repo', () => {
    expect(byRole.get('ci-watcher')!).toContain('Do NOT capture');
  });
});
