import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A gitnexus index left mid-write by a dead analyze (meta.json
// incrementalInProgress, no lock, nothing running) reads as 'interrupted', not
// 'building', and the code_* pre-flight heals missing/interrupted indexes by
// starting a background build before it throws E-CODE-INDEX-NOT-READY.
//
// Isolation: tests/setup.ts replaces scheduleIndexBuild (the self-heal seam)
// with a fake, so nothing here spawns npx. The real scheduleReindex is only
// driven down paths that return before any spawn (config disabled, no npx on
// PATH). os.homedir is redirected so the auto-reindex config.json read here
// is a scratch file.

// Resolved before any module loads: the reindex module reads homedir() once.
const fakeHome = await vi.hoisted(async () => {
  const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const realOs = await vi.importActual<typeof import('node:os')>('node:os');
  const realPath = await vi.importActual<typeof import('node:path')>('node:path');
  return { dir: realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'code-interrupted-home-')) };
});
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => fakeHome.dir || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../src/services/registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});

import {
  codeIndexReadiness, ensureGitNexusIndexReady, indexNotReadyError, CodeIntelError,
} from '../src/tools/code-intelligence-readiness.js';
import { scheduleIndexBuild } from '../src/tools/code-index-heal.js';
import { missingOnServerPathMessage } from '../src/utils/find-on-path.js';
import { codeIndexDir, isRecordedAnalyzeAlive, scheduleReindex, RECORDED_ANALYZE_MAX_AGE_MS } from '../src/tools/code-intelligence-reindex.js';
import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';
import { handleCodeStatus, handleCodeQuery } from '../src/tools/code-intelligence.js';

const DEAD_PID = 2147483646;
let scratch: string;
let n = 0;

function repoWith(meta: Record<string, unknown> | null, opts: { lock?: Record<string, unknown>; noDir?: boolean } = {}): string {
  // A unique git repo per case: codeIndexDir is keyed by the repo's slug
  // (its root dir name here), so non-git or same-named dirs would share one.
  const dir = path.join(scratch, `cii-${process.pid}-${Date.now().toString(36)}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (!opts.noDir) fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), JSON.stringify(meta));
  if (opts.lock) fs.writeFileSync(path.join(dir, '.gitnexus', 'analyze.lock'), JSON.stringify(opts.lock));
  return dir;
}

function writeStatus(repo: string, status: Record<string, unknown>): void {
  const dir = codeIndexDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    repo, pid: null, started: new Date().toISOString(), lockHeld: false, lastLine: '', lineCount: 0,
    phase: 'running', result: null, exitCode: null, ...status,
  }));
}

const INTERRUPTED_META = { lastCommit: 'abc', incrementalInProgress: { startedAt: 1 } };

function thrown(fn: () => void): CodeIntelError {
  try { fn(); } catch (e) { return e as CodeIntelError; }
  throw new Error('expected a throw');
}

const schedule = vi.mocked(scheduleIndexBuild);

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-interrupted-')));
});
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(fakeHome.dir, { recursive: true, force: true });
});
beforeEach(() => {
  schedule.mockReset();
  schedule.mockReturnValue({ started: true });
});

describe('readiness: interrupted vs building vs missing', () => {
  it('incrementalInProgress, no lock, nothing running, no status => interrupted', () => {
    expect(codeIndexReadiness('gitnexus', repoWith(INTERRUPTED_META))).toEqual({ ready: false, state: 'interrupted' });
  });

  it('incrementalInProgress with the analyze lock held => building', () => {
    const repo = repoWith(INTERRUPTED_META, { lock: { pid: process.pid, token: 't' } });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'building' });
  });

  it('incrementalInProgress with a live recorded analyze (status.json pid alive) => building', () => {
    const repo = repoWith(INTERRUPTED_META);
    writeStatus(repo, { pid: process.pid, phase: 'running' });
    expect(isRecordedAnalyzeAlive(repo)).toBe(true);
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'building' });
  });

  it('a live recorded analyze of ANOTHER folder sharing the slug dir is not trusted', () => {
    const repo = repoWith(INTERRUPTED_META);
    writeStatus(repo, { repo: path.join(scratch, 'elsewhere'), pid: process.pid, phase: 'running' });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'interrupted' });
  });

  it('a recorded analyze with a dead pid => interrupted', () => {
    const repo = repoWith(INTERRUPTED_META);
    writeStatus(repo, { pid: DEAD_PID, phase: 'running' });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'interrupted' });
  });

  it('a recorded analyze marked done (even with a live pid) => interrupted', () => {
    const repo = repoWith(INTERRUPTED_META);
    writeStatus(repo, { pid: process.pid, phase: 'done' });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'interrupted' });
  });

  it('an implausibly old recorded run is not trusted by its (possibly reused) pid', () => {
    const repo = repoWith(INTERRUPTED_META);
    writeStatus(repo, { pid: process.pid, started: new Date(Date.now() - RECORDED_ANALYZE_MAX_AGE_MS - 60_000).toISOString() });
    expect(codeIndexReadiness('gitnexus', repo)).toEqual({ ready: false, state: 'interrupted' });
  });

  it('no index at all => missing; a bare .gitnexus dir with no live analyze => missing', () => {
    expect(codeIndexReadiness('gitnexus', repoWith(null, { noDir: true }))).toEqual({ ready: false, state: 'missing' });
    expect(codeIndexReadiness('gitnexus', repoWith(null))).toEqual({ ready: false, state: 'missing' });
  });

  it('a bare .gitnexus dir with a live lock => building', () => {
    expect(codeIndexReadiness('gitnexus', repoWith(null, { lock: { pid: process.pid } }))).toEqual({ ready: false, state: 'building' });
  });

  it('readiness never schedules a build (pure)', () => {
    codeIndexReadiness('gitnexus', repoWith(INTERRUPTED_META));
    codeIndexReadiness('gitnexus', repoWith(null, { noDir: true }));
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('pre-flight self-heal (ensureGitNexusIndexReady)', () => {
  it('interrupted: schedules a build, then throws saying it started (no manual npx)', () => {
    const repo = repoWith(INTERRUPTED_META);
    const err = thrown(() => ensureGitNexusIndexReady(repo));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(repo);
    expect(err.code).toBe('E-CODE-INDEX-NOT-READY');
    expect(err.message).toContain('is marked incomplete and no running analyze was found');
    expect(err.message).toContain('An index build was requested automatically.');
    expect(err.remediation).toMatch(/Retry the same call in a minute/);
    expect(err.message).not.toMatch(/npx/);
    expect(err.message.split('Remediation:')).toHaveLength(2);
  });

  it('missing: schedules a build', () => {
    const repo = repoWith(null, { noDir: true });
    const err = thrown(() => ensureGitNexusIndexReady(repo));
    expect(schedule).toHaveBeenCalledWith(repo);
    expect(err.message).toContain('No gitnexus code index found');
    expect(err.message).not.toMatch(/npx/);
  });

  it('building: never schedules, says retry', () => {
    const repo = repoWith(INTERRUPTED_META, { lock: { pid: process.pid } });
    const err = thrown(() => ensureGitNexusIndexReady(repo));
    expect(schedule).not.toHaveBeenCalled();
    expect(err.message).toContain('is still being built.');
    expect(err.message).not.toMatch(/npx/);
  });

  it('ready: returns without scheduling', () => {
    expect(() => ensureGitNexusIndexReady(repoWith({ lastCommit: 'abc' }))).not.toThrow();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('remote member folder: never schedules, says the folder is on another host', () => {
    const repo = repoWith(INTERRUPTED_META);
    const err = thrown(() => ensureGitNexusIndexReady(repo, { remote: true }));
    expect(schedule).not.toHaveBeenCalled();
    expect(err.message).toContain('not on this host');
  });

  it('a folder that does not exist on this host: never schedules', () => {
    const err = thrown(() => ensureGitNexusIndexReady(path.join(scratch, 'nowhere')));
    expect(schedule).not.toHaveBeenCalled();
    expect(err.message).toContain('not on this host');
  });

  it.each([
    [{ started: false, reason: 'disabled' } as const, /Automatic index builds are off/, /call code_reindex/i],
    [{ started: false, reason: 'cooldown', detail: 'x' } as const, /finished moments ago/, /code_reindex/],
    [{ started: false, reason: 'paused', pause: { result: 'failed', lastLine: 'out of memory', logPath: '/d/analyze.log', finished: 'f' } } as const,
      /Automatic rebuilds for this folder are paused: the last automatic analyze ended 'failed' without a ready index \(log: \/d\/analyze\.log, last line 'out of memory'\)/,
      /call code_reindex -- it retries the build and re-arms automatic rebuilds/],
    [{ started: false, reason: 'npx-not-found', detail: missingOnServerPathMessage('node (required by npx)', '/usr/bin:/bin') } as const,
      /cannot start a build: a tool it needs is not on its PATH/,
      /^node \(required by npx\) was not found on the apra-fleet server's PATH \(searched: \/usr\/bin:\/bin\)\. .*re-run 'apra-fleet install' to refresh the service PATH.* Then retry the same call\.$/],
    [{ started: false, reason: 'npx-not-found' } as const, /not on its PATH/, /npx was not found .*re-run 'apra-fleet install' to refresh the service PATH/],
    [{ started: false, reason: 'already-running' } as const, /already running/, /Retry the same call/],
    [{ started: false, reason: 'spawn-failed', detail: 'boom' } as const, /failed: spawn-failed \(boom\)/, /code_reindex/],
  ])('not started (%o): the message says why', (outcome, problem, remediation) => {
    schedule.mockReturnValue(outcome);
    const err = thrown(() => ensureGitNexusIndexReady(repoWith(INTERRUPTED_META)));
    expect(err.message).toMatch(problem);
    expect(err.remediation).toMatch(remediation);
    expect(err.remediation).not.toMatch(/npx gitnexus/);
    expect(err.message.split('Remediation:')).toHaveLength(2);
  });

  it('indexNotReadyError without a heal outcome points to code_reindex, not npx', () => {
    const err = indexNotReadyError('gitnexus', '/r', 'missing');
    expect(err.remediation).toMatch(/code_reindex/);
    expect(err.message).not.toMatch(/npx/);
  });
});

describe('wiring', () => {
  it('a provider call on an interrupted index schedules a build and throws before connecting', async () => {
    const repo = repoWith(INTERRUPTED_META);
    await expect(new GitNexusProvider().query({ query: 'x', repo })).rejects.toThrow(/requested automatically/);
    expect(schedule).toHaveBeenCalledWith(repo);
  });

  it('a remote member session never schedules a build for its folder', async () => {
    const repo = repoWith(INTERRUPTED_META);
    await expect(handleCodeQuery({ query: 'x' }, { repo, memberId: 'm', remote: true })).rejects.toThrow(/not on this host/);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('code_status reports interrupted and a null logPath when no analyze has run', async () => {
    const repo = repoWith(INTERRUPTED_META);
    const out = await handleCodeStatus({}, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out).toMatchObject({ ready: false, readiness: 'interrupted', incrementalInProgress: true, lockHeld: false, logPath: null, analyze: null });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('code_status presents logPath once an analyze log exists', async () => {
    const repo = repoWith({ lastCommit: 'abc' });
    const dir = codeIndexDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'analyze.log'), 'x\n');
    const out = await handleCodeStatus({}, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(out).toMatchObject({ readiness: 'ready', logPath: path.join(dir, 'analyze.log') });
  });
});

describe('scheduleReindex (real) reports why it did not start', () => {
  it('autoReindex.enabled=false => disabled, nothing spawned', () => {
    const cfgDir = path.join(fakeHome.dir, '.apra-fleet', 'data', 'code-intelligence');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ autoReindex: { enabled: false } }));
    try {
      expect(scheduleReindex(repoWith(INTERRUPTED_META))).toEqual({ started: false, reason: 'disabled' });
    } finally { fs.rmSync(path.join(cfgDir, 'config.json'), { force: true }); }
  });

  it('no npx on PATH => npx-not-found, nothing spawned', () => {
    const repo = repoWith(INTERRUPTED_META);
    const saved = process.env.PATH;
    process.env.PATH = path.join(scratch, 'empty-bin');
    try {
      const out = scheduleReindex(repo);
      expect(out).toMatchObject({ started: false, reason: 'npx-not-found' });
      // The heal message carries the scheduler's detail: PATH searched + install/refresh remedy.
      const err = indexNotReadyError('gitnexus', repo, 'interrupted', out);
      expect(err.remediation).toContain(`searched: ${process.env.PATH}`);
      expect(err.remediation).toContain("re-run 'apra-fleet install' to refresh the service PATH");
    } finally { process.env.PATH = saved; }
  });
});
