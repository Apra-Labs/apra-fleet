import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfReadKb, type KbAnchor } from '../services/knowledge/kb-self.js';
import type { KbProviders } from '../services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbContextSchema = z.object({
  confidence: z.array(z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED'])).min(1).optional()
    .describe('Only consider cached file entries whose confidence tier is in this list. Default when omitted: ["CONFIRMED","INFERRED"], undisputed entries only -- a context-cache entry is verified by its content hash, and captures are stored at most INFERRED, so a CONFIRMED-only default would report almost every file missing. UNVERIFIED entries are considered only when listed explicitly.'),
  files: z.array(z.string()).min(1).describe('File paths to check freshness for'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbContextInput = z.infer<typeof kbContextSchema>;
type Tier = NonNullable<KbContextInput['confidence']>[number];
type FileResult = Awaited<ReturnType<KbProviders['project']['context']>>[number];

/**
 * kb_context's default tier set when the caller names none: CONFIRMED and
 * INFERRED, undisputed only. Unlike kb_query/kb_list (whose default is
 * CONFIRMED-only, because their entries are claims a reader acts on), kb_context
 * only answers "is my cached summary of this file still current?", and that is
 * decided mechanically by the entry's content hash against the file on disk.
 * kb_capture stores at most INFERRED and context-cache entries are rarely
 * promoted, so a CONFIRMED-only default reported almost every file missing.
 * UNVERIFIED (harvest output) stays opt-in.
 */
export const KB_CONTEXT_DEFAULT_CONFIDENCE: readonly Tier[] = Object.freeze(['CONFIRMED', 'INFERRED']);

const STATUS_RANK: Record<FileResult['status'], number> = { fresh: 2, stale: 1, missing: 0 };

/** Per file, the best of two result sets (fresh > stale > missing; first wins a tie). */
function mergeByFile(primary: FileResult[], secondary: FileResult[]): FileResult[] {
  const byFile = new Map(secondary.map(r => [r.file, r]));
  return primary.map((r) => {
    const other = byFile.get(r.file);
    return other && STATUS_RANK[other.status] > STATUS_RANK[r.status] ? other : r;
  });
}

export async function kbContext(input: KbContextInput, anchor?: KbAnchor): Promise<string> {
  validateFilePaths(input.files);

  const explicit = input.confidence?.length ? input.confidence : undefined;
  const confidence = (explicit ?? [...KB_CONTEXT_DEFAULT_CONFIDENCE]) as Tier[];
  // Default-trusted read: undisputed unless a tier list is given.
  const excludeDisputed = explicit === undefined;

  // MEMBER session -> the checkout bible view (kb-self.ts getSelfReadKb) for
  // the CONFIRMED tier; an INFERRED/UNVERIFIED request goes to the per-repo DB,
  // own captures only (ownerTag).
  const read = await getSelfReadKb(anchor, explicit);
  const { providers } = read;
  let results: FileResult[];
  if (explicit === undefined && read.memberView) {
    // MEMBER default: the checkout bible's CONFIRMED entries merged with the
    // member's OWN CONFIRMED/INFERRED captures from the per-repo DB, so the
    // INFERRED half of the default never exposes another member's captures and
    // never hides the bible's.
    const own = await getSelfReadKb(anchor, confidence);
    const fromBible = await providers.project.context(input.files, ['CONFIRMED'], excludeDisputed);
    const fromOwn = await requireSqliteProject(own.providers.project, 'kb_context')
      .context(input.files, confidence, excludeDisputed, own.ownerTag);
    results = mergeByFile(fromBible, fromOwn);
  } else if (read.ownerTag !== undefined) {
    results = await requireSqliteProject(providers.project, 'kb_context').context(input.files, confidence, excludeDisputed, read.ownerTag);
  } else {
    results = await providers.project.context(input.files, confidence, excludeDisputed);
  }

  // Fallback to global if project has no results
  const hasFresh = results.some(r => r.status === 'fresh');
  if (!hasFresh) {
    // A MEMBER default read keeps the global fallback CONFIRMED-only: the global
    // KB is machine-wide, so its INFERRED tier is not the member's own.
    const globalTiers = explicit === undefined && read.memberView ? (['CONFIRMED'] as Tier[]) : confidence;
    const globalResults = await providers.global.context(input.files, globalTiers, excludeDisputed, read.ownerTag);
    const hasFreshGlobal = globalResults.some(r => r.status === 'fresh');
    if (hasFreshGlobal) {
      results = globalResults;
    }
  }

  const fresh = results.filter(r => r.status === 'fresh');
  const stale = results.filter(r => r.status === 'stale');
  const missing = results.filter(r => r.status === 'missing').map(r => r.file);

  return JSON.stringify({ fresh, stale, missing });
}
