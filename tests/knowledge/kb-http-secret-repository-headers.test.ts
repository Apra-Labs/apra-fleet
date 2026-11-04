import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpKbProvider, KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { resetKbHttpAuthState } from '../../src/services/knowledge/kb-http-auth-state.js';
import { credentialSet, credentialDelete } from '../../src/services/credential-store.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Named-secret token and repository headers together, against a real local
// HTTP server: the 401 retry re-reads the secret but resends the SAME
// repository headers, a missing secret fails before the commit is read, and
// an auth-blocked queued capture replays with the fresh secret and the
// provider's repository headers. Real credential store (per-run
// APRA_FLEET_DATA_DIR from tests/setup.ts); no mocks of the provider or http.

const RUN = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const NAME = `KB_SECRET_REPO_${RUN}`;
const TOKEN_A = `NOT_A_REAL_KEY_A_${RUN}`;
const TOKEN_B = `NOT_A_REAL_KEY_B_${RUN}`;
const REPO = 'github.com/example/secret-repo-headers';

interface Seen { path: string; authorization?: string; repository?: string; commit?: string }
const stub = {
  accepted: TOKEN_B,
  seen: [] as Seen[],
  on401: undefined as (() => void) | undefined,
};
let server: http.Server;
let baseUrl: string;

const setSecret = (value: string) => credentialSet(NAME, value, true, 'allow', '*');

function makeInput(title: string): KBEntryInput {
  return {
    type: 'learning', title, summary: 's', content: 'c', source_files: ['src/fixture.ts'],
    symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'doer', confidence: 'INFERRED',
  };
}

// A commit source that returns a different sha on every call and counts its
// calls, so a test can tell "read once per request" from "read per attempt".
function countingCommit(): { commitOf: () => string; calls: () => number } {
  let n = 0;
  return {
    commitOf: () => { n++; return n.toString(16).padStart(40, '0'); },
    calls: () => n,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const urlPath = (req.url ?? '').split('?')[0];
      stub.seen.push({
        path: urlPath,
        authorization: req.headers.authorization,
        repository: req.headers['x-repository'] as string | undefined,
        commit: req.headers['x-repository-commit'] as string | undefined,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${stub.accepted}`) {
        stub.on401?.();
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const body = urlPath === '/api/kb/capture' ? { id: `srv-${stub.seen.length}`, audn_decision: 'add' }
        : urlPath === '/api/kb/query' ? { results: [], total: 0, l1_only: false }
          : { error: 'Not found' };
      res.writeHead('error' in body ? 404 : 200);
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  stub.accepted = TOKEN_B;
  stub.seen.length = 0;
  stub.on401 = undefined;
  resetKbHttpAuthState();
});

afterEach(() => {
  try { credentialDelete(NAME); } catch { /* best effort */ }
});

async function withProvider(commit: ReturnType<typeof countingCommit>, body: (p: HttpKbProvider) => Promise<void>): Promise<void> {
  const fallback = new SqliteProvider(':memory:');
  await fallback.init();
  const provider = new HttpKbProvider(baseUrl, { secretName: NAME }, fallback, {
    repository: { remote: REPO, commitOf: commit.commitOf },
  });
  try {
    await body(provider);
  } finally {
    provider.dispose();
  }
}

describe('HttpKbProvider: named secret + repository headers', () => {
  it('a 401 retried after secret rotation sends X-Repository and the same commit on both attempts', async () => {
    setSecret(TOKEN_A);
    stub.on401 = () => { setSecret(TOKEN_B); stub.on401 = undefined; };
    const commit = countingCommit();
    await withProvider(commit, async (p) => {
      const result = await p.capture(makeInput('rotated'));
      expect(result.id).toBeTruthy();
      expect(p.offlineQueue).toHaveLength(0);
    });
    const captures = stub.seen.filter(s => s.path === '/api/kb/capture');
    expect(captures).toHaveLength(2);
    expect(captures.map(c => c.authorization)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
    for (const c of captures) expect(c.repository).toBe(REPO);
    expect(captures[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(captures[1].commit).toBe(captures[0].commit);
    expect(commit.calls()).toBe(1);
  });

  it('a missing secret fails before the commit is read and before any request', async () => {
    const commit = countingCommit();
    await withProvider(commit, async (p) => {
      const err = await p.query({ query: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KbHttpAuthError);
      expect((err as KbHttpAuthError).reason).toBe('missing');
    });
    expect(commit.calls()).toBe(0);
    expect(stub.seen).toHaveLength(0);
  });

  it('an auth-blocked queued capture replays with the fixed secret and its repository headers', async () => {
    setSecret(TOKEN_A);
    const commit = countingCommit();
    await withProvider(commit, async (p) => {
      const err = await p.capture(makeInput('queued')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KbHttpAuthError);
      expect((err as KbHttpAuthError).reason).toBe('rejected');
      expect((err as KbHttpAuthError).queued).toBe(true);
      expect(p.offlineQueue).toHaveLength(1);
      const blocked = stub.seen.filter(s => s.path === '/api/kb/capture');
      expect(blocked).toHaveLength(2);
      for (const b of blocked) expect(b.repository).toBe(REPO);

      stub.seen.length = 0;
      setSecret(TOKEN_B);
      await p.query({ query: 'after fix' });
      expect(p.offlineQueue).toHaveLength(0);
    });
    const replay = stub.seen.filter(s => s.path === '/api/kb/capture');
    expect(replay).toHaveLength(1);
    expect(replay[0].authorization).toBe(`Bearer ${TOKEN_B}`);
    expect(replay[0].repository).toBe(REPO);
    expect(replay[0].commit).toMatch(/^[0-9a-f]{40}$/);
    const query = stub.seen.filter(s => s.path === '/api/kb/query');
    expect(query).toHaveLength(1);
    expect(query[0].repository).toBe(REPO);
  });
});
