import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Truthful gitnexus readiness (placeholder meta.json, incrementalInProgress,
// held analyze lock) and indexedCommit on every registered code_* tool result.

vi.mock('../src/services/registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});

import { codeIndexReadiness, readGitNexusIndexState } from '../src/tools/code-intelligence-readiness.js';
import { REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';
import {
  handleCodeGraph, handleCodeImpact, handleCodeQuery, handleCodeContext,
  handleCodeMap, handleCodeFlow, handleCodeTests, handleCodeReindex, handleCodeStatus, withIndexedCommit,
} from '../src/tools/code-intelligence.js';

let scratch: string;
let n = 0;

function repoWith(meta: Record<string, unknown> | null, lock?: Record<string, unknown> | string): string {
  const dir = path.join(scratch, `r${n++}`);
  fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), JSON.stringify(meta));
  if (lock !== undefined) {
    fs.writeFileSync(path.join(dir, '.gitnexus', 'analyze.lock'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  }
  return dir;
}

beforeAll(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ready-')); });
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('gitnexus readiness', () => {
  it('a real meta.json with a lastCommit is ready', () => {
    expect(codeIndexReadiness('gitnexus', repoWith({ lastCommit: 'abc123' }))).toEqual({ ready: true });
  });

  it('placeholder meta.json (lastCommit empty) is not ready', () => {
    const r = codeIndexReadiness('gitnexus', repoWith({ lastCommit: '' }));
    expect(r.ready).toBe(false);
  });

  it('incrementalInProgress is not ready (building)', () => {
    const r = codeIndexReadiness('gitnexus', repoWith({ lastCommit: 'abc', incrementalInProgress: { startedAt: 1 } }));
    expect(r).toEqual({ ready: false, state: 'building' });
  });

  it('a held analyze lock (live pid) is not ready; a dead holder is ignored', () => {
    const held = repoWith({ lastCommit: 'abc' }, { pid: process.pid, token: 't' });
    expect(codeIndexReadiness('gitnexus', held)).toEqual({ ready: false, state: 'building' });
    const dead = repoWith({ lastCommit: 'abc' }, { pid: 2147483646, token: 't' });
    expect(codeIndexReadiness('gitnexus', dead)).toEqual({ ready: true });
    expect(readGitNexusIndexState(held).lockHeld).toBe(true);
  });

  it('an unparseable lock file counts as held', () => {
    expect(codeIndexReadiness('gitnexus', repoWith({ lastCommit: 'abc' }, '{half')).ready).toBe(false);
  });
});

describe('indexedCommit on every code_* result', () => {
  const cases: Array<[string, keyof GitNexusProvider, (i: Record<string, unknown>, s: { repo: string }) => Promise<unknown>]> = [
    ['code_graph', 'graph', handleCodeGraph],
    ['code_impact', 'impact', handleCodeImpact],
    ['code_query', 'query', handleCodeQuery],
    ['code_context', 'context', handleCodeContext],
    ['code_map', 'map', handleCodeMap],
    ['code_flow', 'flow', handleCodeFlow],
    ['code_tests', 'tests', handleCodeTests],
  ];

  // code_reindex / code_status are not provider-backed: they read the index
  // state directly. A held analyze lock (live pid) makes code_reindex answer
  // 'already-running' without spawning anything, so no analyze runs here.
  const indexCases: Array<[string, (i: Record<string, unknown>, s: { repo: string; remote?: boolean }) => Promise<unknown>]> = [
    ['code_reindex', handleCodeReindex as (i: Record<string, unknown>, s: { repo: string }) => Promise<unknown>],
    ['code_status', handleCodeStatus as (i: Record<string, unknown>, s: { repo: string }) => Promise<unknown>],
  ];

  it('the parameterised cases cover every registered code_* tool, with no exclusions', () => {
    const registered = REGISTERED_TOOL_NAMES.filter(n => n.startsWith('code_'));
    expect([...cases.map(c => c[0]), ...indexCases.map(c => c[0])].sort()).toEqual([...registered].sort());
  });

  it.each(indexCases)('%s carries indexedCommit (local and remote)', async (_tool, handler) => {
    const repo = repoWith({ lastCommit: 'deadbeef' }, { pid: process.pid, token: 't' });
    const out = await handler({}, { repo, memberId: 'm' } as { repo: string }) as { indexedCommit: string | null };
    expect(out.indexedCommit).toBe('deadbeef');
    const remote = await handler({}, { repo, memberId: 'm', remote: true } as { repo: string }) as Record<string, unknown>;
    expect(remote).toHaveProperty('indexedCommit', null);
  });

  it.each(cases)('%s carries indexedCommit', async (_tool, method, handler) => {
    const repo = repoWith({ lastCommit: 'deadbeef' });
    const spy = vi.spyOn(GitNexusProvider.prototype, method as 'graph')
      .mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
    try {
      const out = await handler({}, { repo, memberId: 'm' }) as { indexedCommit: string; content: unknown[] };
      expect(out.indexedCommit).toBe('deadbeef');
      expect(out.content).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('withIndexedCommit wraps non-object results and nulls an unknown commit', () => {
    expect(withIndexedCommit('x', null)).toEqual({ result: 'x', indexedCommit: null });
    expect(withIndexedCommit({ a: 1 }, '')).toEqual({ a: 1, indexedCommit: null });
  });
});
