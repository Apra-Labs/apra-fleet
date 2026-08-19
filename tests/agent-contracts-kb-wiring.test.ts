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
  'kb-reconciler',
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

// kb-reconciler is dispatched with specific contradiction pairs to resolve, not a fresh
// codebase context to explore -- it has no use for kb_session_prime and, unlike the other
// ten roles, cannot degrade to file-based work if the MCP server is down (its only job IS
// the KB tool calls), so it reports and stops instead of skipping Step 0 and proceeding.
// Scoped out of the priming-specific assertion below; still covered by the other three.
const KB_PRIMING_ROLES = ROLES.filter((r) => r !== 'kb-reconciler');

describe('every role contract carries working KB wiring', () => {
  const byRole = assetsByRole();

  it('ships all 11 role contracts', () => {
    expect([...byRole.keys()].sort()).toEqual([...ROLES].sort());
  });

  it.each(KB_PRIMING_ROLES)('%s has a Knowledge Bank step that primes the KB', (role) => {
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

/**
 * KB audit 2026-08-11: the seven code_* tools ship in the same MCP server as
 * the kb_* tools and had 0 calls across six sprint batches. Deferred MCP tools
 * load only when a ToolSearch query NAMES them, and every contract's Step 0
 * query listed exactly two KB tools -- so the code index was uncallable from a
 * role regardless of whether the repo was indexed.
 *
 * Scoped to the two roles that read code structurally (the doer, deciding what
 * a change touches; the reviewer, judging blast radius). The other eight roles
 * keep the KB-only query -- widening every contract would spend schema budget
 * in roles that never trace a call chain.
 */
const CODE_INTEL_ROLES = ['doer', 'reviewer'];
const CODE_INTEL_TOOLS = ['code_context', 'code_graph', 'code_impact', 'code_query'];

describe('the code index is reachable from the roles that read code', () => {
  const byRole = assetsByRole();

  it.each(CODE_INTEL_ROLES)('%s names the code_* tools in its ToolSearch query', (role) => {
    const content = byRole.get(role)!;
    const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(content);
    expect(query, 'Step 0 must carry a single backticked ToolSearch query').not.toBeNull();
    for (const tool of CODE_INTEL_TOOLS) {
      expect(query![1]).toContain(`mcp__apra-fleet__${tool}`);
    }
  });

  // apra-fleet-23c / KB trust pipeline Phase 2: doer and reviewer now DECIDE what to
  // capture and report it via the `kb_captures` structured-output field -- the engine
  // makes the actual kb_capture call (auto-sprint.js's "Engine-executed KB capture and
  // promote"). doer still lists kb_capture as a documented fallback for dispatch
  // contexts with no kb_captures field; reviewer deliberately does not (see reviewer.md
  // Step 0's own note on this). Both still must prime and be able to query the KB.
  it.each(CODE_INTEL_ROLES)('%s still names the KB tools it must call', (role) => {
    const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(byRole.get(role)!)!;
    expect(query[1]).toContain('mcp__apra-fleet__kb_session_prime');
    expect(query[1]).toContain('mcp__apra-fleet__kb_query');
  });

  it('doer still carries kb_capture as its structured-output fallback', () => {
    const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(byRole.get('doer')!)!;
    expect(query[1]).toContain('mcp__apra-fleet__kb_capture');
  });

  it.each(CODE_INTEL_ROLES)('%s says what to do when the repo is not indexed', (role) => {
    expect(byRole.get(role)!).toMatch(/not indexed|no index|unindexed/i);
  });
});

describe('promotion stays reviewer-only', () => {
  const byRole = assetsByRole();

  it('reviewer is the sole role instructed to call kb_promote', () => {
    // kb-reconciler mentions kb_promote too, but only to explicitly forbid composing it
    // with kb_feedback for a contradiction pair (kb_resolve_contradiction is its one,
    // single write path) -- that is a prohibition, not an instruction to call it.
    // Excluded from this "who is told to call it" check rather than weakening the check.
    const promoters = ROLES.filter((r) => r !== 'kb-reconciler' && byRole.get(r)!.includes('kb_promote'));
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
