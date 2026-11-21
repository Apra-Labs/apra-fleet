import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, inject } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { validateSelfFolder } from '../../src/services/knowledge/kb-self.js';
import { autoHarvestAnchor } from '../../src/tools/execute-prompt.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestAgent, makeTestLocalAgent } from '../test-helpers.js';
import { releaseFileDataDir, fileDataDirViolations } from '../helpers/file-kb-data-dir.js';
import { FLEET_DIR as ISOLATED_FLEET_DIR } from '../../src/paths.js';
import { KB_CONFIG_PATH as ISOLATED_KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

// This file's OWN fleet data dir, claimed before any src module loads
// (src/paths.ts fixes FLEET_DIR at import). The per-run data dir tests/setup.ts
// provides is shared by every file of the run, and so is the KB config file
// in it (<data dir>/knowledge/config.json), which this file writes and the
// code under test reads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-harvest-local-anchor'));
afterAll(() => releaseFileDataDir(fileDataDir));

// ISOLATION GUARD: fails if this suite reads the run-shared data dir again --
// the hoisted claim removed, moved below the imports (FLEET_DIR is then fixed
// to the shared dir), or the dir not unique to this file.
describe('isolation guard', () => {
  it('this suite reads its own fleet data dir and KB config file, not the run-shared ones', () => {
    expect(fileDataDirViolations({
      label: 'kb-harvest-local-anchor', claimed: fileDataDir, fleetDir: ISOLATED_FLEET_DIR,
      kbConfigPath: ISOLATED_KB_CONFIG_PATH, runSharedDir: inject('APRA_FLEET_TEST_DATA_DIR'),
    })).toEqual([]);
  });
});

// apra-fleet-p71k: the auto-harvest anchor for a LOCAL member must resolve the
// same HTTP provider, X-Repository and X-Repository-Commit as an interactive
// kb_* call on that folder (validateSelfFolder, what resolveSelfAnchor returns
// for a local member). A REMOTE member keeps its known remote URL. Real local
// HTTP stub records the headers; no mocks.

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');
const FAKE_TOKEN = 'NOT_A_REAL_KEY';
const REGISTERED_URL = 'git@example.invalid:Registered-Spelling/Other.git';

const seen: Array<{ repository?: string; commit?: string }> = [];
let server: http.Server;
let serverUrl: string;
const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepo(origin: string): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-harvest-local-anchor-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '.']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return { dir, head: git(dir, ['rev-parse', 'HEAD']) };
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
  resetKbProviders();
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: serverUrl, token_encrypted: encryptPassword(FAKE_TOKEN) }),
  );
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

describe('auto-harvest anchor resolves a local member by its folder', () => {
  it('a local member whose registration URL differs from origin resolves the same provider and headers as an interactive call', async () => {
    const repo = makeRepo('https://github.com/example/real-origin.git');
    const member = makeTestLocalAgent({ workFolder: repo.dir, gitRepos: [REGISTERED_URL] });

    const interactive = validateSelfFolder(repo.dir, member.friendlyName);
    const harvestAnchor = autoHarvestAnchor(member, repo.dir);
    expect(harvestAnchor).toEqual(interactive);

    const interactiveProviders = await getKbProviders(interactive.folder, interactive.remoteUrl);
    const harvestProviders = await getKbProviders(harvestAnchor.folder, harvestAnchor.remoteUrl);

    // One provider instance (one HttpKbProvider built) for the folder.
    expect(harvestProviders.project).toBe(interactiveProviders.project);
    const headers = await headersOf(harvestProviders.project);
    expect(headers.repository).toBe('github.com/example/real-origin');
    expect(headers.commit).toBe(repo.head);
  });

  it('a remote member still passes its known remote URL', () => {
    const member = makeTestAgent({ workFolder: '/remote/work/repo', gitRepos: [REGISTERED_URL] });
    expect(autoHarvestAnchor(member, '/remote/work/repo')).toEqual({
      folder: '/remote/work/repo',
      remoteUrl: REGISTERED_URL,
    });
  });
});
