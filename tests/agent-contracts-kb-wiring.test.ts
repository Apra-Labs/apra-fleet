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

  it.each(CODE_INTEL_ROLES)('%s still names the KB tools it must call', (role) => {
    const query = /Run ToolSearch with query\s*\n?\s*`([^`]*)`/.exec(byRole.get(role)!)!;
    expect(query[1]).toContain('mcp__apra-fleet__kb_session_prime');
    expect(query[1]).toContain('mcp__apra-fleet__kb_capture');
  });

  it.each(CODE_INTEL_ROLES)('%s says what to do when the repo is not indexed', (role) => {
    expect(byRole.get(role)!).toMatch(/not indexed|no index|unindexed/i);
  });
});

/**
 * On a member dispatch the fleet MCP server is disabled/absent, so the Step 0
 * kb_session_prime call is unreachable dead text. rmkb-3n5.1.1 added a
 * byte-identical fallback paragraph, right after the "If ToolSearch returns no
 * KB tools" line, to every contract that calls kb_session_prime: fall back to
 * reading the committed <repo>/.fleet/kb-canonical.json and use its entries[].
 *
 * The role list here is NOT hardcoded: it is derived from whichever contracts
 * loadAgentAssets() finds on disk under agents/ and mention kb_session_prime,
 * so a new contract added later is covered automatically.
 */
const CANONICAL_BIBLE_FALLBACK_RE =
  /If `mcp__apra-fleet__kb_session_prime` itself is unavailable[\s\S]*?absence is not an error; proceed without it\./;

describe('every contract that primes the KB also has the canonical-bible fallback', () => {
  const byRole = assetsByRole();
  const rolesWithSessionPrime = [...byRole.entries()]
    .filter(([, content]) => content.includes('kb_session_prime'))
    .map(([role]) => role)
    .sort();

  it('discovers at least one role from disk that calls kb_session_prime', () => {
    expect(rolesWithSessionPrime.length).toBeGreaterThan(0);
  });

  it.each(rolesWithSessionPrime)(
    '%s documents the .fleet/kb-canonical.json fallback with entries[] and the absence clause',
    (role) => {
      const content = byRole.get(role)!;
      expect(content).toContain('.fleet/kb-canonical.json');
      expect(content).toContain('entries[]');
      expect(content).toMatch(/may be ABSENT|absence is not an error/);
      expect(content).toMatch(CANONICAL_BIBLE_FALLBACK_RE);
    },
  );

  it('the fallback wording is byte-identical across every contract that carries it', () => {
    const paragraphs = rolesWithSessionPrime.map((role) => {
      const content = byRole.get(role)!;
      const m = CANONICAL_BIBLE_FALLBACK_RE.exec(content);
      expect(m, `${role} is missing the canonical-bible fallback paragraph`).not.toBeNull();
      return m![0];
    });
    const distinct = new Set(paragraphs);
    expect([...distinct]).toHaveLength(1);
  });

  it('states the fallback limits: read-only, CONFIRMED-only, summary not content, freshness', () => {
    for (const role of rolesWithSessionPrime) {
      const content = byRole.get(role)!;
      expect(content).toContain('read-only');
      expect(content).toContain('CONFIRMED-only');
      expect(content).toMatch(/summary rather than the content|summary not content/);
      expect(content).toMatch(/as fresh as the last commit/);
    }
  });

  it('the kb_session_prime Step 0 instruction is not removed by the fallback addition', () => {
    for (const role of rolesWithSessionPrime) {
      expect(byRole.get(role)!).toMatch(/^## Step 0[a-z]? -- Knowledge Bank/m);
    }
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
