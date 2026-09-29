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

// apra-fleet-9jmc.3.1: these five role prompts are DELIBERATELY INVERTED from the other
// six. A dispatched member running one of them cannot reach the fleet MCP server at all
// (disabled -- see src/providers/claude.ts's composePermissionConfig) and has no working
// kb_captures apply path (packages/apra-fleet-se/fleet-sprint/role-policies.mjs: each
// row is kbInjection 'wrapper' with no 'kb-apply' postResult step). So unlike the six
// REQUIRED_KB_ROLES below -- which open Step 0 with an unconditional "Run ToolSearch
// with query" and degrade only if that call fails -- these five lead with the
// orchestrator's pre-fetched "KNOWLEDGE BANK" block as their PRIMARY source and treat
// every KB tool call as an optional bonus path, never a requirement. Asserting the old
// "required" phrasing on them would be asserting a lie back into the contract.
//
// SOURCE OF TRUTH: this list is HAND-KEPT here, but it is NOT authoritative. The
// authoritative set is derived straight from role-policies.mjs by
// packages/apra-fleet-se/test/kb-prompt-contract-wrapper-roles.test.mjs's
// wrapperRowsWithoutKbApply(); that file also reads THIS literal back out of THIS file
// and fails on any drift between the two, so adding a sixth such row to
// role-policies.mjs cannot silently leave this list stale.
const OPTIONAL_KB_ROLES = ['planner', 'plan-reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner'];
const REQUIRED_KB_ROLES = ROLES.filter((r) => !OPTIONAL_KB_ROLES.includes(r));

// This repo's prompt markdown hard-wraps prose across physical lines (e.g. "... a BONUS
// path, not a\nrequirement: attempt it ..."), so a multi-word phrase check on raw
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

  // The two populations must together cover ROLES exactly -- otherwise a future role
  // could be dropped from OPTIONAL_KB_ROLES' filter and land in neither list, escaping
  // both contracts silently.
  it('REQUIRED_KB_ROLES and OPTIONAL_KB_ROLES partition ROLES with no role in neither or both', () => {
    expect([...REQUIRED_KB_ROLES, ...OPTIONAL_KB_ROLES].sort()).toEqual([...ROLES].sort());
    expect(REQUIRED_KB_ROLES.filter((r) => OPTIONAL_KB_ROLES.includes(r))).toEqual([]);
    // Neither population may be empty, or its it.each block below vanishes silently.
    expect(REQUIRED_KB_ROLES.length).toBeGreaterThan(0);
    expect(OPTIONAL_KB_ROLES.length).toBeGreaterThan(0);
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

  it.each(OPTIONAL_KB_ROLES)(
    '%s offers KB tools as an optional bonus path, not a requirement, since it cannot reach them on a dispatched member',
    (role) => {
      const content = normalizeWhitespace(byRole.get(role)!);
      // The tools frontmatter still lists ToolSearch (a live lookup remains POSSIBLE,
      // just never required), and Step 0 says outright that it is not.
      expect(toolsLine(byRole.get(role)!)).toContain('ToolSearch');
      expect(content).toContain('BONUS path, not a requirement');
      // Still names a real ToolSearch call, only conditionally-phrased ("Optional, only
      // if you want a live lookup ... run ToolSearch with query") rather than the
      // REQUIRED_KB_ROLES' unconditional imperative -- case-insensitive since this
      // contract deliberately does not open the sentence with it.
      expect(content.toLowerCase()).toContain('run toolsearch with query');
    }
  );

  it.each(OPTIONAL_KB_ROLES)(
    '%s already assumes the fleet MCP server may be unreachable, before any tool call is attempted',
    (role) => {
      const content = normalizeWhitespace(byRole.get(role)!);
      // Unlike REQUIRED_KB_ROLES, there is no separate "if ToolSearch returns nothing"
      // escape hatch to fall into -- the PRIMARY path (the orchestrator's pre-fetched
      // KB block) never assumed the tools were reachable in the first place.
      expect(content).toContain('fleet MCP server (`mcp__apra-fleet__*`) is disabled for this role');
      expect(content).toContain('PRIMARY source');
    }
  );

  // planner is the one inverted role whose prompt also had to stop advertising a
  // kb_captures output, because its row has no kb-apply step to read one.
  it('planner instructs no kb_captures output, and its schema agrees', () => {
    const planner = normalizeWhitespace(byRole.get('planner')!);
    expect(planner).not.toMatch(/\b(add|populate|emit|include|fill in|write)\b[^.]{0,100}?kb_captures/i);
    const schemaAsset = loadAgentAssets().find(({ relPath }) =>
      relPath.replace(/\\/g, '/').endsWith('schemas/planner-output.json')
    );
    expect(schemaAsset, 'planner-output.json must ship as an agent asset').toBeDefined();
    const schema = JSON.parse(schemaAsset!.content);
    const captures = schema.properties?.kb_captures;
    if (captures) {
      // Kept for forward compatibility -- but it must say plainly that it is inert,
      // so the schema never advertises a field the prompt denies.
      expect(captures.description).toMatch(/ignored for this role|no apply path|silently dropped/i);
    }
  });
});

/**
 * apra-fleet-b4g.38: since cc712c94 the fleet server refuses any kb_* call that names
 * no repo_path (repo_scope_required / E-REPO-SCOPE-REQUIRED) before opening a KB. Nine
 * of the eleven role prompts carry a call to some kb_* tool beyond kb_session_prime
 * (which already takes repo_path as an input the priming test above pins); those calls
 * are silently dropped unless the prompt tells the agent to carry repo_path forward.
 * b4g.35 and this bead patched the five prompts an audit had under-counted, but nothing
 * asserted the instruction itself -- the sentence could be deleted from every prompt and
 * the priming test above would stay green. This pins it at the class level so the next
 * regression fails a test instead of silently dropping captures again.
 *
 * ci-watcher is correctly exempt: kb_session_prime is its only kb_* call (asserted
 * above), so there is no further call site to scope. kb-reconciler carries no verbatim
 * scope sentence but names `repo_path` explicitly at its own "Repo scope" instruction
 * covering every kb_* call it makes -- satisfies the requirement the other way.
 */
const KB_SCOPE_SENTENCE =
  'Pass that same `repo_path` on EVERY `mcp__apra-fleet__kb_*` call you make (queries, captures, feedback, stats) -- the fleet server refuses a `kb_*` call that names no repo rather than guessing one.';

function callsKbBeyondSessionPrime(content: string): boolean {
  return /mcp__apra-fleet__kb_(?!session_prime\b)[a-z_]+/.test(content);
}

// The full sweep from apra-fleet-b4g.38: every role that calls a kb_* tool beyond
// kb_session_prime must carry the verbatim scope sentence, EXCEPT kb-reconciler, which
// states its own repo-scope rule and repeats repo_path at every one of its call sites
// instead. ci-watcher has no kb_* call beyond kb_session_prime at all (asserted below),
// so it needs neither.
const SCOPE_SENTENCE_ROLES = [
  'backlog-groomer',
  'deployer',
  'doer',
  'harvester',
  'integ-test-runner',
  'planner',
  'plan-reviewer',
  'regression-test-runner',
  'reviewer',
];

describe('every kb_* call beyond priming is pinned to its repo_path scope', () => {
  const byRole = assetsByRole();

  it('the scope-sentence role set is exactly ROLES minus the two documented exemptions', () => {
    expect([...SCOPE_SENTENCE_ROLES].sort()).toEqual(
      ROLES.filter((r) => r !== 'ci-watcher' && r !== 'kb-reconciler').sort()
    );
  });

  it.each(SCOPE_SENTENCE_ROLES)('%s carries the verbatim repo_path scope sentence', (role) => {
    expect(byRole.get(role)!).toContain(KB_SCOPE_SENTENCE);
  });

  it('ci-watcher has no kb_* call beyond kb_session_prime, so nothing needs scoping', () => {
    expect(callsKbBeyondSessionPrime(byRole.get('ci-watcher')!)).toBe(false);
  });

  it('kb-reconciler names repo_path at its own repo-scope instruction instead of the sentence', () => {
    const content = byRole.get('kb-reconciler')!;
    expect(content).not.toContain(KB_SCOPE_SENTENCE);
    expect(content).toMatch(/Repo scope[^\n]*repo_path/);
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
