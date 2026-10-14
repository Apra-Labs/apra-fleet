// Pure reader of a repo's gitnexus index directory (<repo>/.gitnexus). Its own
// leaf module (no project imports) so both the readiness check and the analyze
// runner (code-intelligence-reindex.ts) can use it without a circular import.
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** What the gitnexus index directory of a repo says about itself. */
export interface GitNexusIndexState {
  /** <repo>/.gitnexus/meta.json exists and parses. */
  metaPresent: boolean;
  /** meta.lastCommit; '' for a placeholder or an absent meta. */
  lastCommit: string;
  /** meta.indexedAt (ISO time gitnexus stamped the build); '' when absent. */
  indexedAt: string;
  /** meta.incrementalInProgress is set (an analyze is mid-write or died mid-write). */
  incrementalInProgress: boolean;
  /** The analyze lock is held by a live process. */
  lockHeld: boolean;
}

// Verified against the installed gitnexus 1.6.12 package:
//  - dist/storage/index-lock.js: LOCK_FILENAME = 'analyze.lock', a JSON pidfile
//    ({ pid, hostname, token, ... }) in the index meta dir (<repo>/.gitnexus).
//    This is the macOS/BSD (and fallback) backend; the Windows/Linux socket
//    backend leaves no file, so for those hosts the file check is a no-op and
//    the status.json/in-process running signal covers an analyze we started.
//    A file that exists but cannot be parsed is treated as held (conservative:
//    gitnexus itself treats it as a half-written live lock).
//  - dist/core/index-freshness.js getIndexIncompleteReasons: meta
//    `incrementalInProgress` set => 'incremental-in-progress' (index incomplete).
export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function analyzeLockHeld(gitnexusDir: string): boolean {
  const lockPath = join(gitnexusDir, 'analyze.lock');
  if (!existsSync(lockPath)) return false;
  try {
    const rec = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 0) return isPidAlive(rec.pid);
  } catch { /* malformed / half-written: fall through to held */ }
  return true;
}

/** Read the gitnexus index state of `repo`. Never throws. */
export function readGitNexusIndexState(repo: string): GitNexusIndexState {
  const dir = join(repo, '.gitnexus');
  const state: GitNexusIndexState = { metaPresent: false, lastCommit: '', indexedAt: '', incrementalInProgress: false, lockHeld: false };
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
      lastCommit?: unknown; indexedAt?: unknown; incrementalInProgress?: unknown;
    };
    state.metaPresent = true;
    state.lastCommit = typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
    state.indexedAt = typeof meta.indexedAt === 'string' ? meta.indexedAt : '';
    state.incrementalInProgress = !!meta.incrementalInProgress;
  } catch { /* absent or unparseable meta reads as no index */ }
  try { state.lockHeld = analyzeLockHeld(dir); } catch { /* ignore */ }
  return state;
}


/**
 * An identity for the index generation on disk: changes whenever an analyze
 * finishes (new lastCommit and/or indexedAt). '' when there is no meta.json.
 * Used to notice that the index under a long-lived reader (the gitnexus MCP
 * child) was replaced, and that an index changed while a call was answered.
 */
export function indexGeneration(state: GitNexusIndexState): string {
  return state.metaPresent ? `${state.lastCommit}|${state.indexedAt}` : '';
}

// gitnexus keeps a second copy of every index's metadata in its global
// registry (verified against gitnexus 1.6.12 dist/storage/global-dir.js and
// repo-manager.js): <GITNEXUS_HOME or ~/.gitnexus>/registry.json, an array of
// { path, storagePath, lastCommit, indexedAt, ... }. analyze writes meta.json
// first and registers the repo after it, so a run that dies between the two
// leaves the copies disagreeing -- and the gitnexus MCP server resolves repos
// through the registry.
function gitnexusRegistryPath(): string {
  const home = process.env.GITNEXUS_HOME || join(homedir(), '.gitnexus');
  return join(home, 'registry.json');
}

/** What fleet recorded about the last analyze it ran for a repo. */
export interface RecordedIndexBuild {
  /** meta.lastCommit right after fleet's analyze finished. */
  indexedCommit: string;
  /** ISO time that analyze finished. */
  finished: string;
}

/**
 * Why the index metadata of `repo` disagrees with itself, or null when it is
 * consistent (or there is nothing to compare against). Two cross-checks, each
 * skipped when its second copy is absent:
 *
 *  - gitnexus registry: every registry entry whose storagePath is this repo's
 *    .gitnexus disagrees with meta.lastCommit.
 *  - fleet's record (`recorded`): fleet's last finished analyze saw commit X,
 *    meta now says Y, and meta was not rewritten by a later analyze (its
 *    indexedAt is not after fleet's run finished).
 *
 * Never throws; any IO failure reads as "no evidence of inconsistency".
 */
export function indexInconsistency(repo: string, state: GitNexusIndexState, recorded?: RecordedIndexBuild | null): string | null {
  if (!state.metaPresent || state.lastCommit === '') return null;
  const short = (c: string): string => c.slice(0, 8);
  try {
    const raw = JSON.parse(readFileSync(gitnexusRegistryPath(), 'utf8')) as unknown;
    const entries = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { repos?: unknown }).repos) ? (raw as { repos: unknown[] }).repos : []);
    const storage = resolve(repo, '.gitnexus');
    const mine = entries.filter((e): e is { storagePath: string; lastCommit?: unknown } =>
      !!e && typeof e === 'object' && typeof (e as { storagePath?: unknown }).storagePath === 'string'
      && resolve((e as { storagePath: string }).storagePath) === storage);
    const commits = mine.map((e) => (typeof e.lastCommit === 'string' ? e.lastCommit : ''));
    if (commits.length > 0 && !commits.includes(state.lastCommit)) {
      return `gitnexus's registry records the index at ${short(commits[0]) || '(none)'} but its meta.json says ${short(state.lastCommit)}`;
    }
  } catch { /* no registry, or unreadable: no evidence */ }
  if (recorded && recorded.indexedCommit && recorded.indexedCommit !== state.lastCommit) {
    const fin = Date.parse(recorded.finished);
    const at = Date.parse(state.indexedAt);
    const rewrittenLater = Number.isFinite(at) && Number.isFinite(fin) && at > fin;
    if (!rewrittenLater) {
      return `fleet's last analyze recorded the index at ${short(recorded.indexedCommit)} but meta.json now says ${short(state.lastCommit)}`;
    }
  }
  return null;
}
