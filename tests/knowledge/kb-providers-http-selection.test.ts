import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { getActiveLogFile, logLine } from '../../src/utils/log-helpers.js';
import { kbSetup } from '../../src/tools/kb-setup.js';

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

function writeHttpConfigMissingToken(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'http', url: REMOTE_KB_URL }, null, 2));
}

// `fallback` is private on HttpKbProvider -- a compile-time marker only. Reading
// it through a cast is how this suite proves the fallback is the project
// SqliteProvider getKbProviders built, with no mock or subclass involved.
function fallbackOf(provider: HttpKbProvider): SqliteProvider {
  return (provider as unknown as { fallback: SqliteProvider }).fallback;
}

// Real fleet log file logWarn writes (no console spy). It is an async
// WriteStream, so a test writes its own sentinel line last via logLine and
// polls until the sentinel lands -- everything written before it on the same
// stream is then guaranteed to be on disk too.
function readLogLines(): Array<{ level: string; tag: string; msg: string }> {
  const logFile = getActiveLogFile();
  if (!logFile) throw new Error('u00.5 test: no active fleet log file (FLEET_DIR/logs unavailable)');
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

async function flushLogWithSentinel(): Promise<void> {
  const sentinel = `u00.5-sentinel-${crypto.randomUUID()}`;
  logLine('kb-providers-test', sentinel);
  const deadline = Date.now() + 5000;
  while (!readLogLines().some(l => l.msg === sentinel)) {
    if (Date.now() > deadline) throw new Error(`u00.5 test: log sentinel ${sentinel} never reached the log file`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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

// my-beads-db-0d3.1: selection used to run once per (slug, repoPath) inside
// the memoised build, so on a long-lived fleet server kb_setup changed nothing
// until a restart. These run the real kb_setup tool in this process and prove
// the very next getKbProviders call honours what it wrote.
describe('kb_setup takes effect within one process (my-beads-db-0d3.1)', () => {
  it('switches a cached repo sqlite -> http -> sqlite without a reset, reusing the same project SqliteProvider', async () => {
    const repoPath = makeRepoPath();

    const before = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(before.project).toBeInstanceOf(SqliteProvider);
    expect(before.project).not.toBeInstanceOf(HttpKbProvider);

    await kbSetup({ repo_path: repoPath, provider: 'http', remote: REMOTE_KB_URL, token: FAKE_TOKEN });
    const remote = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(remote.project).toBeInstanceOf(HttpKbProvider);
    // The remote provider falls back to the SAME project SqliteProvider the
    // sqlite-mode call returned: the switch reselects, it does not reopen.
    expect(fallbackOf(remote.project as HttpKbProvider)).toBe(before.project);
    expect(remote.global).toBe(before.global);
    expect(remote.projectSlug).toBe(before.projectSlug);

    await kbSetup({ repo_path: repoPath, provider: 'sqlite' });
    const after = await getKbProviders(repoPath, REMOTE_REPO_URL);
    expect(after.project).toBeInstanceOf(SqliteProvider);
    expect(after.project).not.toBeInstanceOf(HttpKbProvider);
    expect(after.project).toBe(before.project);
  });

  it('an unchanged config still returns the identical cached object after a switch', async () => {
    const repoPath = makeRepoPath();
    await getKbProviders(repoPath, REMOTE_REPO_URL);

    await kbSetup({ repo_path: repoPath, provider: 'http', remote: REMOTE_KB_URL, token: FAKE_TOKEN });
    const first = await getKbProviders(repoPath, REMOTE_REPO_URL);
    const second = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(second).toBe(first);
    expect(second.project).toBe(first.project);
  });

  it('accumulates no beforeExit listener across repeated http <-> sqlite switches', async () => {
    const repoPath = makeRepoPath();
    const baseline = process.listenerCount('beforeExit');

    for (let i = 0; i < 5; i++) {
      await kbSetup({ repo_path: repoPath, provider: 'http', remote: REMOTE_KB_URL, token: FAKE_TOKEN });
      const remote = await getKbProviders(repoPath, REMOTE_REPO_URL);
      expect(remote.project).toBeInstanceOf(HttpKbProvider);
      expect(process.listenerCount('beforeExit')).toBe(baseline + 1);

      await kbSetup({ repo_path: repoPath, provider: 'sqlite' });
      const local = await getKbProviders(repoPath, REMOTE_REPO_URL);
      expect(local.project).not.toBeInstanceOf(HttpKbProvider);
      expect(process.listenerCount('beforeExit')).toBe(baseline);
    }
  });

  it('warns, naming the count and kb_harvest, when a replaced HttpKbProvider still had queued captures', async () => {
    const repoPath = makeRepoPath();
    await kbSetup({ repo_path: repoPath, provider: 'http', remote: REMOTE_KB_URL, token: FAKE_TOKEN });
    const remote = await getKbProviders(repoPath, REMOTE_REPO_URL);
    const httpProvider = remote.project as HttpKbProvider;
    httpProvider.offlineQueue.push({ op: 'invalidate', files: ['a.ts'] }, { op: 'invalidate', files: ['b.ts'] });

    await kbSetup({ repo_path: repoPath, provider: 'sqlite' });
    await getKbProviders(repoPath, REMOTE_REPO_URL);

    await flushLogWithSentinel();
    const warnings = readLogLines().filter(l => l.level === 'warn' && l.tag === 'kb-providers' && l.msg.includes('offline queue'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toContain('2 unsent captures');
    expect(warnings[0].msg).toContain('kb_harvest');
  });

  it('re-running kb_setup with a different http config replaces the old HttpKbProvider and disposes it', async () => {
    const repoPath = makeRepoPath();
    const baseline = process.listenerCount('beforeExit');

    await kbSetup({ repo_path: repoPath, provider: 'http', remote: REMOTE_KB_URL, token: FAKE_TOKEN });
    const first = await getKbProviders(repoPath, REMOTE_REPO_URL);

    await kbSetup({ repo_path: repoPath, provider: 'http', remote: `${REMOTE_KB_URL}/v2`, token: FAKE_TOKEN });
    const second = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(second.project).toBeInstanceOf(HttpKbProvider);
    expect(second.project).not.toBe(first.project);
    expect(process.listenerCount('beforeExit')).toBe(baseline + 1);
  });
});

// my-beads-db-u00.4: selectProjectProvider now init()s the HttpKbProvider it
// returns, which re-inits the already-init'd project SqliteProvider beneath
// it. These prove that double init is harmless on real instances rather than
// assuming it: the open db handle survives, stored entries stay queryable,
// and no extra beforeExit listener appears.
describe('provider init is idempotent (my-beads-db-u00.4)', () => {
  function dbOf(provider: SqliteProvider): unknown {
    return (provider as unknown as { db: unknown }).db;
  }

  function entryFor(title: string) {
    return {
      type: 'knowledge' as const,
      title,
      summary: `${title} summary`,
      content: `${title} content`,
      source_files: ['fixture.ts'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256' as const,
      flagged_for_review: false,
      author: 'doer',
      source: 'session' as const,
      confidence: 'INFERRED' as const,
    };
  }

  function makeRepoWithFixture(): string {
    const repoPath = makeRepoPath();
    fs.writeFileSync(path.join(repoPath, 'fixture.ts'), '// init idempotency fixture\n');
    return repoPath;
  }

  it('SqliteProvider: a second init keeps the same db handle and the stored entry', async () => {
    const repoPath = makeRepoWithFixture();
    const sqlite = new SqliteProvider(path.join(repoPath, 'kb.sqlite'), repoPath);
    try {
      await sqlite.init();
      const handle = dbOf(sqlite);
      expect(handle).not.toBeNull();
      const { id } = await sqlite.capture(entryFor('idempotentSqliteInit'));

      await sqlite.init();

      expect(dbOf(sqlite)).toBe(handle);
      const result = await sqlite.query({ query: 'idempotentSqliteInit' });
      expect(result.results.some(e => e.id === id)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('getKbProviders http mode: the returned provider is init-safe to init again, keeps its fallback handle and data, and adds no listener', async () => {
    writeHttpConfig();
    const repoPath = makeRepoWithFixture();

    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);
    const httpProvider = providers.project as HttpKbProvider;
    const fallback = fallbackOf(httpProvider);
    const handle = dbOf(fallback);
    expect(handle).not.toBeNull();
    const { id } = await fallback.capture(entryFor('idempotentHttpInit'));
    const listenersBefore = process.listenerCount('beforeExit');

    await expect(httpProvider.init()).resolves.toBeUndefined();

    expect(dbOf(fallback)).toBe(handle);
    expect(process.listenerCount('beforeExit')).toBe(listenersBefore);
    const result = await fallback.query({ query: 'idempotentHttpInit' });
    expect(result.results.some(e => e.id === id)).toBe(true);
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

  // my-beads-db-0cd.8 criterion 3: both halves of the layering asserted
  // against the SAME config, in one test, so a future change cannot remove
  // either half silently -- readKbConfigFromDisk (bead .1's own contract,
  // unit-tested in isolation in kb-config.test.ts) must still throw naming
  // "url" on this exact config, and selectProjectProvider's catch must
  // convert that throw into a SqliteProvider degrade plus a one-time warning
  // that names the same offending key.
  it('provider "http" missing url: readKbConfigFromDisk still throws naming "url" in isolation, and getKbProviders degrades to SqliteProvider with a warning naming "url"', async () => {
    writeHttpConfigMissingUrl();

    expect(() => readKbConfigFromDisk()).toThrowError(/url/);

    const repoPath = makeRepoPath();
    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/url/);
  });

  // Sibling of the above for the other half of criterion 3: a config missing
  // token_encrypted instead of url. Same layering, same two assertions.
  it('provider "http" missing token_encrypted: readKbConfigFromDisk still throws naming "token_encrypted" in isolation, and getKbProviders degrades to SqliteProvider with a warning naming "token_encrypted"', async () => {
    writeHttpConfigMissingToken();

    expect(() => readKbConfigFromDisk()).toThrowError(/token_encrypted/);

    const repoPath = makeRepoPath();
    const providers = await getKbProviders(repoPath, REMOTE_REPO_URL);

    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/token_encrypted/);
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

// my-beads-db-u00.5: the malformed-config warning used to be suppressed by a
// module-level boolean, so a long-lived fleet server warned ONCE per process
// and then stayed silent even after the config was edited and broke again.
// Suppression is now keyed by config path + content hash. Asserted against
// the real fleet log file logWarn writes (no console spy): that file is an
// async WriteStream, so each test writes its own sentinel line last via
// logLine and polls until the sentinel lands -- everything written before it
// on the same stream is then guaranteed to be on disk too.
describe('malformed-config warning is keyed by config content, not suppressed per process (my-beads-db-u00.5)', () => {
  const WARN_TEXT = 'KB config error, falling back to SqliteProvider';

  function countConfigWarnings(): number {
    return readLogLines().filter(l => l.level === 'warn' && l.tag === 'kb-providers' && l.msg.includes(WARN_TEXT)).length;
  }

  function writeRawConfig(content: string): void {
    fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, content);
  }

  it('two different slugs hitting two different malformed configs produce TWO warnings', async () => {
    await flushLogWithSentinel();
    const baseline = countConfigWarnings();

    writeRawConfig('{ first broken config');
    await getKbProviders(makeRepoPath(), `${REMOTE_REPO_URL}-u005-a`);
    writeRawConfig('{ second, differently broken config');
    await getKbProviders(makeRepoPath(), `${REMOTE_REPO_URL}-u005-b`);

    await flushLogWithSentinel();
    expect(countConfigWarnings() - baseline).toBe(2);
  });

  it('a config edited and still malformed warns again rather than staying suppressed for the life of the process', async () => {
    await flushLogWithSentinel();
    const baseline = countConfigWarnings();
    const repoPath = makeRepoPath();

    writeRawConfig(JSON.stringify({ provider: 'http', token_encrypted: encryptPassword(FAKE_TOKEN) }));
    await getKbProviders(repoPath, `${REMOTE_REPO_URL}-u005-c`);
    await flushLogWithSentinel();
    expect(countConfigWarnings() - baseline).toBe(1);

    // Edited, still broken (now missing token_encrypted instead of url).
    writeRawConfig(JSON.stringify({ provider: 'http', url: REMOTE_KB_URL }));
    await getKbProviders(makeRepoPath(), `${REMOTE_REPO_URL}-u005-d`);
    await flushLogWithSentinel();
    const lines = readLogLines().filter(l => l.level === 'warn' && l.msg.includes(WARN_TEXT));
    expect(countConfigWarnings() - baseline).toBe(2);
    expect(lines[lines.length - 1].msg).toContain('token_encrypted');
  });

  it('the same malformed config failing repeatedly across many provider builds warns only once', async () => {
    await flushLogWithSentinel();
    const baseline = countConfigWarnings();

    writeRawConfig('{ repeatedly broken config');
    for (let i = 0; i < 5; i++) {
      await getKbProviders(makeRepoPath(), `${REMOTE_REPO_URL}-u005-repeat-${i}`);
    }

    await flushLogWithSentinel();
    expect(countConfigWarnings() - baseline).toBe(1);
  });
});
