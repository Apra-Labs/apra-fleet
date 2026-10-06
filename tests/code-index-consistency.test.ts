import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The code_* consistency gate: a gitnexus index is never served while an
// analyze is rewriting it, nor when its metadata disagrees with itself, and a
// code_impact / code_context answer about a different symbol than requested
// is flagged instead of reading as a confident answer.
//
// Isolation: the gitnexus MCP child is a mocked Client (no npx is spawned);
// its callTool is the "fake gitnexus" -- it can rewrite .gitnexus/meta.json
// mid-call the way an analyze finishing under it would. isReindexRunning is
// wrapped so a background reindex can be marked in flight without spawning
// one, and maybeScheduleReindex is stubbed. GITNEXUS_HOME (the gitnexus
// registry) and APRA_FLEET_DATA_DIR (fleet's status.json) point into one
// scratch dir removed in afterAll.

const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-consistency-')));
  const data = path.join(root, 'data');
  const gnHome = path.join(root, 'gitnexus-home');
  fs.mkdirSync(data);
  fs.mkdirSync(gnHome);
  process.env.APRA_FLEET_DATA_DIR = data;
  process.env.GITNEXUS_HOME = gnHome;
  return { root, data, gnHome };
});

const reindexRunning = vi.hoisted(() => new Set<string>());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn(async () => undefined));
const clientCtor = vi.hoisted(() => vi.fn());

vi.mock('../src/tools/code-intelligence-reindex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence-reindex.js')>();
  return {
    ...actual,
    isReindexRunning: (repo: string) => reindexRunning.has(repo) || actual.isReindexRunning(repo),
    maybeScheduleReindex: () => false,
  };
});
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});
vi.mock('../src/utils/find-on-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/find-on-path.js')>()),
  npxUnavailableReason: () => null,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    constructor() { clientCtor(); }
    connect = vi.fn(async () => undefined);
    callTool = mockCallTool;
    close = mockClose;
  }
  return { Client: MockClient };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransport {}
  return { StdioClientTransport: MockTransport };
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleCodeImpact, handleCodeContext, handleCodeStatus } from '../src/tools/code-intelligence.js';
import { codeIndexReadiness, ensureGitNexusIndexReady, CodeIntelError } from '../src/tools/code-intelligence-readiness.js';
import { codeIndexDir } from '../src/tools/code-intelligence-reindex.js';
import { flagResolutionMismatch, resolvesToRequested } from '../src/tools/code-intelligence-gitnexus.js';
import { scheduleIndexBuild } from '../src/tools/code-index-heal.js';

const schedule = vi.mocked(scheduleIndexBuild);
let n = 0;

function newRepo(meta: Record<string, unknown>): string {
  const dir = path.join(sandbox.root, `repo${n++}`);
  fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeMeta(dir, meta);
  return dir;
}

function writeMeta(repo: string, meta: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), JSON.stringify(meta));
}

function writeRegistry(entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(sandbox.gnHome, 'registry.json'), JSON.stringify(entries));
}

function writeFleetStatus(repo: string, status: Record<string, unknown>): void {
  const dir = codeIndexDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    repo, pid: null, started: '2026-01-01T00:00:00.000Z', lockHeld: false, lastLine: '', lineCount: 1,
    phase: 'done', result: 'indexed', exitCode: 0, finished: '2026-01-01T00:05:00.000Z', ...status,
  }));
}

/** An impact payload as gitnexus's child returns it (JSON text + hint suffix). */
function impactResult(target: { name: string; id?: string; filePath?: string }, risk = 'HIGH'): unknown {
  const payload = {
    target: { id: target.id ?? `Function:${target.filePath ?? 'src/a.ts'}:${target.name}`, name: target.name, type: 'Function', filePath: target.filePath ?? 'src/a.ts' },
    direction: 'upstream', impactedCount: 12, risk,
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + '\n\n---\n**Next:** Review d=1 items first.' }] };
}

function contextResult(name: string, filePath = 'src/a.ts'): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'found', symbol: { uid: `Function:${filePath}:${name}`, name, filePath }, incoming: {}, outgoing: {} }) }] };
}

function payloadOf(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0].text.split('\n\n---\n')[0];
  return JSON.parse(text) as Record<string, unknown>;
}

async function rejection(p: Promise<unknown>): Promise<CodeIntelError> {
  try { await p; } catch (e) { return e as CodeIntelError; }
  throw new Error('expected a rejection');
}

const READY = { lastCommit: 'a'.repeat(40), indexedAt: '2026-01-01T00:04:00.000Z' };

beforeAll(() => { /* sandbox created in vi.hoisted */ });
afterAll(() => {
  delete process.env.GITNEXUS_HOME;
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});
beforeEach(() => {
  schedule.mockReset();
  schedule.mockReturnValue({ started: true });
  mockCallTool.mockReset();
  fs.rmSync(path.join(sandbox.gnHome, 'registry.json'), { force: true });
});
afterEach(() => { reindexRunning.clear(); });

describe('a background reindex over an existing index is never served', () => {
  it('code_impact returns E-CODE-INDEX-NOT-READY (building) while a reindex runs, even though meta.json looks complete', async () => {
    const repo = newRepo(READY);
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: true });
    reindexRunning.add(repo);
    mockCallTool.mockResolvedValue(impactResult({ name: 'runUninstall' }));
    const err = await rejection(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }));
    expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
    expect(err.message).toContain('is still being built');
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'building' });
  });

  it('a fake gitnexus that rewrites meta.json mid-call: the answer is discarded, not returned', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockImplementation(async () => {
      // An analyze finishing under the call: the index generation changes.
      writeMeta(repo, { lastCommit: 'b'.repeat(40), indexedAt: '2026-01-01T00:09:00.000Z' });
      return impactResult({ name: 'claimBeadsBatched' });
    });
    const err = await rejection(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }));
    expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
    expect(err.message).toContain('was replaced by an index build while this call was answered; the answer was discarded');
    expect(err.message).not.toMatch(/claimBeadsBatched|HIGH/);
  });

  it('a fake gitnexus that marks the index mid-write during the call: discarded as not ready', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockImplementation(async () => {
      writeMeta(repo, { ...READY, incrementalInProgress: { startedAt: 1 } });
      return impactResult({ name: 'runUninstall' });
    });
    const err = await rejection(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }));
    expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
    expect(err.message).toMatch(/changed while this call was answered and is now interrupted/);
  });

  it('after the index generation changes, the long-lived gitnexus child is recycled before the next call', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockResolvedValue(impactResult({ name: 'runUninstall' }));
    await handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' });
    const built = clientCtor.mock.calls.length;
    const closed = mockClose.mock.calls.length;
    // A rebuild completed between calls.
    writeMeta(repo, { lastCommit: 'c'.repeat(40), indexedAt: '2026-01-01T00:20:00.000Z' });
    const out = await handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(clientCtor.mock.calls.length).toBe(built + 1);
    expect(mockClose.mock.calls.length).toBe(closed + 1);
    expect(out.indexedCommit).toBe('c'.repeat(40));
  });
});

describe('inconsistent fleet-vs-gitnexus index metadata is not ready', () => {
  it('gitnexus registry names a different commit than meta.json => inconsistent', () => {
    const repo = newRepo(READY);
    writeRegistry([{ name: 'r', path: repo, storagePath: path.join(repo, '.gitnexus'), lastCommit: 'd'.repeat(40) }]);
    const r = codeIndexReadiness('gitnexus', repo);
    expect(r).toMatchObject({ ready: false, state: 'inconsistent' });
    expect(r.ready === false && r.detail).toContain(`registry records the index at dddddddd but its meta.json says aaaaaaaa`);
  });

  it('a registry entry that agrees, or one for another folder, leaves the index ready', () => {
    const repo = newRepo(READY);
    writeRegistry([
      { storagePath: path.join(repo, '.gitnexus'), lastCommit: READY.lastCommit },
      { storagePath: path.join(sandbox.root, 'elsewhere', '.gitnexus'), lastCommit: 'e'.repeat(40) },
    ]);
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: true });
  });

  it("fleet's recorded build commit differs from meta.json (not rewritten since) => inconsistent", () => {
    const repo = newRepo(READY);
    writeFleetStatus(repo, { indexedCommit: 'f'.repeat(40) });
    const r = codeIndexReadiness('gitnexus', repo);
    expect(r).toMatchObject({ ready: false, state: 'inconsistent' });
    expect(r.ready === false && r.detail).toContain("fleet's last analyze recorded the index at ffffffff but meta.json now says aaaaaaaa");
  });

  it('a later analyze (meta indexedAt after fleet\'s run finished) is trusted, not flagged', () => {
    const repo = newRepo({ ...READY, indexedAt: '2026-01-02T00:00:00.000Z' });
    writeFleetStatus(repo, { indexedCommit: 'f'.repeat(40) });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: true });
  });

  it('the pre-flight heals an inconsistent index (requests a build) and code_impact never answers', async () => {
    const repo = newRepo(READY);
    writeFleetStatus(repo, { indexedCommit: 'f'.repeat(40) });
    expect(() => ensureGitNexusIndexReady(repo)).toThrow(/has inconsistent metadata \(fleet's last analyze recorded/);
    expect(schedule).toHaveBeenCalledWith(repo);
    mockCallTool.mockResolvedValue(impactResult({ name: 'runUninstall' }));
    const err = await rejection(handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }));
    expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
    expect(err.message).toContain('An index build was requested automatically.');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('code_status reports readiness inconsistent with the reason', async () => {
    const repo = newRepo(READY);
    writeRegistry([{ storagePath: path.join(repo, '.gitnexus'), lastCommit: 'd'.repeat(40) }]);
    const out = await handleCodeStatus({}, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out).toMatchObject({ ready: false, readiness: 'inconsistent' });
    expect(out.inconsistency).toMatch(/registry records the index at dddddddd/);
  });
});

describe('a lookup that resolves to a different symbol is flagged, never HIGH', () => {
  it('code_impact: resolution_mismatch, confidence LOW, risk UNKNOWN (HIGH kept only as unverified_risk)', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockResolvedValue(impactResult({ name: 'claimBeadsBatched', filePath: 'scripts/beads-children.mjs' }));
    const out = await handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out.resolution_mismatch).toEqual({
      requested: 'runUninstall',
      resolved: { name: 'claimBeadsBatched', id: 'Function:scripts/beads-children.mjs:claimBeadsBatched', filePath: 'scripts/beads-children.mjs' },
    });
    expect(out.confidence).toBe('LOW');
    const payload = payloadOf(out);
    expect(payload.risk).toBe('UNKNOWN');
    expect(payload.unverified_risk).toBe('HIGH');
    expect(payload.confidence).toBe('LOW');
    const texts = (out.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(texts).toContain("RESOLUTION MISMATCH: 'runUninstall' resolved to a different symbol, claimBeadsBatched (scripts/beads-children.mjs)");
    expect(texts).toContain('**Next:**');
  });

  it('incident shape: name equals the request but the id names another symbol -> flagged, risk UNKNOWN', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockResolvedValue(impactResult({ name: 'runUninstall', id: 'beads-children.mjs:claimBeadsBatched', filePath: 'src/cli/uninstall.ts' }));
    const out = await handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out.resolution_mismatch).toEqual({
      requested: 'runUninstall',
      resolved: { name: 'runUninstall', id: 'beads-children.mjs:claimBeadsBatched', filePath: 'src/cli/uninstall.ts' },
    });
    expect(out.confidence).toBe('LOW');
    const payload = payloadOf(out);
    expect(payload.risk).toBe('UNKNOWN');
    expect(payload.unverified_risk).toBe('HIGH');
    const texts = (out.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(texts).toContain('id beads-children.mjs:claimBeadsBatched');
  });

  it('a uid whose symbol matches but whose file disagrees with filePath is flagged', () => {
    expect(resolvesToRequested('runUninstall', {
      name: 'runUninstall', id: 'Function:scripts/beads-children.mjs:claimBeadsBatched', filePath: 'scripts/beads-children.mjs',
    })).toBe(false);
    expect(resolvesToRequested('runUninstall', {
      name: 'runUninstall', id: 'Function:scripts/beads-children.mjs:runUninstall', filePath: 'src/cli/uninstall.ts',
    })).toBe(false);
    expect(resolvesToRequested('runUninstall', { id: 'beads-children.mjs:claimBeadsBatched' })).toBe(false);
    // Consistent forms still pass: matching uid, '::' symbols, file nodes, id-only.
    expect(resolvesToRequested('runUninstall', {
      name: 'runUninstall', id: 'Function:src/cli/uninstall.ts:runUninstall', filePath: 'src/cli/uninstall.ts',
    })).toBe(true);
    expect(resolvesToRequested('fn', { name: 'fn', id: 'Function:src/a.rs:ns::fn', filePath: 'src/a.rs' })).toBe(true);
    expect(resolvesToRequested('a.ts', { name: 'a.ts', id: 'File:src/a.ts', filePath: 'src/a.ts' })).toBe(true);
    expect(resolvesToRequested('runUninstall', { id: 'uninstall.ts:runUninstall' })).toBe(true);
  });

  it('code_context: a different resolved symbol is flagged', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockResolvedValue(contextResult('claimBeadsBatched'));
    const out = await handleCodeContext({ name: 'runUninstall' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out).toMatchObject({ confidence: 'LOW', resolution_mismatch: { requested: 'runUninstall', resolved: { name: 'claimBeadsBatched' } } });
  });

  it('a matching resolution is returned unchanged (HIGH stays HIGH, no flag)', async () => {
    const repo = newRepo(READY);
    mockCallTool.mockResolvedValue(impactResult({ name: 'runUninstall' }));
    const out = await handleCodeImpact({ target: 'runUninstall', direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out.resolution_mismatch).toBeUndefined();
    expect(out.confidence).toBeUndefined();
    expect(payloadOf(out).risk).toBe('HIGH');
  });

  it('resolvesToRequested accepts the name, uid, file path and qualified forms only', () => {
    const sym = { name: 'run', id: 'Method:src/a.ts:Svc.run', filePath: 'src/a.ts' };
    for (const req of ['run', 'Method:src/a.ts:Svc.run', 'src/a.ts', 'Svc.run', 'ns::run', 'Svc#run', 'src/a.ts:run']) {
      expect(resolvesToRequested(req, sym), req).toBe(true);
    }
    for (const req of ['runUninstall', 'Run', 'rerun']) expect(resolvesToRequested(req, sym), req).toBe(false);
    expect(resolvesToRequested('x', {})).toBe(true);
  });

  it('error results, ambiguous results and non-JSON text pass through untouched', () => {
    const err = { content: [{ type: 'text', text: 'boom' }], isError: true };
    expect(flagResolutionMismatch(err, 'x', 'impact')).toBe(err);
    const ambiguous = { content: [{ type: 'text', text: JSON.stringify({ status: 'ambiguous', candidates: [] }) }] };
    expect(flagResolutionMismatch(ambiguous, 'x', 'impact')).toBe(ambiguous);
    const text = { content: [{ type: 'text', text: 'not json' }] };
    expect(flagResolutionMismatch(text, 'x', 'context')).toBe(text);
  });
});
