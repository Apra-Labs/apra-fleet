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

export async function createKbProviders(cwd?: string): Promise<KbProviders> {
  return createKbProvidersForSlug(slugFor(cwd), cwd ?? process.cwd());
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

// Keyed by resolved project slug, NOT a single slot. The fleet server is a
// long-lived process serving many members across many repos; a single memoised
// provider meant the first kb_* call bound every later call -- from every repo
// -- to one database. Callers must pass the repo the call is about.
const _providers = new Map<string, Promise<KbProviders>>();
// resolveProjectSlug shells out to git, so cache per directory. Keyed by the
// literal cwd argument, since two paths can legitimately share a slug.
const _slugCache = new Map<string, string>();

function slugFor(cwd?: string): string {
  const key = cwd ?? process.cwd();
  let slug = _slugCache.get(key);
  if (slug === undefined) {
    slug = resolveProjectSlug(key);
    _slugCache.set(key, slug);
  }
  return slug;
}

/**
 * Resolve the KB providers for a repo. `cwd` should be the repo the call is
 * about -- omitting it falls back to the calling process's cwd, which is only
 * correct for single-repo CLI invocations, never for server-handled tool calls.
 */
export async function getKbProviders(cwd?: string): Promise<KbProviders> {
  const slug = slugFor(cwd);
  let pending = _providers.get(slug);
  if (!pending) {
    // Store the promise, not the resolved value, so concurrent callers for the
    // same slug share one provider instead of racing to build two.
    pending = createKbProvidersForSlug(slug, cwd ?? process.cwd());
    _providers.set(slug, pending);
  }
  return pending;
}

export function resetKbProviders(): void {
  _providers.clear();
  _slugCache.clear();
  _globalProvider = null;
}
