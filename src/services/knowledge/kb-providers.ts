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

// The config-independent half of a repo's providers: the project
// SqliteProvider and the shared global one. Built once per (slug, repoPath);
// which provider the KB config selects on top of it is decided per call (see
// _selections below), so a config change never reopens these databases.
interface KbBaseProviders {
  projectSqlite: SqliteProvider;
  global: SqliteProvider;
}

// repoPath is the root the project provider anchors relative source_files at
// (the Phase 1 capture basis check and the basis hashes both use it). The global
// provider gets none on purpose: one shared KB spans every repo, so no single
// root is correct for it.
async function createBaseProvidersForSlug(slug: string, repoPath: string): Promise<KbBaseProviders> {
  const projectDir = path.join(FLEET_DIR, 'knowledge', slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const projectSqlite = new SqliteProvider(path.join(projectDir, 'kb.sqlite'), repoPath);
  await projectSqlite.init();
  const global = await getGlobalProvider();
  return { projectSqlite, global };
}

async function createKbProvidersForSlug(slug: string, repoPath: string): Promise<KbProviders> {
  return withSelectedProject(await createBaseProvidersForSlug(slug, repoPath), slug, kbConfigFingerprint());
}

async function withSelectedProject(base: KbBaseProviders, slug: string, configFingerprint: string): Promise<KbProviders> {
  return {
    project: await selectProjectProvider(base.projectSqlite, configFingerprint),
    global: base.global,
    projectSlug: slug,
  };
}

// Every HttpKbProvider this module builds, so resetKbProviders can dispose them.
// SqliteProvider has no dispose() (it has close()), so disposal must be narrowed
// to HTTP providers -- and _selections holds unresolved Promises, which a sync
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

// Path plus a hash of the config file's content: the one fingerprint used both
// to suppress repeat warnings for the same broken file and, in getKbProviders,
// to notice that the config changed and the selection must be redone.
function kbConfigFingerprint(): string {
  let contentHash: string;
  try {
    contentHash = crypto.createHash('sha256').update(fs.readFileSync(KB_CONFIG_PATH)).digest('hex');
  } catch (err) {
    // Absent file, or a read that raced a delete/rename; key on why.
    contentHash = `unreadable:${(err as Error).message}`;
  }
  return `${KB_CONFIG_PATH}\0${contentHash}`;
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
async function selectProjectProvider(projectProvider: SqliteProvider, configFingerprint: string): Promise<MemoryProvider> {
  let config: KbConfigResult;
  try {
    config = readKbConfigFromDisk();
  } catch (err) {
    if (!_warnedKbConfigFailures.has(configFingerprint)) {
      _warnedKbConfigFailures.add(configFingerprint);
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
const _baseProviders = new Map<string, Promise<KbBaseProviders>>();

// my-beads-db-0d3.1: the config-selected providers, per (slug, repoPath), tagged
// with the config fingerprint they were selected under. Selection used to
// happen once inside the memoised build, so on a long-lived fleet server a
// kb_setup that pointed the install at a remote KB changed nothing until a
// restart. getKbProviders now fingerprints the config on every call and
// redoes the selection when it changed -- whichever process wrote the file.
interface KbSelection {
  configFingerprint: string;
  providers: Promise<KbProviders>;
}
const _selections = new Map<string, KbSelection>();

function providerKey(slug: string, repoPath: string): string {
  return `${slug}\0${repoPath}`;
}

// my-beads-db-0cd.12: do NOT cache a rejected promise. Without this, one
// failed build (e.g. a disk error, not the config-read case above which no
// longer throws) permanently poisons this cache key: every later call for
// the same (slug, repoPath) gets the same rejected promise back, and
// fixing whatever caused the failure never recovers without a full
// resetKbProviders() or process restart. This .catch() is attached purely
// for cleanup -- it does not consume the rejection for the cached promise
// itself, so every awaiter still observes the rejection normally.
function evictOnReject<V>(cache: Map<string, V>, key: string, entry: V, pending: Promise<unknown>): void {
  pending.catch(() => {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
  });
}

function getBaseProviders(slug: string, repoPath: string, key: string): Promise<KbBaseProviders> {
  let pending = _baseProviders.get(key);
  if (!pending) {
    // Store the promise, not the resolved value, so concurrent callers for the
    // same (slug, repoPath) pair share one provider instead of racing to build
    // two. Two different repoPaths sharing a slug get two SqliteProvider
    // handles on the same kb.sqlite file -- safe, since SqliteProvider.init
    // sets WAL + busy_timeout=5000.
    pending = createBaseProvidersForSlug(slug, repoPath);
    _baseProviders.set(key, pending);
    evictOnReject(_baseProviders, key, pending, pending);
  }
  return pending;
}

function disposeIfHttp(provider: MemoryProvider): void {
  if (!(provider instanceof HttpKbProvider)) return;
  // dispose() removes the beforeExit hook that would have reported unsent
  // captures at exit, so report them now instead of dropping them silently.
  if (provider.offlineQueue.length > 0) {
    logWarn(
      'kb-providers',
      `KB config changed: the replaced remote KB provider still had ${provider.offlineQueue.length} ` +
      'unsent captures in its offline queue. Run kb_harvest on the session transcript to recover them.',
    );
  }
  provider.dispose();
  const index = _httpProviders.indexOf(provider);
  if (index !== -1) _httpProviders.splice(index, 1);
}

// A superseded selection's HttpKbProvider is disposed so its beforeExit
// listener does not outlive it (the leak my-beads-db-u00.2 fixed in kb-server).
// dispose() only removes that listener, so a caller still holding the old
// provider mid-call keeps a working provider.
function retireSelection(selection: KbSelection): void {
  selection.providers.then(
    providers => disposeIfHttp(providers.project),
    () => {
      // Nothing to dispose: every awaiter of this build already received its
      // rejection, and selectProjectProvider disposes an HttpKbProvider whose
      // init fails before rethrowing.
    },
  );
}

async function selectProviders(slug: string, repoPath: string, key: string, configFingerprint: string): Promise<KbProviders> {
  return withSelectedProject(await getBaseProviders(slug, repoPath, key), slug, configFingerprint);
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
 *
 * Returns the identical object for repeated calls on the same (slug, repoPath)
 * while the KB config is unchanged. Once the config content changes, the next
 * call selects the project provider afresh; the SqliteProviders underneath are
 * reused, never reopened.
 */
export async function getKbProviders(cwd?: string, remoteUrl?: string): Promise<KbProviders> {
  const slug = slugFor(cwd, remoteUrl);
  const repoPath = cwd ?? process.cwd();
  const key = providerKey(slug, repoPath);
  const configFingerprint = kbConfigFingerprint();
  const current = _selections.get(key);
  if (current && current.configFingerprint === configFingerprint) {
    return current.providers;
  }
  if (current) {
    retireSelection(current);
  }
  const selection: KbSelection = {
    configFingerprint,
    providers: selectProviders(slug, repoPath, key, configFingerprint),
  };
  _selections.set(key, selection);
  evictOnReject(_selections, key, selection, selection.providers);
  return selection.providers;
}

export function resetKbProviders(): void {
  // HttpKbProvider registers a process 'beforeExit' listener in its constructor;
  // clearing the maps alone leaks one listener per reset, and a suite that resets
  // repeatedly hits MaxListenersExceededWarning.
  for (const httpProvider of _httpProviders) {
    httpProvider.dispose();
  }
  _httpProviders.length = 0;
  _baseProviders.clear();
  _selections.clear();
  _slugCache.clear();
  _globalProvider = null;
  _warnedKbConfigFailures.clear();
}
