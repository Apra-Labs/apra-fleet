import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

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
  repo: z.string().optional()
    .describe('Path to the repo root for the canonical-bible drift check (.fleet/kb-canonical.json). Precedence: this explicit input, when given and valid, wins; otherwise falls back to the validated session working directory (same validation as kb_export/kb_session_prime); if neither validates, bible.present is reported false and drift equals the full live-CONFIRMED count -- kb_stats never fails because of this.'),
  symbols: z.array(z.string()).optional()
    .describe('Symbols to check coverage for: per-symbol boolean (a live CONFIRMED entry whose symbols array contains it, exact match) plus the overall fraction.'),
});

export type KbStatsInput = z.infer<typeof kbStatsSchema>;

interface BibleEntryShape {
  updated_at?: unknown;
}

// F4 (T1.6) precedence pattern, reused here: explicit input > validated
// process.cwd() > null (non-fatal -- kb_stats never throws over a bad repo
// path, it just reports bible.present = false).
function resolveRepoPath(explicit?: string): string | null {
  const candidate = explicit || process.cwd();
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return null;
  return candidate;
}

export async function kbStats(input: KbStatsInput): Promise<string> {
  const providers = await getKbProviders();
  const providerStats = await providers.project.stats({ symbols: input.symbols });

  // D5: bible.drift = count of live CONFIRMED entries whose updated_at
  // (promoted_at || created_at, matching kb_export's own field) is newer than
  // the bible's newest updated_at. Absent/unreadable/malformed file -> drift =
  // ALL live CONFIRMED entries, present = false. list({confidence:'CONFIRMED'})
  // already returns exactly the "live CONFIRMED" set (superseded_at IS NULL
  // AND stale = 0 are list()'s hardcoded defaults) without bumping use_count.
  let bible = { present: false, entries: 0, drift: 0 };
  try {
    const liveConfirmed = await providers.project.list({ confidence: 'CONFIRMED' });
    const liveUpdatedAts = liveConfirmed.map(e => e.promoted_at || e.created_at);
    // Degraded-safe fallback shared by every "can't use the bible file" path
    // below (absent, unreadable, malformed JSON, non-array shape): drift
    // equals ALL live CONFIRMED entries per D5, never silently lost to 0.
    bible = { present: false, entries: 0, drift: liveConfirmed.length };

    const repoPath = resolveRepoPath(input.repo);
    const biblePath = repoPath ? path.join(repoPath, '.fleet', 'kb-canonical.json') : null;

    if (biblePath && fs.existsSync(biblePath)) {
      try {
        const raw = fs.readFileSync(biblePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;

        if (Array.isArray(parsed)) {
          let newest: string | null = null;
          for (const entry of parsed) {
            const updatedAt = (entry as BibleEntryShape)?.updated_at;
            if (typeof updatedAt === 'string' && (!newest || updatedAt > newest)) newest = updatedAt;
          }
          const drift = newest === null
            ? liveConfirmed.length
            : liveUpdatedAts.filter(u => u > (newest as string)).length;
          bible = { present: true, entries: parsed.length, drift };
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

  return JSON.stringify({ ...providerStats, bible });
}
