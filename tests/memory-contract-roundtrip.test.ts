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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { registerAllTools } from '../src/services/tool-registry.js';
import { memberToolScope } from '../src/services/tool-scope.js';
import { addAgent, removeAgent } from '../src/services/registry.js';
import { resolveProjectSlug } from '../src/services/knowledge/project-slug.js';
import {
  runRoundTrip,
  RECORDED_REMOTE_A,
  RECORDED_REMOTE_B,
  RECORDED_REMOTE_IMPORT_REJECTED,
} from '../memory-contract/v1/tests/roundtrip-harness.mjs';
import { materializeSessionWorld } from '../memory-contract/v1/tests/session-world.mjs';
import { KB_MODULES, CODE_EXPORTS } from '../memory-contract/v1/generate-contract.mjs';
import {
  createResponseConformanceRecorder,
  formatConformanceReport,
  validateToolResponse,
  schemaDeclaresParsedBody,
  LIVE_SERVICE_SKIPS,
} from '../memory-contract/v1/tests/response-conformance.mjs';

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
  op: 'write' | 'delete';
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
};

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
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-roundtrip-'));
    const world = await materializeSessionWorld(env, this.root, {
      remoteUrl: (key: string) => this.liveRemote(key),
      addAgent,
      removeAgent,
      registerAllTools,
      memberToolScope,
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

// apra-fleet-i9ag.15.16.2: the live round trip and the response-conformance
// lane share ONE dispatch of the corpus. Driving the 23 real handlers twice
// (once per entry point) would double a multi-minute suite's wall clock for a
// second copy of the same evidence, and the two copies would drift; instead
// the conformance recorder observes THIS run's live responses via
// runRoundTrip's onLiveResponse hook and does its own independent validation
// and coverage accounting over them.
const conformance = createResponseConformanceRecorder({ roster: ROSTER, skips: LIVE_SERVICE_SKIPS });

/**
 * One REAL live decoded envelope per tool, kept so the lane's non-vacuity
 * probes below can mutate an actual payload this run produced rather than a
 * hand-authored stand-in (a hand-authored one could pass or fail for reasons
 * that have nothing to do with what the handlers really emit). Mutations are
 * always made on a structured-clone copy -- never on this map's value, and
 * never on a committed fixture or a generated schema.
 */
const liveSamples = new Map<string, { parsed: Record<string, unknown> } & Record<string, unknown>>();
const observeLiveResponse = (observation: { tool: string; decoded: unknown }) => {
  if (!liveSamples.has(observation.tool)) {
    liveSamples.set(observation.tool, observation.decoded as never);
  }
  (conformance.onLiveResponse as (o: unknown) => void)(observation);
};

describe('memory-contract/v1 round trip (sqlite provider)', () => {
  let report: Awaited<ReturnType<typeof runRoundTrip>>;
  const provider = new SqliteContractProvider();

  beforeAll(async () => {
    report = await runRoundTrip(provider, ROSTER, {
      onLiveResponse: observeLiveResponse,
    });
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
    expect(report.steps.length).toBe(74); // 73 + kb_stats/edge-empty-promote-ratio-null (apra-fleet-i9ag.15.17, session B); 73 = 64 + kb_list/happy-confidence-string + 4 E-SCOPE-KEY-REMOVED refusals (one per kb_* family); 63 + kb_feedback/happy (FULL, non-member session); 61 (code_reindex/code_status outcomes, kb + code (self) refusals, code_query/refusal-intel-disabled on top of 48 + kb_query/happy-confirmed-only) + kb_bible_commit happy and refusal
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

  // apra-fleet-i9ag.15.16.2: THE LIVE RESPONSE-CONFORMANCE LANE.
  //
  // Nested inside this describe on purpose, so it runs against the SAME
  // dispatch the outer beforeAll performed -- see the recorder's comment
  // above for why a second dispatch was rejected. The accounting itself lives
  // in memory-contract/v1/tests/response-conformance.mjs, which re-validates
  // every observed payload with its own ajv instance rather than trusting the
  // round trip's verdict, so this lane cannot be left silently green by an
  // upstream check that stopped running.
  describe('live response conformance lane', () => {
    it('validated a REAL response for every inventoried tool, and reports the covered count and every skip with its reason', () => {
      const conformanceReport = conformance.report();

      // Printed unconditionally: a coverage claim nobody can read is the same
      // blind spot as no coverage claim at all.
      // eslint-disable-next-line no-console
      console.log(`\n${formatConformanceReport(conformanceReport)}\n`);

      expect(conformanceReport.failures).toEqual([]);
      expect(conformanceReport.uncovered).toEqual([]);
      // Every roster tool is accounted for exactly once, as covered or as an
      // explicitly-reasoned skip. Nothing may fall between the two.
      expect(conformanceReport.covered.length + conformanceReport.skipped.length).toBe(ROSTER.length);
      expect(ROSTER.length).toBe(26);
      // Non-vacuity floor: at least one live response per tool really was
      // validated, so an empty observation stream cannot read as full coverage.
      expect(conformanceReport.responsesValidated).toBeGreaterThanOrEqual(ROSTER.length);
      for (const skip of conformanceReport.skipped) {
        expect(skip.reason.trim().length).toBeGreaterThan(0);
      }
    });

    it('every tool whose schema declares a TYPED parsed body actually reached that body live', () => {
      // Without this, a tool could "pass" the lane on an envelope whose parsed
      // body never materialised -- the body's own additionalProperties:false
      // would then police nothing, which is exactly how the kb_stats
      // degraded-field drift got through review.
      const typed = ROSTER.filter((tool) => schemaDeclaresParsedBody(tool));
      // 15 of 26: the 9 code_* tools, kb_invalidate (two response shapes) and kb_query declare `parsed` as an
      // unconstrained schema (their zod shape is z.unknown()), so reaching it
      // proves nothing and is not required of them.
      expect(typed.length).toBe(15);
      expect(ROSTER.filter((tool) => !schemaDeclaresParsedBody(tool)).sort()).toEqual(
        ['code_context', 'code_flow', 'code_graph', 'code_impact', 'code_map', 'code_query', 'code_reindex', 'code_status', 'code_tests', 'kb_invalidate', 'kb_query'],
      );

      const unreached = conformance
        .report()
        .covered.filter((c) => c.declaresParsedBody && !c.parsedReached)
        .map((c) => c.tool);
      expect(unreached).toEqual([]);
    });

    it('is NOT vacuous: an undeclared field on a real live payload FAILS, naming the tool and the field', () => {
      const live = liveSamples.get('kb_capture');
      expect(live).toBeDefined();

      // Positive control first: the unmutated live payload passes, so the
      // failure below is attributable to the mutation and not to an always-red
      // lane.
      expect(validateToolResponse('kb_capture', live).valid).toBe(true);

      const mutated = structuredClone(live) as { parsed: Record<string, unknown> };
      mutated.parsed.undeclared_drift_field = 'shipped without a schema change';
      const result = validateToolResponse('kb_capture', mutated);
      expect(result.valid).toBe(false);
      // The offending FIELD must be named, not just the instance path: ajv puts
      // it in params.additionalProperty and leaves it out of both instancePath
      // and message, so drift reported without it is unactionable.
      expect(result.errors).toContain('undeclared_drift_field');
      expect(result.errors).toContain('/parsed');
    });

    it('is NOT vacuous: nullability drift on a real live payload FAILS', () => {
      const live = liveSamples.get('kb_capture');
      expect(live).toBeDefined();
      expect(validateToolResponse('kb_capture', live).valid).toBe(true);

      // kb_capture.parsed.id is declared `string` with no null member (unlike
      // kb_stats.parsed.promote_ratio, which IS ["number","null"]), so a
      // handler that started returning null here is drift the schema must
      // reject.
      const mutated = structuredClone(live) as { parsed: Record<string, unknown> };
      mutated.parsed.id = null;
      const result = validateToolResponse('kb_capture', mutated);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('/parsed/id');
      expect(result.errors).toContain('must be string');
    });
  });
});
