import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// kb (self) / code (self) scope resolution must not spawn git synchronously on
// every tool call (src/services/knowledge/kb-self.ts, "Per-folder git answer
// cache"). Each kb_* tool resolves through resolveSelfAnchor and each code_*
// tool through resolveCodeSelf; both reach gitOut. child_process is wrapped
// with counting pass-throughs so the REAL git runs and every spawn whose cwd is
// one of this test's folders is counted.
//
// Isolation: folders are temp git repos under one scratch root removed in
// afterAll; the registry is the isolated test registry, restored afterwards.

const spawns = vi.hoisted(() => ({ sync: [] as string[], async: [] as string[] }));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const cwdOf = (opts: unknown) => (opts && typeof opts === 'object' && 'cwd' in opts ? String((opts as { cwd: unknown }).cwd) : '');
  const execFileSync = ((file: string, args?: readonly string[], opts?: unknown) => {
    spawns.sync.push(cwdOf(opts));
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
  }) as typeof actual.execFileSync;
  const execFile = ((...a: unknown[]) => {
    spawns.async.push(cwdOf(a[2]));
    return (actual.execFile as (...b: unknown[]) => unknown)(...a);
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFileSync, execFile, default: { ...actual, execFileSync, execFile } };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  validateSelfFolder, resolveSelfAnchor, KbSelfError, GIT_CACHE_TTL_MS, _resetKbSelfGitCacheForTests, prewarmSelfGitCache,
} from '../../src/services/knowledge/kb-self.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { memberToolScope } from '../../src/services/tool-scope.js';
import { resolveCodeSelf } from '../../src/tools/code-intelligence.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { toSessionRoots } from '../../src/services/session-roots.js';
import { addAgent } from '../../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let scratch: string;

function gitRepo(name: string, withOrigin: boolean): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (withOrigin) execFileSync('git', ['remote', 'add', 'origin', `https://example.test/git-cache-${name}-${RUN}.git`], { cwd: dir });
  return dir;
}

/** Git spawns (sync, async) with cwd under the scratch root since the last reset. */
function counted(): { sync: number; async: number } {
  const ours = (c: string) => c.startsWith(scratch);
  return { sync: spawns.sync.filter(ours).length, async: spawns.async.filter(ours).length };
}
function resetCounts(): void {
  spawns.sync.length = 0;
  spawns.async.length = 0;
}

function selfError(fn: () => unknown): KbSelfError {
  try {
    fn();
  } catch (e) {
    if (e instanceof KbSelfError) return e;
    throw e;
  }
  throw new Error('expected a KbSelfError');
}

/** The error a cold (uncached) resolution gives for the same folder. */
function coldError(fn: () => unknown): KbSelfError {
  _resetKbSelfGitCacheForTests();
  return selfError(fn);
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-self-git-cache-')));
  backupAndResetRegistry();
});

afterAll(() => {
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  _resetKbSelfGitCacheForTests();
  resetCounts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kb (self) git cache: repeated calls on an unchanged folder do not spawn git', () => {
  it('MEMBER session: 50 kb and code resolutions spawn git only on the first call', () => {
    const dir = gitRepo('member-steady', true);
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-member-${RUN}`, workFolder: dir });
    addAgent(agent);
    resetCounts();

    const first = runWithSessionMember(agent.id, () => resolveSelfAnchor());
    expect(first.folder).toBe(dir);
    const afterFirst = counted();
    expect(afterFirst.sync).toBe(2); // rev-parse --git-dir, remote get-url origin

    for (let i = 0; i < 50; i++) {
      expect(runWithSessionMember(agent.id, () => resolveSelfAnchor()).folder).toBe(dir);
      expect(runWithSessionMember(agent.id, () => resolveCodeSelf()).repo).toBe(dir);
    }
    expect(counted()).toEqual({ sync: 2, async: 0 });
  });

  it('FULL session with client roots: repeated resolutions spawn git only on the first call', () => {
    const dir = gitRepo('roots-steady', true);
    const roots = toSessionRoots([{ uri: pathToFileURL(dir).href }]);
    resetCounts();

    expect(runWithSessionMember(undefined, () => resolveSelfAnchor(), { roots }).folder).toBe(dir);
    const afterFirst = counted().sync;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      expect(runWithSessionMember(undefined, () => resolveSelfAnchor(), { roots }).folder).toBe(dir);
    }
    expect(counted()).toEqual({ sync: afterFirst, async: 0 });
  });

  it('after the TTL a call returns the cached answer and re-checks with ONE async spawn, never a sync one', async () => {
    const dir = gitRepo('ttl', true);
    validateSelfFolder(dir);
    resetCounts();

    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base + GIT_CACHE_TTL_MS + 1);
    for (let i = 0; i < 10; i++) expect(validateSelfFolder(dir)).toEqual({ folder: dir });
    expect(counted()).toEqual({ sync: 0, async: 2 }); // one re-check per cached query, not per call

    // Let the async re-checks land, then the refreshed answers serve with no spawn.
    await vi.waitFor(() => {
      vi.mocked(Date.now).mockReturnValue(base + GIT_CACHE_TTL_MS + 2);
      validateSelfFolder(dir);
      expect(counted().async).toBe(2);
    });
    resetCounts();
    for (let i = 0; i < 10; i++) validateSelfFolder(dir);
    expect(counted()).toEqual({ sync: 0, async: 0 });
  });
});

describe('kb (self) git cache: a folder that changes is detected on the next call with the same error', () => {
  it('removing the origin remote -> E-SELF-NO-REMOTE, identical to a cold resolution', () => {
    const dir = gitRepo('lose-origin', true);
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-lose-origin-${RUN}`, workFolder: dir });
    addAgent(agent);
    expect(runWithSessionMember(agent.id, () => resolveSelfAnchor()).folder).toBe(dir);

    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir });
    const warm = selfError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor()));
    expect(warm.code).toBe('E-SELF-NO-REMOTE');
    expect(warm.message).toContain(`has no origin remote, so it has no KB identity.`);
    const cold = coldError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor()));
    expect(warm.message).toBe(cold.message);

    // Adding it back is picked up the same way.
    execFileSync('git', ['remote', 'add', 'origin', `https://example.test/git-cache-back-${RUN}.git`], { cwd: dir });
    expect(runWithSessionMember(agent.id, () => resolveSelfAnchor()).folder).toBe(dir);
  });

  it('deleting .git -> E-SELF-NOT-A-REPO for kb and code tools, identical to a cold resolution', () => {
    const dir = gitRepo('lose-git', true);
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-lose-git-${RUN}`, workFolder: dir });
    addAgent(agent);
    expect(runWithSessionMember(agent.id, () => resolveSelfAnchor()).folder).toBe(dir);
    expect(runWithSessionMember(agent.id, () => resolveCodeSelf()).repo).toBe(dir);

    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    const warmKb = selfError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor()));
    const warmCode = selfError(() => runWithSessionMember(agent.id, () => resolveCodeSelf()));
    expect(warmKb.code).toBe('E-SELF-NOT-A-REPO');
    expect(warmCode.code).toBe('E-SELF-NOT-A-REPO');
    expect(warmKb.message).toContain('is not a git repository.');
    expect(warmKb.message).toBe(coldError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor())).message);
    expect(warmCode.message).toBe(coldError(() => runWithSessionMember(agent.id, () => resolveCodeSelf())).message);
  });

  it('a folder that becomes a repo with an origin after a refusal is accepted on the next call', () => {
    const dir = path.join(scratch, 'becomes-repo');
    fs.mkdirSync(dir, { recursive: true });
    expect(selfError(() => validateSelfFolder(dir)).code).toBe('E-SELF-NOT-A-REPO');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(selfError(() => validateSelfFolder(dir)).code).toBe('E-SELF-NO-REMOTE');
    execFileSync('git', ['remote', 'add', 'origin', `https://example.test/git-cache-becomes-${RUN}.git`], { cwd: dir });
    expect(validateSelfFolder(dir)).toEqual({ folder: dir });
  });

  it('keeps the GIT_CEILING_DIRECTORIES rule: a plain folder inside a checkout is not that checkout', () => {
    const outer = gitRepo('outer', true);
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    expect(validateSelfFolder(outer)).toEqual({ folder: outer });
    expect(selfError(() => validateSelfFolder(inner)).code).toBe('E-SELF-NOT-A-REPO');
    expect(selfError(() => validateSelfFolder(inner)).code).toBe('E-SELF-NOT-A-REPO');
  });
});

describe('kb (self) git cache: the async prewarm leaves no synchronous git spawn for the first call', () => {
  it('MEMBER session: prewarm answers with async spawns, then kb and code resolution spawn nothing', async () => {
    const dir = gitRepo('prewarm-member', true);
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-prewarm-member-${RUN}`, workFolder: dir });
    addAgent(agent);
    resetCounts();

    await runWithSessionMember(agent.id, () => prewarmSelfGitCache());
    const warmed = counted();
    expect(warmed.sync).toBe(0);
    expect(warmed.async).toBe(2); // rev-parse --git-dir, remote get-url origin

    expect(runWithSessionMember(agent.id, () => resolveSelfAnchor()).folder).toBe(dir);
    expect(runWithSessionMember(agent.id, () => resolveCodeSelf()).repo).toBe(dir);
    expect(counted()).toEqual(warmed);
  });

  it('FULL session with client roots: prewarm and resolution in ONE call context spawn nothing synchronously', async () => {
    const plain = path.join(scratch, 'prewarm-plain-root');
    fs.mkdirSync(plain, { recursive: true });
    const dir = gitRepo('prewarm-roots', true);
    const roots = toSessionRoots([{ uri: pathToFileURL(plain).href }, { uri: pathToFileURL(dir).href }]);
    resetCounts();

    // Same context as a real tool call: the per-call (self) memo must not
    // remember the prewarm's dry run.
    const anchor = await runWithSessionMember(undefined, async () => {
      await prewarmSelfGitCache();
      return { kb: resolveSelfAnchor(), code: resolveCodeSelf() };
    }, { roots });
    expect(anchor.kb.folder).toBe(dir);
    expect(anchor.code.repo).toBe(dir);
    const after = counted();
    expect(after.sync).toBe(0);
    expect(after.async).toBeGreaterThan(0);
  });

  it('a folder that is not a repo: prewarm does not throw and the call fails with the cold error, still without a sync spawn', async () => {
    const dir = path.join(scratch, 'prewarm-not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-prewarm-nonrepo-${RUN}`, workFolder: dir });
    addAgent(agent);
    resetCounts();

    await expect(runWithSessionMember(agent.id, () => prewarmSelfGitCache())).resolves.toBeUndefined();
    const warm = selfError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor()));
    expect(counted().sync).toBe(0);
    expect(warm.code).toBe('E-SELF-NOT-A-REPO');
    expect(warm.message).toBe(coldError(() => runWithSessionMember(agent.id, () => resolveSelfAnchor())).message);
  });

  it('through the real tool wrapper: a first kb_list call on a fresh member folder spawns git only asynchronously', async () => {
    const dir = gitRepo('prewarm-tool', true);
    const agent = makeTestLocalAgent({ friendlyName: `git-cache-prewarm-tool-${RUN}`, workFolder: dir });
    addAgent(agent);
    const handlers = new Map<string, (input: unknown, extra?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
    const fakeServer = {
      tool: (name: string, ...rest: unknown[]) => {
        const handler = rest[rest.length - 1];
        if (typeof handler === 'function') handlers.set(name, handler as never);
      },
      server: { sendLoggingMessage: async () => {} },
    };
    await registerAllTools(fakeServer as never, memberToolScope(agent.id, false));
    const kbList = handlers.get('kb_list');
    expect(kbList).toBeDefined();
    resetCounts();

    const out = await kbList!({ confidence: ['INFERRED', 'UNVERIFIED'] });
    expect(out.isError).not.toBe(true);
    expect(JSON.parse(out.content[out.content.length - 1].text)).toHaveProperty('results');
    // Session scope AND the KB's project slug: no synchronous git at all.
    expect(counted().sync).toBe(0);
    expect(counted().async).toBeGreaterThan(0);
  });
});
