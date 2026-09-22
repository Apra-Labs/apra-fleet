import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteProvider } from './sqlite-provider.js';
import { HttpKbProvider } from './http-provider.js';
import { readKbConfigFromDisk, KB_CONFIG_PATH } from './kb-config.js';
import type { KbConfigResult } from './kb-config.js';
import { resolveProjectSlug } from './project-slug.js';
import type { MemoryProvider } from './types.js';
import { FLEET_DIR } from '../../paths.js';
import { logWarn } from '../../utils/log-helpers.js';

export interface KbProviders {
  // Widened from SqliteProvider so a config-selected HttpKbProvider can be
  // returned here. `global` stays SqliteProvider on purpose: there is exactly
  // one shared global KB and no remote story for it.
  project: MemoryProvider;
  global: SqliteProvider;
  projectSlug: string;
}

export async function createKbProviders(cwd?: string, remoteUrl?: string): Promise<KbProviders> {
  return createKbProvidersForSlug(slugFor(cwd, remoteUrl), cwd ?? process.cwd());
}

// There is exactly ONE global KB, shared by every project. Now that providers
// are cached per project slug, building it inside the per-slug factory would
// open a separate connection to the same file for every repo the process
// touches -- so it gets its own single-slot cache.
let _globalProvider: Promise<SqliteProvider> | null = null;

function getGlobalProvider(): Promise<SqliteProvider> {
  if (!_globalProvider) {
    _globalProvider = (async () => {
      const globalDir = path.join(FLEET_DIR, 'knowledge', 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      const provider = new SqliteProvider(path.join(globalDir, 'kb.sqlite'));
      await provider.init();
      return provider;
    })();
  }
  return _globalProvider;
}

// repoPath is the root the project provider anchors relative source_files at
// (the Phase 1 capture basis check and the basis hashes both use it). The global
// provider gets none on purpose: one shared KB spans every repo, so no single
// root is correct for it.
async function createKbProvidersForSlug(slug: string, repoPath: string): Promise<KbProviders> {
  const projectDir = path.join(FLEET_DIR, 'knowledge', slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const projectProvider = new SqliteProvider(path.join(projectDir, 'kb.sqlite'), repoPath);
  await projectProvider.init();
  const globalProvider = await getGlobalProvider();
  return {
    project: await selectProjectProvider(projectProvider),
    global: globalProvider,
    projectSlug: slug,
  };
}

// Every HttpKbProvider this module builds, so resetKbProviders can dispose them.
// SqliteProvider has no dispose() (it has close()), so disposal must be narrowed
// to HTTP providers -- and _providers holds unresolved Promises, which a sync
// resetKbProviders cannot read .project off of. Hence a side-list.
const _httpProviders: HttpKbProvider[] = [];

// my-beads-db-0cd.12: parent bead .0cd criterion 1 requires getKbProviders to
// return SqliteProvider unchanged "in every other case, including
// missing/malformed config" -- but readKbConfigFromDisk (bead .1) throws by
// design on malformed JSON, provider "http" without a url/token_encrypted, or
// an undecryptable token. Resolving the conflict per bead .12's decision:
// readKbConfigFromDisk keeps throwing (bead .1's contract is unchanged), and
// THIS call site catches it, degrades to the already-built SqliteProvider, and
// logs a loud warning -- never a silent downgrade, never a hard failure of
// every kb_* tool over one bad config file.
//
// my-beads-db-u00.5: the warning is suppressed per FAILURE, not per process.
// A module-level boolean meant a long-lived fleet server warned once for the
// first bad config it ever saw and then stayed silent for the life of the
// process, even after the file was edited and broke differently. The key is
// the config path plus a hash of its content, so the same broken file warns
// once (no spam on every provider build), while a changed-but-still-broken
// file warns again.
const _warnedKbConfigFailures = new Set<string>();

function kbConfigFailureKey(): string {
  let fingerprint: string;
  try {
    fingerprint = crypto.createHash('sha256').update(fs.readFileSync(KB_CONFIG_PATH)).digest('hex');
  } catch (err) {
    // The read that just failed may have raced a delete/rename; key on why.
    fingerprint = `unreadable:${(err as Error).message}`;
  }
  return `${KB_CONFIG_PATH}\0${fingerprint}`;
}

/**
 * Return the project provider the KB config selects. Stock path (no config file,
 * or provider "sqlite") returns the already-built SqliteProvider untouched.
 * A config file that fails to read (malformed JSON, http-without-url,
 * http-without-token, undecryptable token) degrades to the same SqliteProvider,
 * after a warning, once per distinct config content -- see the note above
 * _warnedKbConfigFailures.
 *
 * The HTTP branch passes that same SqliteProvider as the explicit fallback:
 * HttpKbProvider's default is a NO-ARG `new SqliteProvider()`, which resolves its
 * database from process.cwd() rather than this repo's path.
 */
async function selectProjectProvider(projectProvider: SqliteProvider): Promise<MemoryProvider> {
  let config: KbConfigResult;
  try {
    config = readKbConfigFromDisk();
  } catch (err) {
    const failureKey = kbConfigFailureKey();
    if (!_warnedKbConfigFailures.has(failureKey)) {
      _warnedKbConfigFailures.add(failureKey);
      logWarn(
        'kb-providers',
        `KB config error, falling back to SqliteProvider: ${(err as Error).message}`,
      );
    }
    return projectProvider;
  }
  if (config.provider !== 'http') {
    return projectProvider;
  }
  // my-beads-db-u00.4: the HTTP provider is init'd like any other provider,
  // rather than relying on HttpKbProvider.init() doing nothing beyond
  // re-init'ing its fallback. That fallback is the already-init'd
  // projectProvider, and SqliteProvider.init() returns early once its db is
  // open, so the double init is harmless (pinned in
  // tests/knowledge/kb-providers-http-selection.test.ts) -- and any setup
  // HttpKbProvider.init() grows later runs here instead of being skipped.
  // readKbConfigFromDisk throws on http-without-url/token, so both are present here.
  const httpProvider = new HttpKbProvider(config.url!, config.token!, projectProvider);
  try {
    await httpProvider.init();
  } catch (err) {
    // Not yet tracked in _httpProviders, so release its beforeExit listener here.
    httpProvider.dispose();
    throw err;
  }
  _httpProviders.push(httpProvider);
  return httpProvider;
}

// Keyed by (slug, repoPath), NOT slug alone and NOT a single slot. The fleet
// server is a long-lived process serving many members across many repos; a
// single memoised provider meant the first kb_* call bound every later call
// -- from every repo -- to one database. Keying by slug alone still let the
// first caller to resolve a given slug fix repoPath (load-bearing for the
// capture basis check and freshness sweep) for every later caller resolving
// to that same slug. Joined with NUL, which cannot appear in either
// component, so distinct pairs cannot collide into one key.
const _providers = new Map<string, Promise<KbProviders>>();

function providerKey(slug: string, repoPath: string): string {
  return `${slug}\0${repoPath}`;
}
// resolveProjectSlug shells out to git, so cache per (cwd, remoteUrl) pair --
// keying by cwd alone would let the first call for a directory pin its slug,
// leaving a later call that does supply a remote URL stuck with the stale
// value. Joined with NUL, which cannot appear in a path or URL, so distinct
// pairs cannot collide into one key.
const _slugCache = new Map<string, string>();

function slugFor(cwd?: string, remoteUrl?: string): string {
  const dir = cwd ?? process.cwd();
  const key = `${dir}\0${remoteUrl ?? ''}`;
  let slug = _slugCache.get(key);
  if (slug === undefined) {
    slug = resolveProjectSlug(dir, remoteUrl);
    _slugCache.set(key, slug);
  }
  return slug;
}

/**
 * Resolve the KB providers for a repo. `cwd` should be the repo the call is
 * about -- omitting it falls back to the calling process's cwd, which is only
 * correct for single-repo CLI invocations, never for server-handled tool calls.
 */
export async function getKbProviders(cwd?: string, remoteUrl?: string): Promise<KbProviders> {
  const slug = slugFor(cwd, remoteUrl);
  const repoPath = cwd ?? process.cwd();
  const key = providerKey(slug, repoPath);
  let pending = _providers.get(key);
  if (!pending) {
    // Store the promise, not the resolved value, so concurrent callers for the
    // same (slug, repoPath) pair share one provider instead of racing to build
    // two. Two different repoPaths sharing a slug get two SqliteProvider
    // handles on the same kb.sqlite file -- safe, since SqliteProvider.init
    // sets WAL + busy_timeout=5000.
    pending = createKbProvidersForSlug(slug, repoPath);
    _providers.set(key, pending);
    // my-beads-db-0cd.12: do NOT cache a rejected promise. Without this, one
    // failed build (e.g. a disk error, not the config-read case above which no
    // longer throws) permanently poisons this cache key: every later call for
    // the same (slug, repoPath) gets the same rejected promise back, and
    // fixing whatever caused the failure never recovers without a full
    // resetKbProviders() or process restart. This .catch() is attached purely
    // for cleanup -- it does not consume the rejection for `pending` itself,
    // so the original caller (and every other awaiter of this same promise)
    // still observes the rejection normally.
    pending.catch(() => {
      if (_providers.get(key) === pending) {
        _providers.delete(key);
      }
    });
  }
  return pending;
}

export function resetKbProviders(): void {
  // HttpKbProvider registers a process 'beforeExit' listener in its constructor;
  // clearing the maps alone leaks one listener per reset, and a suite that resets
  // repeatedly hits MaxListenersExceededWarning.
  for (const httpProvider of _httpProviders) {
    httpProvider.dispose();
  }
  _httpProviders.length = 0;
  _providers.clear();
  _slugCache.clear();
  _globalProvider = null;
  _warnedKbConfigFailures.clear();
}
