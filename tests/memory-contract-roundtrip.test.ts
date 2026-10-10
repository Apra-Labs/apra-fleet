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
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';

import { registerAllTools } from '../src/services/tool-registry.js';
import { memberToolScope } from '../src/services/tool-scope.js';
import { addAgent, removeAgent } from '../src/services/registry.js';
import { kbSetup } from '../src/tools/kb-setup.js';
import { resetKbProviders } from '../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../src/paths.js';
import { resolveProjectSlug } from '../src/services/knowledge/project-slug.js';
import {
  runRoundTrip,
  RECORDED_REMOTE_A,
  RECORDED_REMOTE_B,
  RECORDED_REMOTE_IMPORT_REJECTED,
  RECORDED_REMOTE_BARE,
  RECORDED_REMOTE_HTTP,
} from '../memory-contract/v1/tests/roundtrip-harness.mjs';
import { materializeSessionWorld } from '../memory-contract/v1/tests/session-world.mjs';
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

interface SetupOp {
  op: 'write' | 'delete' | 'commit';
  repo: string;
  rel: string;
  contents?: string;
}

interface EnvironmentSpec {
  repos: { key: string; dir: string; placeholder: string | null; files: Record<string, string> }[];
  remotes: Record<string, string>;
  sessions: Record<string, unknown>;
}

const RECORDED_REMOTES: Record<string, string> = {
  A: RECORDED_REMOTE_A,
  B: RECORDED_REMOTE_B,
  IMPORT_REJECTED: RECORDED_REMOTE_IMPORT_REJECTED,
  BARE: RECORDED_REMOTE_BARE,
  HTTP: RECORDED_REMOTE_HTTP,
};

// The http-backed session's KB server is never contacted (both of its recorded
// outcomes are decided before any request), so a loopback port nothing listens
// on is enough. The token is the committed obviously-fake fixture value.
const HTTP_KB_URL = 'http://127.0.0.1:9';
const HTTP_KB_TOKEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge', 'fixtures', 'kb-http-test-token.txt');
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

/** Runs fn with the project KB configured as http, then restores the prior config and provider cache. */
async function withHttpKb<T>(fn: () => Promise<T>): Promise<T> {
  const prior = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH) : null;
  resetKbProviders();
  try {
    const token = fs.readFileSync(HTTP_KB_TOKEN_PATH, 'utf-8').trim();
    await kbSetup({ provider: 'http', remote: HTTP_KB_URL, token }, { folder: os.tmpdir() });
    return await fn();
  } finally {
    if (prior === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
    else fs.writeFileSync(KB_CONFIG_PATH, prior);
    resetKbProviders();
  }
}

/**
 * The sqlite adapter. It owns everything provider-specific: the scratch repos
 * on THIS host's disk, one registered member per harness session (each with
 * its own session-scoped tool handlers), the per-run remote URLs, and the
 * in-process dispatch.
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
  root = '';

  private repoPaths = new Map<string, string>();
  private sessionHandlers = new Map<string, Map<string, ToolHandler>>();
  private cleanupWorld: (() => void) | null = null;
  private runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  liveRemote(key: string): string {
    return `https://example.test/memory-contract-roundtrip-${key.toLowerCase().replace(/_/g, '-')}-${this.runId}.git`;
  }

  async prepareEnvironment(env: EnvironmentSpec) {
    // realpath: a FULL session's (self) is process.cwd(), reported with
    // symlinks resolved (macOS /var -> /private/var), so substitutions must
    // use that same spelling.
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-roundtrip-')));
    const world = await materializeSessionWorld(env, this.root, {
      remoteUrl: (key: string) => this.liveRemote(key),
      addAgent,
      removeAgent,
      registerAllTools,
      memberToolScope,
      withHttpKb,
    });
    this.repoPaths = world.repoPaths;
    this.sessionHandlers = world.sessionHandlers as Map<string, Map<string, ToolHandler>>;
    this.cleanupWorld = world.cleanup;

    const paths: Record<string, string> = { '<SCRATCH_ROOT>': this.root };
    for (const repo of env.repos) {
      if (repo.placeholder) paths[repo.placeholder] = this.repoPaths.get(repo.key) as string;
    }

    this.repoPath = this.repoPaths.get('A') as string;
    this.slug = resolveProjectSlug(this.repoPath);

    const literals: Record<string, string> = {};
    for (const [key, recorded] of Object.entries(RECORDED_REMOTES)) literals[recorded] = this.liveRemote(key);
    for (const [recorded, live] of world.memberLiterals as [string, string][]) literals[recorded] = live;

    return { substitutions: { paths, literals } };
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
      } else if (op.op === 'commit') {
        const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
        git(['add', '--', op.rel]);
        git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'setup: ' + op.rel, '--', op.rel]);
      } else {
        throw new Error(`unknown setup op "${op.op}"`);
      }
    }
  }

  handlersFor(session: string): Map<string, ToolHandler> {
    const handlers = this.sessionHandlers.get(session);
    if (!handlers) throw new Error(`session ${session} was not materialised`);
    return handlers;
  }

  async call(tool: string, request: unknown, session: string) {
    const handler = this.handlersFor(session).get(tool);
    if (!handler) throw new Error(`tool ${tool} is not registered for session ${session}`);
    return handler(request);
  }

  dispose(): void {
    this.cleanupWorld?.();
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
  }
}

describe('memory-contract/v1 round trip (sqlite provider)', () => {
  let report: Awaited<ReturnType<typeof runRoundTrip>>;
  const provider = new SqliteContractProvider();

  beforeAll(async () => {
    report = await runRoundTrip(provider, ROSTER);
  }, 120_000);

  afterAll(() => {
    provider.dispose();
  });

  it('round-trips every inventoried tool green against sqlite', () => {
    // One aggregated assertion on purpose: an exit-criterion harness that
    // reported one failure per run would be miserable to drive to green.
    expect(report.failures).toEqual([]);
  });

  it('dispatched every committed fixture live (no case silently skipped)', () => {
    const undispatched = report.steps.filter((s) => !s.dispatched).map((s) => s.key);
    expect(undispatched).toEqual([]);
    expect(report.steps.length).toBe(94); // one SCENARIO step per committed fixture (94 fixture files on disk)
  });

  it('covers all 26 inventoried tools', () => {
    expect(new Set(report.steps.map((s) => s.tool)).size).toBe(ROSTER.length);
    expect(ROSTER.length).toBe(26);
  });

  it('exercises a (slug, repoPath) PAIR, not a bare slug', () => {
    expect(report.provider.slug).toBeTruthy();
    expect(report.provider.repoPath).toBeTruthy();
    expect(path.isAbsolute(report.provider.repoPath)).toBe(true);
  });

  // The pair claim, made falsifiable. getKbProviders caches on
  // providerKey(slug, repoPath); two callers that resolve to the SAME slug but
  // anchor at different folders get distinct provider instances, each
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

    // The in-process anchor (kb-self.ts KbAnchor) -- no tool request can carry one.
    const { kbCapture } = await import('../src/tools/kb-capture.js');
    const request = {
      type: 'knowledge' as const,
      title: 'Provider identity is keyed on the (slug, repoPath) pair',
      summary: 'Basis resolution follows the repoPath the caller passed, not the slug alone.',
      content: 'src/pair.ts exists under the anchored repo root and nowhere else.',
      source_files: ['src/pair.ts'],
    };

    const ok = JSON.parse(await kbCapture(request, { folder: anchored, remoteUrl: remote }));
    expect(typeof ok.id).toBe('string');

    await expect(kbCapture(request, { folder: empty, remoteUrl: remote })).rejects.toThrow(/src\/pair\.ts/);
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);
});

// The basis-mismatch step's assertParsed, made falsifiable: a provider whose
// kb_bible_commit ADMITS the drifted entry (moves it from skipped to merged)
// still returns a schema-valid response, so only that assertion can catch it.
// The stub wraps the real sqlite adapter and rewrites nothing else, so the
// basis-mismatch step must be the run's one and only failure.
class AdmitsDriftedEntryProvider extends SqliteContractProvider {
  async call(tool: string, request: unknown, session: string) {
    const envelope = await super.call(tool, request, session);
    if (tool !== 'kb_bible_commit') return envelope;
    const body = JSON.parse(envelope.content[0].text) as { merged: string[]; skipped: { id: string; reason: string }[] };
    const drifted = body.skipped.filter((x) => x.reason === 'basis_mismatch').map((x) => x.id);
    if (drifted.length === 0) return envelope;
    const admitted = { ...body, merged: [...body.merged, ...drifted], skipped: body.skipped.filter((x) => x.reason !== 'basis_mismatch') };
    return { ...envelope, content: [{ ...envelope.content[0], text: JSON.stringify(admitted) }] };
  }
}

describe('memory-contract/v1 round trip: a provider that admits a drifted id fails the basis-mismatch step', () => {
  const provider = new AdmitsDriftedEntryProvider();

  afterAll(() => {
    provider.dispose();
  });

  it('reports exactly the kb_bible_commit/basis-mismatch step as failed', async () => {
    const report = await runRoundTrip(provider, ROSTER);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^kb_bible_commit\/basis-mismatch: expected merged to be empty/);
  }, 120_000);
});
