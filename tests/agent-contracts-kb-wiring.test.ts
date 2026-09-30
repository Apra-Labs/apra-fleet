import { describe, it, expect, vi } from 'vitest';
import { loadAgentAssets } from '../src/cli/install.js';
import { transformAgentForAgy, transformAgentForClaude } from '../src/cli/agent-transform.js';

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

// apra-fleet-9jmc.1: these five role prompts are DELIBERATELY INVERTED from the other
// six. A dispatched member running one of them usually cannot reach the fleet MCP
// server (disabled -- see src/providers/claude.ts's composePermissionConfig) and has no
// working kb_captures apply path (packages/apra-fleet-se/fleet-sprint/role-policies.mjs:
// each row is kbInjection 'wrapper' with no 'kb-apply' postResult step). So unlike the
// six REQUIRED_KB_ROLES below -- which open Step 0 with an unconditional "Run ToolSearch
// with query" -- these five use the live KB tools only WHEN AVAILABLE and otherwise fall
// back to the orchestrator's pre-fetched "KNOWLEDGE BANK" block, which then IS the
// repo's knowledge: a missing/failing tool is never read as "no KB". No KB tool call is
// ever a requirement for them.
//
// Hand-kept in sync with packages/apra-fleet-se/test/kb-prompt-contract-wrapper-roles.
// test.mjs, which derives the equivalent role SET straight from role-policies.mjs (the
// actual source of truth) and would fail first if these two lists ever drifted apart --
// see that file's wrapperRowsWithoutKbApply().
const OPTIONAL_KB_ROLES = ['planner', 'plan-reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner'];
const REQUIRED_KB_ROLES = ROLES.filter((r) => !OPTIONAL_KB_ROLES.includes(r));

// The wording every one of the five must carry, in BOTH rendered branches.
const TOOLS_FIRST = 'Use the live KB tools when they are available; otherwise use the pre-fetched "KNOWLEDGE BANK -- what this repo already knows" block in your dispatch prompt';
const NEVER_NO_KB = 'A missing or failing KB tool never means "no KB": when the tools are unavailable, the pre-fetched block IS this repo\'s knowledge';
const BRANCH_FALLBACK = 'use the pre-fetched block instead -- that is the fallback, not a gap';
const NOT_REQUIRED = 'None of these tool calls is ever a requirement';

// This repo's prompt markdown hard-wraps prose across physical lines (e.g. "... the
// pre-fetched block IS this repo's\nknowledge ..."), so a multi-word phrase check on raw
// `content` is fragile -- collapse whitespace first, exactly like
// kb-prompt-contract-wrapper-roles.test.mjs's own findUnconditionalKbToolCall() does.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

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

  it.each(REQUIRED_KB_ROLES)('%s can actually reach the KB tools it is told to call', (role) => {
    const content = byRole.get(role)!;
    // Every Knowledge Bank block opens by loading the MCP tools through ToolSearch.
    expect(content).toContain('Run ToolSearch with query');
    expect(toolsLine(content)).toContain('ToolSearch');
  });

  it.each(REQUIRED_KB_ROLES)('%s degrades gracefully when the MCP server is not running', (role) => {
    expect(byRole.get(role)!).toContain('If ToolSearch returns no KB tools');
  });

  it.each(OPTIONAL_KB_ROLES)('%s prefers the live KB tools when available, never as a requirement', (role) => {
    const content = normalizeWhitespace(byRole.get(role)!);
    // The tools frontmatter still lists ToolSearch: the live path is the
    // preferred one whenever it is reachable.
    expect(toolsLine(byRole.get(role)!)).toContain('ToolSearch');
    expect(content).toContain(TOOLS_FIRST);
    expect(content).toContain(NOT_REQUIRED);
    expect(content).toContain('When the KB tools are available, prime from them first. Run ToolSearch with query');
  });

  it.each(OPTIONAL_KB_ROLES)('%s treats the pre-fetched block as the knowledge when the tools are unavailable', (role) => {
    const content = normalizeWhitespace(byRole.get(role)!);
    expect(content).toContain('fleet MCP server (mcp__apra-fleet__*) is usually disabled for this role');
    expect(content).toContain(NEVER_NO_KB);
    expect(content).toContain('must be made from that block, not from the tool failure');
  });
});

// The KB wording sits inside the provider-conditional ToolSearch markers
// (src/cli/agent-transform.ts). Both rendered branches must keep the same contract:
// live tools first when available, the pre-fetched block as the fallback that IS the
// knowledge. The Claude branch keeps the ToolSearch discovery step; the
// ToolSearch-less (agy) branch names the KB tool directly and never mentions ToolSearch.
describe('optional-KB roles render the same contract on both ToolSearch branches', () => {
  const byRole = assetsByRole();

  function renderAgy(content: string, role: string): string {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return transformAgentForAgy(content, `${role}.md`);
    } finally {
      warnSpy.mockRestore();
    }
  }

  it.each(OPTIONAL_KB_ROLES)('%s: Claude branch primes via ToolSearch when available, else falls back to the block', (role) => {
    const out = normalizeWhitespace(transformAgentForClaude(byRole.get(role)!, `${role}.md`));
    expect(out).toContain(TOOLS_FIRST);
    expect(out).toContain(NEVER_NO_KB);
    expect(out).toContain('When the KB tools are available, prime from them first. Run ToolSearch with query');
    expect(out).toContain(`If ToolSearch surfaces no KB tools or a call fails, ${BRANCH_FALLBACK}`);
    expect(out).not.toContain('no tool-discovery step is needed');
  });

  it.each(OPTIONAL_KB_ROLES)('%s: ToolSearch-less branch calls the KB tool directly when exposed, else falls back to the block', (role) => {
    const out = normalizeWhitespace(renderAgy(byRole.get(role)!, role));
    expect(out).toContain(TOOLS_FIRST);
    expect(out).toContain(NEVER_NO_KB);
    expect(out).toContain('When your environment exposes the KB tools, prime from them first (no tool-discovery step is needed on this provider)');
    expect(out).toContain(`If those tools are not available or a call fails, ${BRANCH_FALLBACK}`);
    expect(out).toContain('mcp__apra-fleet__kb_session_prime');
    expect(out).not.toContain('ToolSearch');
    expect(out).not.toMatch(/Knowledge Bank \(required/);
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

  // kb-reconciler is the most code-intel-dependent role of any -- its own rules
  // forbid Glob/Grep entirely, so code_context/code_impact/code_query are its ONLY
  // way to read the merged code. Not folded into CODE_INTEL_ROLES above because it
  // does not prime (KB_PRIMING_ROLES excludes it) and never calls kb_capture.
  it('kb-reconciler names the code_* tools it needs to decide contradictions', () => {
    const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(byRole.get('kb-reconciler')!)!;
    for (const tool of ['code_context', 'code_impact', 'code_query']) {
      expect(query[1]).toContain(`mcp__apra-fleet__${tool}`);
    }
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
