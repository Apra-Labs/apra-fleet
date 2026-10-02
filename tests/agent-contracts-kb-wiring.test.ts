import { describe, it, expect, vi } from 'vitest';
import { loadAgentAssets } from '../src/cli/install.js';
import { transformAgentForAgy, transformAgentForClaude } from '../src/cli/agent-transform.js';

/**
 * The KB contracts are only real if they are present in what the installer actually
 * writes. The audit behind docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md
 * found all 8 installed personas carrying `kb_` refs = 0 while the repo copies were
 * correct, so this asserts the wiring on the asset set install sources from.
 *
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

// kb-reconciler is dispatched with specific contradiction pairs to resolve, not a fresh
// codebase context to explore -- it has no use for kb_session_prime and, unlike the other
// ten roles, cannot degrade to file-based work if the MCP server is down (its only job IS
// the KB tool calls), so it reports and stops instead of skipping Step 0 and proceeding.
// Scoped out of the priming-specific assertion below; still covered by the other three.
const KB_PRIMING_ROLES = ROLES.filter((r) => r !== 'kb-reconciler');

// KB redesign: every primed role uses the kb_* and code_* tools directly when they are
// present in its session (no ToolSearch discovery probe, no repo_path/scope argument),
// otherwise reads the engine-injected "KNOWLEDGE BANK" block, and on a tool failure
// uses that block if present or continues without KB -- never reporting the dispatch
// blocked over it. The full contract (allowlisted names only, no kb_feedback, no
// direct kb_capture) is pinned by packages/apra-fleet-se/test/
// role-prompt-step0-contract.test.mjs; this file asserts the same wording survives
// into what the installer actually writes, on both the Claude and agy renders.
const TOOLS_WHEN_PRESENT = 'If the `kb_*` and `code_*` tools are present in your session, use them directly -- no tool-discovery step is needed';
const BLOCK_OTHERWISE = 'Otherwise, read the injected "KNOWLEDGE BANK -- what this repo already knows" block in your dispatch prompt';
const FALLBACK = 'If a KB or code tool call fails, use that block if your prompt has one; otherwise continue without KB.';
const NEVER_BLOCKED = 'never report this dispatch as blocked because of it';

// This repo's prompt markdown hard-wraps prose across physical lines, so collapse
// whitespace before a multi-word phrase check.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function renderAgy(content: string, role: string): string {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return transformAgentForAgy(content, `${role}.md`);
  } finally {
    warnSpy.mockRestore();
  }
}

/** The role body (frontmatter stripped). */
function body(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '');
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

  it.each(KB_PRIMING_ROLES)('%s: Claude and agy renders both carry tools-when-present, block-otherwise and the conditional fallback', (role) => {
    const src = byRole.get(role)!;
    for (const [label, out] of [
      ['claude', transformAgentForClaude(src, `${role}.md`)],
      ['agy', renderAgy(src, role)],
    ] as const) {
      const flat = normalizeWhitespace(out);
      expect(flat, `${role} (${label})`).toContain(TOOLS_WHEN_PRESENT);
      expect(flat, `${role} (${label})`).toContain(BLOCK_OTHERWISE);
      expect(flat, `${role} (${label})`).toContain(FALLBACK);
      expect(flat, `${role} (${label})`).toContain(NEVER_BLOCKED);
      expect(body(out), `${role} (${label}): no ToolSearch probe in the body`).not.toContain('ToolSearch');
      expect(out, `${role} (${label})`).not.toMatch(/Knowledge Bank \(required/);
    }
  });

  it.each(KB_PRIMING_ROLES)('%s passes no repo_path and instructs no kb_feedback', (role) => {
    const content = byRole.get(role)!;
    expect(content).not.toContain('repo_path');
    expect(content).not.toContain('kb_feedback');
  });
});

/**
 * KB audit 2026-08-11: the code_* tools had 0 calls across six sprint batches. The
 * two roles that read code structurally (the doer, deciding what a change touches;
 * the reviewer, judging blast radius) must name the code_* tools they use when present.
 */
const CODE_INTEL_ROLES = ['doer', 'reviewer'];
const CODE_INTEL_TOOLS = ['code_context', 'code_graph', 'code_impact'];

describe('the code index is reachable from the roles that read code', () => {
  const byRole = assetsByRole();

  it.each(CODE_INTEL_ROLES)('%s names the code_* tools in its Step 0', (role) => {
    const content = byRole.get(role)!;
    for (const tool of CODE_INTEL_TOOLS) expect(content).toContain(`\`${tool}\``);
  });

  // doer and reviewer DECIDE what to capture and report it via the `kb_captures`
  // structured-output field; the engine records it. Neither calls the capture tool.
  it.each(CODE_INTEL_ROLES)('%s contributes KB through its kb_captures output, not a direct call', (role) => {
    const content = byRole.get(role)!;
    expect(content).toContain('`kb_captures` array');
    expect(content).not.toMatch(/(?<![A-Za-z0-9])kb_capture\b/);
    expect(content).toContain('kb_query');
  });

  it.each(CODE_INTEL_ROLES)('%s says what to do when the repo is not indexed', (role) => {
    expect(byRole.get(role)!).toMatch(/not indexed|no index|unindexed/i);
  });

  // kb-reconciler is the most code-intel-dependent role of any -- its own rules
  // forbid Glob/Grep entirely, so code_context/code_impact/code_query are its ONLY
  // way to read the merged code. It keeps its own ToolSearch-gated Step 0.
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
    expect(reviewer).toMatch(/^## Step 5 -- Promote or discard knowledge you verified/m);
  });

  it('ci-watcher is told not to capture -- it verifies no claim about the repo', () => {
    expect(byRole.get('ci-watcher')!).toContain('Record nothing in the KB');
  });
});
