import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';

// FLEET_DIR is pinned to a per-run tmpdir by tests/setup.ts, and vitest.config.ts
// sets fileParallelism:false, so writing the single global KB config file here
// cannot flip another test file's providers into http mode mid-run.
const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

// Deliberately unreachable + obviously fake: these tests assert on the SHAPE of
// what getKbProviders returns and never issue a request, so no HTTP timeout is
// ever paid.
const REMOTE_KB_URL = 'http://kb.invalid:7878';
const FAKE_TOKEN = 'NOT_A_REAL_KEY';

// Passing an explicit remote URL keeps the slug deterministic without shelling
// out to git in a scratch directory.
const REMOTE_REPO_URL = 'https://example.invalid/kb-providers-http-selection.git';

const tempRepoPaths: string[] = [];

function makeRepoPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-providers-http-'));
  tempRepoPaths.push(dir);
  return dir;
}

function writeHttpConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: REMOTE_KB_URL, token_encrypted: encryptPassword(FAKE_TOKEN) }, null, 2),
  );
}

function writeSqliteConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'sqlite' }, null, 2));
}

function writeMalformedConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, '{ this is not json');
}

function writeHttpConfigMissingUrl(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'http', token_encrypted: encryptPassword(FAKE_TOKEN) }, null, 2));
}

// `fallback` is private on HttpKbProvider -- a compile-time marker only. Reading
// it through a cast is how this suite proves the fallback is the project
// SqliteProvider getKbProviders built, with no mock or subclass involved.
function fallbackOf(provider: HttpKbProvider): SqliteProvider {
  return (provider as unknown as { fallback: SqliteProvider }).fallback;
}

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

afterAll(() => {
  for (const dir of tempRepoPaths) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getKbProviders project provider selection', () => {
  it('returns a SqliteProvider as project when no KB config file exists', async () => {
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect((providers.project as SqliteProvider).repoPath).toBe(repoPath);
  });

  it('returns a SqliteProvider as project when the config selects sqlite', async () => {
    writeSqliteConfig();
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
  });

  it('returns an HttpKbProvider as project when the config selects http', async () => {
    writeHttpConfig();
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(HttpKbProvider);
  });

  it('passes the project SqliteProvider as the HTTP provider fallback, never a no-arg one', async () => {
    writeHttpConfig();
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);
    const fallback = fallbackOf(providers.project as HttpKbProvider);

    expect(fallback).toBeInstanceOf(SqliteProvider);
    // The load-bearing assertion: a no-arg `new SqliteProvider()` leaves
    // repoPath undefined and resolves its database from process.cwd(). Both of
    // these can only hold for the instance createKbProvidersForSlug built for
    // this (slug, repoPath) pair.
    expect(fallback.repoPath).toBe(repoPath);
    expect(fallback.dbPath).toBe(path.join(FLEET_DIR, 'knowledge', providers.projectSlug, 'kb.sqlite'));
  });

  it('keeps global a SqliteProvider and projectSlug identical in both modes', async () => {
    const repoPath = makeRepoPath();

    const sqliteModeProviders = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(sqliteModeProviders.global).toBeInstanceOf(SqliteProvider);
    const sqliteModeSlug = sqliteModeProviders.projectSlug;

    resetKbProviders();
    writeHttpConfig();

    const httpModeProviders = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(httpModeProviders.project).toBeInstanceOf(HttpKbProvider);
    expect(httpModeProviders.global).toBeInstanceOf(SqliteProvider);
    expect(httpModeProviders.global).not.toBeInstanceOf(HttpKbProvider);
    expect(httpModeProviders.projectSlug).toBe(sqliteModeSlug);
  });

  it('still caches per (slug, repoPath) in http mode', async () => {
    writeHttpConfig();
    const repoPath = makeRepoPath();

    const first = await getKbProviders(repoPath, REMOTE_REPO_URL);
    const second = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(second).toBe(first);
    expect(second.project).toBe(first.project);

    const otherRepoPath = makeRepoPath();
    const other = await getKbProviders(otherRepoPath, REMOTE_REPO_URL);
    expect(other).not.toBe(first);
    expect(other.project).not.toBe(first.project);
  });
});

describe('resetKbProviders provider disposal', () => {
  it('removes the beforeExit listener an HTTP project provider registered', async () => {
    writeHttpConfig();
    const repoPath = makeRepoPath();
    const baseline = process.listenerCount('beforeExit');

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    expect(process.listenerCount('beforeExit')).toBe(baseline + 1);

    resetKbProviders();
    expect(process.listenerCount('beforeExit')).toBe(baseline);

    // Idempotent: a second reset with nothing left to dispose is still safe.
    resetKbProviders();
    expect(process.listenerCount('beforeExit')).toBe(baseline);
  });

  it('does not throw when the project provider is a SqliteProvider', async () => {
    const repoPath = makeRepoPath();
    const baseline = process.listenerCount('beforeExit');

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(process.listenerCount('beforeExit')).toBe(baseline);

    expect(() => resetKbProviders()).not.toThrow();
    expect(process.listenerCount('beforeExit')).toBe(baseline);
  });
});

// my-beads-db-0cd.12: parent bead .0cd criterion 1 requires getKbProviders to
// return SqliteProvider unchanged "in every other case, including
// missing/malformed config" -- but readKbConfigFromDisk (bead .1) throws by
// design on malformed JSON / an incomplete http config. These tests pin the
// resolution: the throw still happens inside readKbConfigFromDisk (bead .1's
// own contract, unit-tested in kb-config.test.ts), but getKbProviders never
// lets it escape -- it degrades to SqliteProvider and logs exactly one loud
// warning, not a silent downgrade and not a hard failure of the whole tool.
describe('getKbProviders degrades a malformed/misconfigured KB config to SqliteProvider (my-beads-db-0cd.12)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('malformed JSON degrades to SqliteProvider, with a one-time console.error warning', async () => {
    writeMalformedConfig();
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('KB config error');
  });

  it('provider "http" missing url degrades to SqliteProvider rather than throwing', async () => {
    writeHttpConfigMissingUrl();
    const repoPath = makeRepoPath();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('the warning is one-time: a second, different (slug, repoPath) call with the same bad config does not warn again', async () => {
    writeMalformedConfig();
    const repoPathA = makeRepoPath();
    const repoPathB = makeRepoPath();

    await getKbProviders(repoPathA, REMOTE_REPO_URL);
    await getKbProviders(repoPathB, `${REMOTE_REPO_URL}-b`);

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws and never returns an HttpKbProvider for a malformed config', async () => {
    writeMalformedConfig();
    const repoPath = makeRepoPath();

    await expect(getKbProviders(repoPath, REMOTE_REPO_URL)).resolves.toBeTruthy();
  });
});

// my-beads-db-0cd.12: getKbProviders must not cache a rejected promise --
// otherwise one failed build (e.g. a SqliteProvider.init() failure unrelated
// to KB config, which the fix above no longer causes) permanently poisons that
// (slug, repoPath) cache key until resetKbProviders() or a process restart.
describe('getKbProviders evicts a rejected provider-build promise from its cache (my-beads-db-0cd.12)', () => {
  it('a later call for the same (slug, repoPath), after the failure is fixed, succeeds instead of replaying the same rejection', async () => {
    const repoPath = makeRepoPath();
    const initSpy = vi.spyOn(SqliteProvider.prototype, 'init').mockRejectedValueOnce(new Error('simulated init failure'));

    await expect(getKbProviders(repoPath, REMOTE_REPO_URL)).rejects.toThrow('simulated init failure');

    // The mock only rejects once (mockRejectedValueOnce) -- a second call for
    // the exact same key must rebuild rather than returning the same rejected
    // promise from the cache.
    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(providers.project).toBeInstanceOf(SqliteProvider);

    initSpy.mockRestore();
  });
});
