// Member bible view: MEMBER-session KB reads come from an in-memory SQLite view
// of the member's own checkout bible, (self)/.fleet/kb-canonical.json.
//
// Why a view and not the per-repo DB: several members of ONE repository share
// one per-repo kb.sqlite (KB identity is the origin remote), but their
// checkouts can sit on different branches whose bibles differ. Each member
// must see the CONFIRMED set its own checkout carries.
//
// How:
//   - The bible is loaded into a SqliteProvider over DatabaseSync(':memory:')
//     -- the SAME provider class the per-repo DB uses, so ranking, prime() and
//     relatedClaims() behave identically. Entries go through the shared
//     bible-import loader (import mode: bible confidence preserved, directives
//     quarantined as pending proposals), exactly as kb_import would.
//   - One view per bible file path, so members on different branches (different
//     checkouts, different paths) get different views.
//   - Each read does ONE fs.stat. When mtimeMs or size differs from the values
//     recorded at the last load, the view is rebuilt. The file is never hashed.
//   - The cache is process memory only: a server restart starts empty and the
//     first read rebuilds. No file, table or column is added anywhere.
//   - A missing bible is an empty view. A malformed bible throws KbBibleError
//     (E-BIBLE-MALFORMED) every time it is read; it is never cached as empty.
//   - An anchor whose folder is on another host (remoteUrl set) cannot be read
//     here: KbMemberViewError (E-MEMBER-VIEW-REMOTE). It never falls back to the
//     per-repo DB.

import fs from 'node:fs';
import path from 'node:path';
import { SqliteProvider } from './sqlite-provider.js';
import { readBibleEntries, importBibleEntries } from './bible-import.js';
import type { KbAnchor } from './kb-self.js';

export type KbMemberViewErrorCode = 'E-MEMBER-VIEW-REMOTE';

export class KbMemberViewError extends Error {
  readonly code: KbMemberViewErrorCode;
  readonly folder: string;
  readonly remediation: string;
  constructor(code: KbMemberViewErrorCode, folder: string, problem: string, remediation: string) {
    super(`${code}: ${problem} Remediation: ${remediation}`);
    this.name = 'KbMemberViewError';
    this.code = code;
    this.folder = folder;
    this.remediation = remediation;
  }
}

/** The bible file a member view is built from. */
export function memberBiblePath(folder: string): string {
  return path.join(folder, '.fleet', 'kb-canonical.json');
}

interface ViewSlot {
  /** -1 / -1 when the bible was missing at load time. */
  mtimeMs: number;
  size: number;
  provider: Promise<SqliteProvider>;
}

const _views = new Map<string, ViewSlot>();
const _loadCounts = new Map<string, number>();

function statOrMissing(biblePath: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(biblePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mtimeMs: -1, size: -1 };
    throw err;
  }
}

async function buildView(biblePath: string, repoRoot: string, missing: boolean): Promise<SqliteProvider> {
  _loadCounts.set(biblePath, (_loadCounts.get(biblePath) ?? 0) + 1);
  // Parse BEFORE opening the database, so a malformed bible costs nothing.
  const entries = missing ? [] : readBibleEntries(biblePath, 'member bible view');
  // repoRoot anchors relative source_files exactly as the per-repo provider
  // does, so the capture basis check and prime()'s freshness check judge the
  // bible against the member's own checkout.
  const provider = new SqliteProvider(':memory:', repoRoot);
  await provider.init();
  if (entries.length > 0) await importBibleEntries(provider, entries);
  return provider;
}

/**
 * The in-memory view of the anchor's checkout bible. Rebuilt when the file's
 * mtime or size changed since the last load; otherwise the cached view.
 */
export async function getMemberBibleView(anchor: KbAnchor): Promise<SqliteProvider> {
  if (anchor.remoteUrl !== undefined) {
    throw new KbMemberViewError(
      'E-MEMBER-VIEW-REMOTE',
      anchor.folder,
      `The member work folder '${anchor.folder}' is on another host, so its checkout bible (.fleet/kb-canonical.json) cannot be read by the fleet server.`,
      'Register the member with a work folder on the fleet server host (agentType local), or read the shared project KB from a non-member session.',
    );
  }
  const biblePath = memberBiblePath(anchor.folder);
  const { mtimeMs, size } = statOrMissing(biblePath);
  const current = _views.get(biblePath);
  if (current && current.mtimeMs === mtimeMs && current.size === size) {
    return current.provider;
  }
  // The replaced view is not closed: a concurrent reader may still hold it
  // mid-call. Dropping the reference lets it be collected.
  const slot: ViewSlot = { mtimeMs, size, provider: buildView(biblePath, anchor.folder, mtimeMs === -1) };
  _views.set(biblePath, slot);
  // Never cache a failed build (a malformed bible must fail on every read, and
  // a fixed bible must load without a restart).
  slot.provider.catch(() => {
    if (_views.get(biblePath) === slot) _views.delete(biblePath);
  });
  return slot.provider;
}

/** Number of times the view for this bible path has been (re)built. For tests. */
export function memberBibleViewLoadCount(biblePath: string): number {
  return _loadCounts.get(biblePath) ?? 0;
}

/** Drop every cached view (what a server restart does). */
export function resetMemberBibleViews(): void {
  _views.clear();
  _loadCounts.clear();
}
