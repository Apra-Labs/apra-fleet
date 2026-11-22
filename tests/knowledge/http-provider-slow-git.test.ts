import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { headCommitReader } from '../../src/services/knowledge/repository-header.js';

// A slow git HEAD read must never block the event loop, and a request issued
// while it runs is served with the previous X-Repository-Commit
// (stale-while-revalidate). git is faked by a `git` shell script first on PATH
// that sleeps (or fails) according to a mode file, then runs the real git.
//
// How this was checked against the old code: with headCommitReader reverted to
// the synchronous execFileSync read (3 s timeout), the "event loop stays
// responsive" test failed -- the timer scheduled before provider.query() fired
// only after the ~1 s sleep of the fake git (measured delay >= 1000 ms vs the
// 250 ms bound), and the stale-value test failed because the request waited for
// the new commit instead of carrying the old one.
//
// POSIX only: the fake git is an sh script.
const TOKEN = 'NOT_A_REAL_KEY';
const REPO = 'github.com/example/slow-git';
const SLOW_MS = 1000;

interface Seen { commit?: string }
const seen: Seen[] = [];
let server: http.Server;
let baseUrl: string;

let binDir: string;
let modeFile: string;
let repo: string;
let savedPath: string | undefined;
let savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function realGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FAKE_GIT_MODE_FILE: '/nonexistent' },
  }).trim();
}

function setMode(mode: 'fast' | 'slow' | 'fail' | 'hang'): void {
  fs.writeFileSync(modeFile, mode);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/kb/capabilities')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
      return;
    }
    req.resume();
    req.on('end', () => {
      seen.push({ commit: req.headers['x-repository-commit'] as string | undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-slow-git-'));
  tempDirs.push(root);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
  binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  modeFile = path.join(root, 'mode');
  setMode('fast');
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/sh',
    'mode=$(cat "$FAKE_GIT_MODE_FILE" 2>/dev/null)',
    `case "$mode" in slow) sleep ${SLOW_MS / 1000};; fail) exit 1;; hang) sleep 4;; esac`,
    `exec "${real}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  realGit(repo, 'init', '-q', '.');
  realGit(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  savedPath = process.env.PATH;
  savedEnv = { FAKE_GIT_MODE_FILE: process.env.FAKE_GIT_MODE_FILE };
  process.env.FAKE_GIT_MODE_FILE = modeFile;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedEnv.FAKE_GIT_MODE_FILE === undefined) delete process.env.FAKE_GIT_MODE_FILE;
  else process.env.FAKE_GIT_MODE_FILE = savedEnv.FAKE_GIT_MODE_FILE;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function withProvider(ttlMs: number, body: (p: HttpKbProvider) => Promise<void>): Promise<void> {
  const provider = new HttpKbProvider(baseUrl, TOKEN, {
    repository: { remote: REPO, commitOf: headCommitReader(repo, ttlMs) },
  });
  await provider.init();
  try {
    await body(provider);
  } finally {
    provider.dispose();
  }
}

describe.skipIf(process.platform === 'win32')('a slow git HEAD read does not block KB HTTP requests', () => {
  it('keeps the event loop responsive, serves the stale commit during the refresh, then the new one', async () => {
    const first = realGit(repo, 'rev-parse', 'HEAD');
    await withProvider(0, async provider => {
      await provider.query({ query: 'x' });
      expect(seen.map(s => s.commit)).toEqual([first]);
      // The first request also read the server capabilities (a second header
      // computation); let any refresh that started behind it settle.
      await new Promise(resolve => setTimeout(resolve, 300));

      realGit(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
      const second = realGit(repo, 'rev-parse', 'HEAD');
      setMode('slow');

      // TTL 0: this request starts a background refresh through the slow git.
      const t0 = Date.now();
      const timer = new Promise<number>(resolve => setTimeout(() => resolve(Date.now() - t0), 0));
      const during = provider.query({ query: 'x' });
      const during2 = provider.query({ query: 'x' });
      const timerDelay = await timer;
      expect(timerDelay).toBeLessThan(250);
      await Promise.all([during, during2]);
      // Both requests, made while the refresh was in flight, carry the old commit,
      // and neither waited for the slow git.
      expect(Date.now() - t0).toBeLessThan(SLOW_MS);
      expect(seen.map(s => s.commit)).toEqual([first, first, first]);

      await new Promise(resolve => setTimeout(resolve, SLOW_MS + 700));
      setMode('fast');
      await provider.query({ query: 'x' });
      expect(seen[3].commit).toBe(second);
    });
  }, 15_000);

  it('omits the header, and the request still succeeds, when git fails', async () => {
    setMode('fail');
    await withProvider(0, async provider => {
      const result = await provider.query({ query: 'x' });
      expect(result).toBeDefined();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].commit).toBeUndefined();
  });

  it('omits the header, and the request still succeeds, when the first read times out', async () => {
    setMode('hang');
    const t0 = Date.now();
    await withProvider(0, async provider => {
      const result = await provider.query({ query: 'x' });
      expect(result).toBeDefined();
    });
    expect(Date.now() - t0).toBeLessThan(3900);
    expect(seen).toHaveLength(1);
    expect(seen[0].commit).toBeUndefined();
  }, 15_000);
});
