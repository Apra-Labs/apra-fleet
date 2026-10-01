import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getSelfReadKb, type KbAnchor } from '../services/knowledge/kb-self.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';

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
  let bible: { present: boolean; entries: number; drift: number } | { computable: false; reason: string };

  const project = providers.project;
  if (!isSqliteProject(project)) {
    bible = { computable: false, reason: 'bible drift is not computable over a remote HTTP provider' };
  } else {
    bible = { present: false, entries: 0, drift: 0 };
    try {
      const liveConfirmed = await project.list({ confidence: ['CONFIRMED'] });
      const liveUpdatedAts = liveConfirmed.map(e => e.promoted_at || e.created_at);
      // Degraded-safe fallback shared by every "can't use the bible file" path
      // below (absent, unreadable, malformed JSON, non-array shape): drift
      // equals ALL live CONFIRMED entries per D5, never silently lost to 0.
      bible = { present: false, entries: 0, drift: liveConfirmed.length };

      const repoPath = localDirOrNull(resolved.folder);
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
              ? liveConfirmed.length
              : liveUpdatedAts.filter(u => u > (newest as string)).length;
            bible = { present: true, entries: entries.length, drift };
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
