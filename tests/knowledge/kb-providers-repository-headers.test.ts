import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, inject } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { releaseFileDataDir, fileDataDirViolations } from '../helpers/file-kb-data-dir.js';
import { FLEET_DIR as ISOLATED_FLEET_DIR } from '../../src/paths.js';
import { KB_CONFIG_PATH as ISOLATED_KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

// This file's OWN fleet data dir, claimed before any src module loads
// (src/paths.ts fixes FLEET_DIR at import). The per-run data dir tests/setup.ts
// provides is shared by every file of the run, and so is the KB config file
// in it (<data dir>/knowledge/config.json), which this file writes and the
// code under test reads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-providers-repository-headers'));
afterAll(() => releaseFileDataDir(fileDataDir));

// ISOLATION GUARD: fails if this suite reads the run-shared data dir again --
// the hoisted claim removed, moved below the imports (FLEET_DIR is then fixed
// to the shared dir), or the dir not unique to this file.
describe('isolation guard', () => {
  it('this suite reads its own fleet data dir and KB config file, not the run-shared ones', () => {
    expect(fileDataDirViolations({
      label: 'kb-providers-repository-headers', claimed: fileDataDir, fleetDir: ISOLATED_FLEET_DIR,
      kbConfigPath: ISOLATED_KB_CONFIG_PATH, runSharedDir: inject('APRA_FLEET_TEST_DATA_DIR'),
    })).toEqual([]);
  });
});

// The selection seam: getKbProviders resolves the repository from the anchor
// (folder + optional remoteUrl) and hands it to the HttpKbProvider, which sends
// it as X-Repository / X-Repository-Commit. Proven against a real local HTTP
// server; FLEET_DIR is this file's own data dir (claimed above), so the KB
// config written here cannot leak into another file.
const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');
const FAKE_TOKEN = 'NOT_A_REAL_KEY';

const seen: Array<{ repository?: string; commit?: string; branch?: string; branchRaw: string[]; project?: string }> = [];
let server: http.Server;
let serverUrl: string;
const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-providers-repo-hdr-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepo(origin: string): { dir: string; head: string } {
  const dir = makeDir();
  git(dir, ['init', '-q', '.']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return { dir, head: git(dir, ['rev-parse', 'HEAD']) };
}

function writeHttpConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: serverUrl, token_encrypted: encryptPassword(FAKE_TOKEN) }, null, 2),
  );
}

async function requestOf(provider: unknown): Promise<(typeof seen)[number]> {
  expect(provider).toBeInstanceOf(HttpKbProvider);
  seen.length = 0;
  const result = await (provider as HttpKbProvider).query({ query: 'x' });
  expect(result).toBeDefined();
  expect(seen).toHaveLength(1);
  return seen[0];
}

async function headersOf(provider: unknown): Promise<{ repository?: string; commit?: string }> {
  const { repository, commit } = await requestOf(provider);
  return { repository, commit };
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
      seen.push({
        repository: req.headers['x-repository'] as string | undefined,
        commit: req.headers['x-repository-commit'] as string | undefined,
        branch: req.headers['x-repository-branch'] as string | undefined,
        branchRaw: req.rawHeaders.filter(h => h.toLowerCase() === 'x-repository-branch'),
        project: req.headers['x-kb-project'] as string | undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

describe('getKbProviders passes the resolved repository to the HTTP provider', () => {
  it('a local repo: X-Repository from its origin (credentials stripped), X-Repository-Commit from its HEAD', async () => {
    writeHttpConfig();
    const repo = makeRepo(`https://user:${FAKE_TOKEN}@github.com/example/local-one.git`);

    const providers = await getKbProviders(repo.dir);
    const headers = await headersOf(providers.project);

    expect(headers.repository).toBe('github.com/example/local-one');
    expect(headers.commit).toBe(repo.head);
  });

  it('two repositories get two providers sending different X-Repository values', async () => {
    writeHttpConfig();
    const a = makeRepo('git@github.com:example/repo-a.git');
    const b = makeRepo('https://dev.azure.com/Org/Proj/_git/repo-b');

    const pa = await getKbProviders(a.dir);
    const pb = await getKbProviders(b.dir);
    expect(pa.project).not.toBe(pb.project);

    expect(await headersOf(pa.project)).toEqual({ repository: 'github.com/example/repo-a', commit: a.head });
    expect(await headersOf(pb.project)).toEqual({ repository: 'dev.azure.com/org/Proj/_git/repo-b', commit: b.head });
  });

  it('a remote member (remoteUrl given): X-Repository from that remote, no commit header', async () => {
    writeHttpConfig();
    const folderOnAnotherHost = makeDir();

    const providers = await getKbProviders(folderOnAnotherHost, 'ssh://git@github.com/example/remote-member.git');

    expect(await headersOf(providers.project)).toEqual({ repository: 'github.com/example/remote-member', commit: undefined });
  });

  it('two remotes sharing one slug and folder never share a provider sending the wrong repository', async () => {
    writeHttpConfig();
    const folder = makeDir();
    // Both slugify to the same project slug; they are different repositories.
    const first = await getKbProviders(folder, 'https://example.invalid/a-b/c.git');
    const second = await getKbProviders(folder, 'https://example.invalid/a/b-c.git');
    expect(first.projectSlug).toBe(second.projectSlug);

    expect((await headersOf(first.project)).repository).toBe('example.invalid/a-b/c');
    expect((await headersOf(second.project)).repository).toBe('example.invalid/a/b-c');
    // The same anchor again still returns the cached selection.
    expect(await getKbProviders(folder, 'https://example.invalid/a-b/c.git')).toBe(first);
  });

  it('the same folder with and without a remoteUrl gets separate selections, each sending its own repository', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/local-origin.git');

    const local = await getKbProviders(repo.dir);
    const viaRemote = await getKbProviders(repo.dir, 'https://github.com/example/registered-remote.git');
    expect(viaRemote).not.toBe(local);
    expect(viaRemote.project).not.toBe(local.project);

    expect(await headersOf(local.project)).toEqual({ repository: 'github.com/example/local-origin', commit: repo.head });
    expect(await headersOf(viaRemote.project)).toEqual({ repository: 'github.com/example/registered-remote', commit: undefined });
  });

  it('a folder with no origin remote: the HTTP provider sends neither header', async () => {
    writeHttpConfig();
    const dir = makeDir();
    git(dir, ['init', '-q', '.']);

    const providers = await getKbProviders(dir);

    expect(await headersOf(providers.project)).toEqual({ repository: undefined, commit: undefined });
  });

  it('sqlite selection is unchanged: a SqliteProvider, no HTTP request', async () => {
    const repo = makeRepo('https://github.com/example/sqlite-mode.git');
    seen.length = 0;

    const providers = await getKbProviders(repo.dir);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    await providers.project.query({ query: 'x' });
    expect(seen).toHaveLength(0);
  });
});

describe('getKbProviders: X-Repository-Branch from a real local git folder', () => {
  it('a local folder on branch b sends X-Repository-Branch: b next to X-Repository and X-Repository-Commit', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-local.git');
    git(repo.dir, ['checkout', '-q', '-b', 'feature/b']);

    const request = await requestOf((await getKbProviders(repo.dir)).project);

    expect(request.repository).toBe('github.com/example/branch-local');
    expect(request.commit).toBe(repo.head);
    expect(request.branch).toBe('feature/b');
    expect(request.branchRaw).toHaveLength(1);
  });

  it('a detached HEAD sends no X-Repository-Branch and the request still succeeds', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-detached.git');
    git(repo.dir, ['checkout', '-q', '--detach']);

    const request = await requestOf((await getKbProviders(repo.dir)).project);

    expect(request.repository).toBe('github.com/example/branch-detached');
    expect(request.commit).toBe(repo.head);
    expect(request.branch).toBeUndefined();
    expect(request.branchRaw).toHaveLength(0);
  });

  it('a remote member anchor (remoteUrl set) sends no X-Repository-Branch, even over a local repo on a branch', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-remote-local.git');
    git(repo.dir, ['checkout', '-q', '-b', 'not-sent']);

    const request = await requestOf(
      (await getKbProviders(repo.dir, 'ssh://git@github.com/example/branch-remote-member.git')).project,
    );

    expect(request.repository).toBe('github.com/example/branch-remote-member');
    expect(request.commit).toBeUndefined();
    expect(request.branch).toBeUndefined();
    expect(request.branchRaw).toHaveLength(0);
  });

  it('a non-ASCII branch name is sent percent-encoded as UTF-8', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-utf8.git');
    git(repo.dir, ['checkout', '-q', '-b', 'caf\u00e9-\u65e5']);

    const request = await requestOf((await getKbProviders(repo.dir)).project);

    expect(request.branch).toBe('caf%C3%A9-%E6%97%A5');
  });

  it('a branch name over 255 characters after encoding is omitted; the request still succeeds', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-long.git');
    // 101 characters / 201 bytes for git, 601 characters once percent-encoded.
    git(repo.dir, ['checkout', '-q', '-b', `b${'\u00e9'.repeat(100)}`]);

    const request = await requestOf((await getKbProviders(repo.dir)).project);

    expect(request.repository).toBe('github.com/example/branch-long');
    expect(request.commit).toBe(repo.head);
    expect(request.branch).toBeUndefined();
  });
});

describe('getKbProviders: a changed origin is picked up without a restart', () => {
  // Design: X-Repository and X-KB-Project both derive from the origin, so the
  // provider is RE-SELECTED (new slug, new identity) rather than only refreshing
  // the header; they always agree. The origin is re-read asynchronously on the
  // reader TTL (HEAD_COMMIT_TTL_MS), so Date is faked to pass it. Reverting the
  // originChange check in getKbProviders makes this test fail: the second and
  // third requests keep sending the old X-Repository and X-KB-Project.
  afterEach(() => { vi.useRealTimers(); });

  it('git remote set-url origin changes X-Repository and X-KB-Project on later requests', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/old-name.git');

    const before = await requestOf((await getKbProviders(repo.dir)).project);
    expect(before.repository).toBe('github.com/example/old-name');
    const oldSlug = before.project;

    git(repo.dir, ['remote', 'set-url', 'origin', 'https://github.com/example/new-name.git']);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });

    // Inside the same call the old value is still served; the refresh runs behind it.
    await requestOf((await getKbProviders(repo.dir)).project);
    let latest = before;
    await vi.waitFor(async () => {
      latest = await requestOf((await getKbProviders(repo.dir)).project);
      expect(latest.repository).toBe('github.com/example/new-name');
    });
    expect(latest.project).toBeDefined();
    expect(latest.project).not.toBe(oldSlug);
    expect(latest.project).toBe('githubcom-example-new-name');
    expect(latest.commit).toBe(repo.head);
  });

  it('a remote member anchor (remoteUrl given) is unaffected: no re-read, same provider', async () => {
    writeHttpConfig();
    const folder = makeDir();
    const first = await getKbProviders(folder, 'https://github.com/example/member-remote.git');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    expect(await getKbProviders(folder, 'https://github.com/example/member-remote.git')).toBe(first);
  });
});

describe('getKbProviders: a branch with a literal percent sign', () => {
  it('a branch named a%C3%A9 is sent as a%25C3%25A9, distinct from a + e-acute', async () => {
    writeHttpConfig();
    const repo = makeRepo('https://github.com/example/branch-percent.git');
    git(repo.dir, ['checkout', '-q', '-b', 'a%C3%A9']);
    const literal = await requestOf((await getKbProviders(repo.dir)).project);
    expect(literal.branch).toBe('a%25C3%25A9');

    resetKbProviders();
    git(repo.dir, ['checkout', '-q', '-b', 'a\u00e9']);
    const accented = await requestOf((await getKbProviders(repo.dir)).project);
    expect(accented.branch).toBe('a%C3%A9');
  });
});
