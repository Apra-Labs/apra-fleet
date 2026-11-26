import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSelfReadKb, type KbAnchor } from '../services/knowledge/kb-self.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import {
  partitionProjectBibleCandidates, findHashDriftedBibleEntries, type BibleDisqualification,
} from '../services/knowledge/bible-basis-filter.js';

const HASH_DRIFT_ID_CAP = 20;

export interface BibleNotExportable {
  count: number;
  reasons: { basis_missing: number; basis_mismatched: number; file_absent: number; path_outside_repo: number };
}
export interface BibleHashDrifted { count: number; ids: string[]; unhashed: number }
export interface BibleStats {
  present: boolean;
  entries: number;
  drift: number;
  not_exportable: BibleNotExportable;
  hash_drifted: BibleHashDrifted;
}

function emptyNotExportable(): BibleNotExportable {
  return { count: 0, reasons: { basis_missing: 0, basis_mismatched: 0, file_absent: 0, path_outside_repo: 0 } };
}


// T2.1 (F5, D4): kb_stats -- a read-only aggregation tool, following the
// kb_list no-bump pattern (SqliteProvider.stats() never touches use_count/
// last_accessed). Reports the KB's health: confidence/type totals,
// stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, canon-
// ical-bible drift (D5), and optional per-symbol coverage.
//
// D5 constraint (stated here per the tool description, verbatim intent):
// bible drift is VISIBILITY for the machine that owns the KB -- CI cannot see
// the local kb.sqlite, so no CI gate reads this tool or its drift number.
export const kbStatsSchema = z.object({
  symbols: z.array(z.string()).optional()
    .describe('Symbols to check coverage for: per-symbol boolean (a live CONFIRMED entry whose symbols array contains it, exact match) plus the overall fraction.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbStatsInput = z.infer<typeof kbStatsSchema>;

interface BibleEntryShape {
  updated_at?: unknown;
}

// The bible-drift read needs the anchor folder to be a readable directory on
// THIS host; null (non-fatal -- kb_stats never throws over it, it just reports
// bible.present = false) when it is not, e.g. a remote member's folder.
function localDirOrNull(folder: string): string | null {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return null;
  return folder;
}

export async function kbStats(input: KbStatsInput, anchor?: KbAnchor): Promise<string> {
  // Stats describe the calling session's own KB (kb-self.ts). A remote
  // member's folder is carried verbatim even though this host cannot see it --
  // SqliteProvider.anchorIsMissing() then declines to produce a freshness
  // verdict rather than hashing against an unrelated tree.
  // A MEMBER session reports on its checkout bible view (kb-self.ts
  // getSelfReadKb): totals.by_confidence.CONFIRMED is the bible's CONFIRMED
  // count. kb_stats takes no tier filter, so a member always gets the view.
  const { providers, anchor: resolved } = await getSelfReadKb(anchor);
  const providerStats = await providers.project.stats({ symbols: input.symbols });

  // D5: bible.drift = count of live CONFIRMED entries whose updated_at
  // (promoted_at || created_at, matching kb_export's own field) is newer than
  // the bible's newest updated_at. Absent/unreadable/malformed file -> drift =
  // ALL live CONFIRMED entries, present = false. list({confidence:'CONFIRMED'})
  // already returns exactly the "live CONFIRMED" set (superseded_at IS NULL
  // AND stale = 0 are list()'s hardcoded defaults) without bumping use_count.
  //
  // my-beads-db-0cd.13: the SqliteProvider-only check sits OUTSIDE the
  // degraded-safe try block below, on purpose. Previously requireSqliteProject
  // sat INSIDE that try, so its throw over an HttpKbProvider project was
  // swallowed by the same catch that guards a merely-missing/malformed bible
  // file, and the tool returned the ambiguous { present: false, entries: 0,
  // drift: 0 } -- indistinguishable from an up-to-date bible. A remote
  // provider now gets its own distinguishable, non-throwing shape instead.
  //
  // my-beads-db-u00.3: kb_stats is the one SqliteProvider-only call site that
  // DEGRADES rather than failing fast, so it asks the type question with the
  // non-throwing isSqliteProject guard. Catching requireSqliteProject's throw
  // as a type test would also swallow any unrelated error on that path.
  let bible: BibleStats | { computable: false; reason: string };

  const project = providers.project;
  if (!isSqliteProject(project)) {
    bible = { computable: false, reason: 'bible drift is not computable over a remote HTTP provider' };
  } else {
    bible = { present: false, entries: 0, drift: 0, not_exportable: emptyNotExportable(), hash_drifted: { count: 0, ids: [], unhashed: 0 } };
    try {
      const liveConfirmed = await project.list({ confidence: ['CONFIRMED'] });
      const repoPath = localDirOrNull(resolved.folder);

      // Drift only counts entries that would pass the export basis predicate
      // (the same one kb_export / kb_bible_commit use): an entry that can never
      // qualify must not count as drift forever. Non-qualifying entries are
      // reported in not_exportable. When the folder is not a git work tree the
      // predicate cannot run; fall back to counting every live CONFIRMED entry.
      let driftCandidates = liveConfirmed;
      let notExportable = emptyNotExportable();
      if (repoPath) {
        try {
          const bases = project.getSourceFileBases(liveConfirmed.map(e => e.id));
          const { qualifying, rejected } = await partitionProjectBibleCandidates(liveConfirmed, bases, repoPath);
          driftCandidates = qualifying;
          for (const r of rejected) {
            const key = (r.reason === 'not_confirmed' ? 'basis_missing' : r.reason) as Exclude<BibleDisqualification, 'not_confirmed'>;
            notExportable.reasons[key]++;
            notExportable.count++;
          }
        } catch {
          // Not a git work tree / git unavailable: keep the all-entries fallback.
        }
      }
      const liveUpdatedAts = driftCandidates.map(e => e.promoted_at || e.created_at);
      // Degraded-safe fallback shared by every "can't use the bible file" path
      // below (absent, unreadable, malformed JSON, non-array shape): drift
      // equals ALL qualifying live CONFIRMED entries per D5, never lost to 0.
      bible = { present: false, entries: 0, drift: driftCandidates.length, not_exportable: notExportable, hash_drifted: { count: 0, ids: [], unhashed: 0 } };

      const biblePath = repoPath ? path.join(repoPath, '.fleet', 'kb-canonical.json') : null;

      if (biblePath && fs.existsSync(biblePath)) {
        try {
          const raw = fs.readFileSync(biblePath, 'utf-8');
          const parsed = JSON.parse(raw) as unknown;

          // KB-TRUST PHASE 3a: the bible has two shapes -- a legacy bare array and
          // the v2 { version, provenance, entries } envelope. Handle BOTH: reading
          // only the array shape would silently report present:false and a drift
          // of every live CONFIRMED entry against a perfectly good v2 bible, and
          // this block degrades quietly by design, so that would never be noticed.
          const entries = Array.isArray(parsed)
            ? parsed
            : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries))
              ? (parsed as { entries: unknown[] }).entries
              : null;

          if (entries !== null) {
            let newest: string | null = null;
            for (const entry of entries) {
              const updatedAt = (entry as BibleEntryShape)?.updated_at;
              if (typeof updatedAt === 'string' && (!newest || updatedAt > newest)) newest = updatedAt;
            }
            const drift = newest === null
              ? driftCandidates.length
              : liveUpdatedAts.filter(u => u > (newest as string)).length;
            // l0y9: bible-vs-code drift -- committed entries whose carried
            // hashes no longer match the cited files at HEAD.
            let hashDrifted: BibleHashDrifted = { count: 0, ids: [], unhashed: 0 };
            if (repoPath) {
              try {
                const r = await findHashDriftedBibleEntries(
                  entries.filter(e => e && typeof (e as { id?: unknown }).id === 'string') as { id: string; source_file_hashes?: Record<string, string> }[],
                  repoPath,
                );
                hashDrifted = { count: r.drifted.length, ids: r.drifted.slice(0, HASH_DRIFT_ID_CAP), unhashed: r.unhashed };
              } catch {
                // Not a git work tree: hash drift is not measurable, report 0.
              }
            }
            bible = { present: true, entries: entries.length, drift, not_exportable: notExportable, hash_drifted: hashDrifted };
          }
        } catch {
          // Malformed/unreadable bible file: leave the absent-shape fallback
          // (drift = all live CONFIRMED) set above.
        }
      }
    } catch {
      // Degraded-safe: kb_stats never throws over the bible file. Falls back to
      // the "absent, drift 0" shape initialized above (only reachable if the
      // list({confidence:'CONFIRMED'}) read itself failed).
    }
  }

  return JSON.stringify({ ...providerStats, bible });
}
