import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

// The selection seam: getKbProviders resolves the repository from the anchor
// (folder + optional remoteUrl) and hands it to the HttpKbProvider, which sends
// it as X-Repository / X-Repository-Commit. Proven against a real local HTTP
// server; FLEET_DIR is a per-run tmpdir and fileParallelism is off, so the
// global KB config written here cannot leak into another file.
const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');
const FAKE_TOKEN = 'NOT_A_REAL_KEY';

const seen: Array<{ repository?: string; commit?: string }> = [];
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

async function headersOf(provider: unknown): Promise<{ repository?: string; commit?: string }> {
  expect(provider).toBeInstanceOf(HttpKbProvider);
  seen.length = 0;
  await (provider as HttpKbProvider).query({ query: 'x' });
  expect(seen).toHaveLength(1);
  return seen[0];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({
        repository: req.headers['x-repository'] as string | undefined,
        commit: req.headers['x-repository-commit'] as string | undefined,
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
