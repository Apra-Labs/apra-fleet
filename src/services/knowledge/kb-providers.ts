import path from 'path';
import fs from 'fs';
import { SqliteProvider } from './sqlite-provider.js';
import { resolveProjectSlug } from './project-slug.js';
import { FLEET_DIR } from '../../paths.js';

export interface KbProviders {
  project: SqliteProvider;
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
  return { project: projectProvider, global: globalProvider, projectSlug: slug };
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
  }
  return pending;
}

export function resetKbProviders(): void {
  _providers.clear();
  _slugCache.clear();
  _globalProvider = null;
}
