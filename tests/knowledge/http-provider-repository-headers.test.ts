import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { headBranchReader } from '../../src/services/knowledge/repository-header.js';

// A real local HTTP server that records the repository headers of every
// request it receives -- no mocks of the provider or of node:http.
const TOKEN = 'NOT_A_REAL_KEY';
const OFFLINE_URL = 'http://127.0.0.1:17779'; // nothing listens here
const REPO = 'github.com/example/repo-headers';
const SHA = 'a'.repeat(40);

interface Seen { method: string; path: string; url: string; repository?: string; commit?: string; branch?: string; raw: string[] }
const seen: Seen[] = [];
let server: http.Server;
let baseUrl: string;

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Header test',
    summary: 's',
    content: 'c',
    source_files: ['src/fixture.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // A server without GET /api/kb/capabilities: the route set from before
    // that route existed. (The capabilities read is tested on its own.)
    if ((req.url ?? '').startsWith('/api/kb/capabilities')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const urlPath = (req.url ?? '').split('?')[0];
      seen.push({
        method: req.method ?? '',
        path: urlPath,
        url: req.url ?? '',
        repository: req.headers['x-repository'] as string | undefined,
        commit: req.headers['x-repository-commit'] as string | undefined,
        branch: req.headers['x-repository-branch'] as string | undefined,
        raw: req.rawHeaders,
      });
      const body: Record<string, unknown> =
        urlPath === '/api/kb/capture' ? { id: 'srv-1', audn_decision: 'add' }
          : urlPath === '/api/kb/query' ? { results: [], total: 0, l1_only: false }
            : urlPath === '/api/kb/context' ? { results: [] }
              : urlPath === '/api/kb/invalidate' ? { invalidated: 0 }
                : urlPath === '/api/kb/prime' ? { entries: [] }
                  : { error: 'Not found' };
      res.writeHead(body.error ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const tempDirs: string[] = [];

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-provider-branch-hdr-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function makeRepoOnBranch(branch: string): string {
  const dir = makeDir();
  git(dir, ['init', '-q', '.']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['checkout', '-q', '-b', branch]);
  return dir;
}

beforeEach(() => {
  seen.length = 0;
});

async function withProvider(
  url: string,
  options: ConstructorParameters<typeof HttpKbProvider>[2],
  body: (provider: HttpKbProvider) => Promise<void>,
): Promise<void> {
  const provider = new HttpKbProvider(url, TOKEN, options);
  await provider.init();
  try {
    await body(provider);
  } finally {
    provider.dispose();
  }
}

async function callEveryRemoteMethod(provider: HttpKbProvider): Promise<void> {
  await provider.capture(makeInput());
  await provider.query({ query: 'x' });
  await provider.context(['src/a.ts']);
  await provider.invalidate(['src/a.ts']);
  await provider.prime({} as never);
}

describe('HttpKbProvider repository headers', () => {
  it('sends X-Repository and X-Repository-Commit on capture, query, context, invalidate and prime', async () => {
    await withProvider(baseUrl, { repository: { remote: REPO, commitOf: () => SHA } }, callEveryRemoteMethod);

    expect(seen.map(s => s.path)).toEqual([
      '/api/kb/capture', '/api/kb/query', '/api/kb/context', '/api/kb/invalidate', '/api/kb/prime',
    ]);
    for (const request of seen) {
      expect(request.repository, request.path).toBe(REPO);
      expect(request.commit, request.path).toBe(SHA);
      // Each header exactly once: the receiving server refuses a repeated header.
      expect(request.raw.filter(h => h.toLowerCase() === 'x-repository')).toHaveLength(1);
      // Never in the URL: URLs end up in access logs.
      expect(request.url, request.path).not.toContain(REPO);
      expect(request.url, request.path).not.toContain(SHA);
      expect(request.url, request.path).not.toMatch(/repo/i);
    }
  });

  it('sends neither header, and no query parameter, when there is no repository', async () => {
    await withProvider(baseUrl, {}, callEveryRemoteMethod);

    expect(seen).toHaveLength(5);
    for (const request of seen) {
      expect(request.repository).toBeUndefined();
      expect(request.commit).toBeUndefined();
    }
  });

  it('omits only the commit header when the commit is unknown, unreadable or malformed', async () => {
    const readers: Array<() => string | undefined> = [
      () => undefined,
      () => { throw new Error('git exploded'); },
      () => 'not-a-sha',
      () => 'abc1234', // abbreviated: fleet sends only a full sha
    ];
    for (const commitOf of readers) {
      seen.length = 0;
      await withProvider(baseUrl, { repository: { remote: REPO, commitOf } }, async provider => {
        const result = await provider.capture(makeInput());
        expect(result.id).toBe('srv-1');
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].repository).toBe(REPO);
      expect(seen[0].commit).toBeUndefined();
    }
  });

  it('re-reads the commit per request, so a new HEAD is sent once the reader reports it', async () => {
    let current = SHA;
    await withProvider(baseUrl, { repository: { remote: REPO, commitOf: () => current } }, async provider => {
      await provider.query({});
      current = 'b'.repeat(40);
      await provider.query({});
    });
    expect(seen.map(s => s.commit)).toEqual([SHA, 'b'.repeat(40)]);
  });

  it('ignores a repository value that is not a valid header (never sends a scheme or credentials)', async () => {
    await withProvider(
      baseUrl,
      { repository: { remote: 'https://user:NOT_A_REAL_KEY@github.com/o/r', commitOf: () => SHA } },
      async provider => { await provider.query({}); },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].repository).toBeUndefined();
    expect(seen[0].commit).toBeUndefined();
    expect(seen[0].raw.join('\n')).not.toContain('NOT_A_REAL_KEY@');
  });

  it('carries the headers on an offline-queue replay', async () => {
    await withProvider(OFFLINE_URL, { repository: { remote: REPO, commitOf: () => SHA } }, async provider => {
      // Queued, and each call fails with E-KB-HTTP-UNREACHABLE.
      await expect(provider.capture(makeInput({ title: 'queued capture' }))).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE', queued: true });
      await expect(provider.invalidate(['src/q.ts'])).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE', queued: true });
      expect(provider.offlineQueue).toHaveLength(2);

      // The server comes back: the next request flushes the queue first.
      (provider as unknown as { baseUrl: string }).baseUrl = baseUrl;
      await provider.query({});
      expect(provider.offlineQueue).toHaveLength(0);
    });

    expect(seen.map(s => s.path)).toEqual(['/api/kb/capture', '/api/kb/invalidate', '/api/kb/query']);
    for (const request of seen) {
      expect(request.repository).toBe(REPO);
      expect(request.commit).toBe(SHA);
    }
  });
});

describe('HttpKbProvider X-Repository-Branch', () => {
  it('a folder that is not a git repository (git fails): no branch header, the request succeeds', async () => {
    const notARepo = makeDir();
    await withProvider(baseUrl, { repository: { remote: REPO, branchOf: headBranchReader(notARepo) } }, async provider => {
      const result = await provider.capture(makeInput());
      expect(result.id).toBe('srv-1');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].repository).toBe(REPO);
    expect(seen[0].branch).toBeUndefined();
  });

  it('a throwing branch reader: no branch header, the request succeeds', async () => {
    const branchOf = () => { throw new Error('git exploded'); };
    await withProvider(baseUrl, { repository: { remote: REPO, commitOf: () => SHA, branchOf } }, async provider => {
      const result = await provider.capture(makeInput());
      expect(result.id).toBe('srv-1');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].repository).toBe(REPO);
    expect(seen[0].commit).toBe(SHA);
    expect(seen[0].branch).toBeUndefined();
  });

  it('an invalid branch value (empty, space, raw non-ASCII, over 255 chars) is omitted; the request succeeds', async () => {
    const invalid = ['', 'has space', 'caf\u00e9', 'x'.repeat(256)];
    for (const value of invalid) {
      seen.length = 0;
      await withProvider(baseUrl, { repository: { remote: REPO, branchOf: () => value } }, async provider => {
        const result = await provider.query({});
        expect(result).toBeDefined();
      });
      expect(seen, JSON.stringify(value)).toHaveLength(1);
      expect(seen[0].repository).toBe(REPO);
      expect(seen[0].branch, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('a tag with the same name as the branch: the header is the plain branch name, not heads/<name>', async () => {
    const dir = makeRepoOnBranch('same');
    git(dir, ['tag', 'same']);
    await withProvider(baseUrl, { repository: { remote: REPO, branchOf: headBranchReader(dir) } }, async provider => {
      await provider.query({});
    });
    expect(seen.map(s => s.branch)).toEqual(['same']);
  });

  it('a branch whose own name starts with heads/ keeps that whole name', () => {
    expect(headBranchReader(makeRepoOnBranch('heads/x'))()).toBe('heads/x');
  });

  it('a HEAD not under refs/heads/ is omitted, the request succeeds', async () => {
    const dir = makeRepoOnBranch('first');
    git(dir, ['symbolic-ref', 'HEAD', 'refs/remotes/origin/first']);
    await withProvider(baseUrl, { repository: { remote: REPO, branchOf: headBranchReader(dir) } }, async provider => {
      const result = await provider.query({});
      expect(result).toBeDefined();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].branch).toBeUndefined();
  });

  it('a branch switch is sent once the reader TTL has passed', async () => {
    const ttlMs = 50;
    const dir = makeRepoOnBranch('first');
    await withProvider(baseUrl, { repository: { remote: REPO, branchOf: headBranchReader(dir, ttlMs) } }, async provider => {
      await provider.query({});
      git(dir, ['checkout', '-q', '-b', 'second']);
      await new Promise(resolve => setTimeout(resolve, ttlMs * 3));
      await provider.query({});
    });
    expect(seen.map(s => s.branch)).toEqual(['first', 'second']);
  });
});
