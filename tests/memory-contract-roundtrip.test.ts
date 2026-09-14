// T1.4.2 EXIT CRITERION: every inventoried memory-contract/v1 tool round-trips
// green against the SQLITE provider, in ONE command:
//
//   npx vitest run tests/memory-contract-roundtrip.test.ts
//
// The validation itself lives in memory-contract/v1/tests/roundtrip-harness.mjs,
// which takes the provider as a PARAMETER and imports nothing from src/. This
// file is the sqlite ADAPTER plus the discovered entry point: it stands up no
// server, it just wires the harness to the real in-process tool handlers.
// T8/PoC-1 writes a second adapter (HTTP) against the same harness with no edit
// to the harness at all.
//
// Why the entry point lives here and not next to the harness: vitest.config.ts
// include is ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'], so a
// *.test.ts under memory-contract/v1/tests/ is never discovered and would
// silently never run -- the false green this bead's own acceptance criteria
// call out. Same reason as every other tests/memory-contract-*.test.ts.
//
// No npm script and no workflow edit is needed: being discovered by npm test is
// what puts this harness in CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { registerAllTools } from '../src/services/tool-registry.js';
import { resolveProjectSlug } from '../src/services/knowledge/project-slug.js';
import {
  runRoundTrip,
  RECORDED_REMOTE_A,
  RECORDED_REMOTE_B,
  decodeEnvelope,
} from '../memory-contract/v1/tests/roundtrip-harness.mjs';
import { KB_MODULES, CODE_EXPORTS } from '../memory-contract/v1/generate-contract.mjs';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<{ content: { type: string; text: string }[] }>;

/**
 * The inventoried roster, read from the generator's own exported data rather
 * than hand-copied here (same technique as tests/memory-contract-roster-guard.test.ts).
 */
const ROSTER: string[] = [
  ...(KB_MODULES as [string, string, string][]).map(([name]) => name),
  ...(CODE_EXPORTS as [string, string][]).map(([name]) => name),
];

/**
 * Minimal stand-in for McpServer that keeps every registered handler, so the
 * adapter can call the REAL post-wrapTool envelope. Same 4-line technique
 * INVENTORY.md section 1 and record-fixtures.mjs already use.
 */
async function registerHandlers(): Promise<Map<string, ToolHandler>> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _description: string, _shape: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return handlers;
}

interface SetupOp {
  op: 'write' | 'delete';
  repo: string;
  rel: string;
  contents?: string;
}

interface EnvironmentSpec {
  repos: { key: string; dir: string; placeholder: string | null; files: Record<string, string> }[];
  remotes: Record<string, string>;
}

/**
 * The sqlite adapter. It owns everything provider-specific: the scratch repos
 * on THIS host's disk, the per-run remote URLs, and the in-process dispatch.
 *
 * Per-run uniqueness matters. tests/setup.ts pins APRA_FLEET_DATA_DIR for the
 * whole run and FLEET_DIR is read at module load, so the sqlite KB at
 * <data>/knowledge/<slug>/kb.sqlite OUTLIVES the test run. Reusing the recorded
 * remote URL would mean the second run starts against a warm KB (audn_decision
 * flips add -> update, kb_list totals shift, the contradiction pair already
 * exists) and the corpus would no longer reproduce. A unique remote URL per run
 * yields a unique slug, hence a fresh KB file, hence a reproducible round trip.
 */
class SqliteContractProvider {
  readonly name = 'sqlite';
  slug = '';
  repoPath = '';

  private root = '';
  private repoPaths = new Map<string, string>();
  private handlers: Map<string, ToolHandler>;
  private runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(handlers: Map<string, ToolHandler>) {
    this.handlers = handlers;
  }

  liveRemote(key: string): string {
    return `https://example.test/memory-contract-roundtrip-${key.toLowerCase()}-${this.runId}.git`;
  }

  async prepareEnvironment(env: EnvironmentSpec) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-roundtrip-'));
    const paths: Record<string, string> = { '<SCRATCH_ROOT>': this.root };

    for (const repo of env.repos) {
      const dir = path.join(this.root, repo.dir);
      fs.mkdirSync(dir, { recursive: true });
      this.repoPaths.set(repo.key, dir);
      for (const [rel, contents] of Object.entries(repo.files)) {
        const target = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, 'utf-8');
      }
      if (repo.placeholder) paths[repo.placeholder] = dir;
    }

    this.repoPath = this.repoPaths.get('A') as string;
    this.slug = resolveProjectSlug(this.repoPath, this.liveRemote('A'));

    return {
      substitutions: {
        paths,
        literals: {
          [RECORDED_REMOTE_A]: this.liveRemote('A'),
          [RECORDED_REMOTE_B]: this.liveRemote('B'),
        },
      },
    };
  }

  async applySetup(ops: SetupOp[]): Promise<void> {
    for (const op of ops) {
      const repoDir = this.repoPaths.get(op.repo);
      if (!repoDir) throw new Error(`setup op names unknown repo "${op.repo}"`);
      const target = path.join(repoDir, ...op.rel.split('/'));
      if (op.op === 'write') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, op.contents ?? '', 'utf-8');
      } else if (op.op === 'delete') {
        fs.rmSync(target, { force: true });
      } else {
        throw new Error(`unknown setup op "${op.op}"`);
      }
    }
  }

  async call(tool: string, request: unknown) {
    const handler = this.handlers.get(tool);
    if (!handler) throw new Error(`tool ${tool} is not registered`);
    return handler(request);
  }
}

describe('memory-contract/v1 round trip (sqlite provider)', () => {
  let report: Awaited<ReturnType<typeof runRoundTrip>>;
  let handlers: Map<string, ToolHandler>;

  beforeAll(async () => {
    handlers = await registerHandlers();
    report = await runRoundTrip(new SqliteContractProvider(handlers), ROSTER);
  }, 120_000);

  it('round-trips every inventoried tool green against sqlite', () => {
    // One aggregated assertion on purpose: an exit-criterion harness that
    // reported one failure per run would be miserable to drive to green.
    expect(report.failures).toEqual([]);
  });

  it('dispatched every committed fixture live (no case silently skipped)', () => {
    const undispatched = report.steps.filter((s) => !s.dispatched).map((s) => s.key);
    expect(undispatched).toEqual([]);
    expect(report.steps.length).toBe(48);
  });

  it('covers all 23 inventoried tools', () => {
    expect(new Set(report.steps.map((s) => s.tool)).size).toBe(ROSTER.length);
    expect(ROSTER.length).toBe(23);
  });

  it('exercises a (slug, repoPath) PAIR, not a bare slug', () => {
    expect(report.provider.slug).toBeTruthy();
    expect(report.provider.repoPath).toBeTruthy();
    expect(path.isAbsolute(report.provider.repoPath)).toBe(true);
  });

  // The pair claim, made falsifiable. getKbProviders caches on
  // providerKey(slug, repoPath); two callers that resolve to the SAME slug but
  // pass different repo_path values get distinct provider instances, each
  // anchored at its own repoPath. So an identical request differs in outcome
  // purely by repoPath: the basis file resolves under one anchor and not the
  // other. If keying were slug-only, the second call would reuse the first
  // anchor and this capture would succeed -- so this test fails on that bug.
  it('provider identity is keyed on (slug, repoPath): same slug, different repoPath, different basis resolution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-pairkey-'));
    const anchored = path.join(root, 'anchored');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(path.join(anchored, 'src'), { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(anchored, 'src', 'pair.ts'), 'export const pair = 1;\n', 'utf-8');

    // ONE remote URL -> ONE slug -> one shared KB file, so slug is held constant
    // and repoPath is the only thing that differs.
    const remote = `https://example.test/memory-contract-pairkey-${Date.now().toString(36)}.git`;
    expect(resolveProjectSlug(anchored, remote)).toBe(resolveProjectSlug(empty, remote));

    const kbCapture = handlers.get('kb_capture') as ToolHandler;
    const request = {
      repo_remote_url: remote,
      type: 'knowledge',
      title: 'Provider identity is keyed on the (slug, repoPath) pair',
      summary: 'Basis resolution follows the repoPath the caller passed, not the slug alone.',
      content: 'src/pair.ts exists under the anchored repo root and nowhere else.',
      source_files: ['src/pair.ts'],
    };

    const ok = decodeEnvelope(await kbCapture({ ...request, repo_path: anchored }));
    expect(typeof ok.parsed.id).toBe('string');

    await expect(kbCapture({ ...request, repo_path: empty })).rejects.toThrow(/src\/pair\.ts/);
  }, 60_000);
});
