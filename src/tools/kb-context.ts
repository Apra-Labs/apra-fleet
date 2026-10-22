import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfReadKb, getMemberSplitRead, type KbAnchor, type MemberSplitRead } from '../services/knowledge/kb-self.js';
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

  // MEMBER session whose tier list (explicit, or the default above) names
  // CONFIRMED plus another tier: the split read (kb-self.ts
  // getMemberSplitRead). The checkout bible's CONFIRMED entries are merged per
  // file (best status wins) with the member's OWN captures from the per-repo
  // DB, so the other tiers never expose another member's captures and never
  // hide the bible's. This is also the MEMBER default read.
  const split = await getMemberSplitRead(anchor, confidence, 'kb_context');
  if (split) return JSON.stringify(partition(await splitContext(split, input.files, explicit, confidence, excludeDisputed)));

  // Everything else (kb-self.ts getSelfReadKb): a MEMBER CONFIRMED-only
  // request reads the checkout bible view; a MEMBER request naming only
  // INFERRED/UNVERIFIED goes to the per-repo DB, own captures only (ownerTag).
  const read = await getSelfReadKb(anchor, explicit);
  const { providers } = read;
  let results: FileResult[];
  if (read.ownerTag !== undefined) {
    results = await requireSqliteProject(providers.project, 'kb_context').context(input.files, confidence, excludeDisputed, read.ownerTag);
  } else {
    results = await providers.project.context(input.files, confidence, excludeDisputed);
  }

  // Fallback to global if project has no results
  if (!results.some(r => r.status === 'fresh')) {
    const globalResults = await providers.global.context(input.files, confidence, excludeDisputed, read.ownerTag);
    if (globalResults.some(r => r.status === 'fresh')) results = globalResults;
  }

  return JSON.stringify(partition(results));
}

async function splitContext(
  split: MemberSplitRead,
  files: string[],
  explicit: Tier[] | undefined,
  confidence: Tier[],
  excludeDisputed: boolean,
): Promise<FileResult[]> {
  const { ownerTag } = split.own;
  // An explicit list answers its non-CONFIRMED tiers from the member's own
  // captures. The default read has always asked the own half for its whole
  // tier set (CONFIRMED + INFERRED, owner-tagged), so a cache entry the member
  // promoted in the per-repo DB still counts; that is kept unchanged.
  const ownTiers = explicit === undefined ? confidence : split.own.tiers;
  const fromBible = await split.bible.project.context(files, split.bible.tiers, excludeDisputed);
  const fromOwn = await split.own.project.context(files, ownTiers, excludeDisputed, ownerTag);
  let results = mergeByFile(fromBible, fromOwn);

  // Fallback to global if project has no results. The global KB is
  // machine-wide, so its non-CONFIRMED tiers are not the member's own: the
  // default read keeps the fallback CONFIRMED-only; an explicit list adds the
  // member's own global captures for the other tiers.
  if (!results.some(r => r.status === 'fresh')) {
    let globalResults = await split.bible.global.context(files, split.bible.tiers, excludeDisputed);
    if (explicit !== undefined) {
      globalResults = mergeByFile(
        globalResults,
        await split.own.global.context(files, split.own.tiers, excludeDisputed, ownerTag),
      );
    }
    if (globalResults.some(r => r.status === 'fresh')) results = globalResults;
  }
  return results;
}

function partition(results: FileResult[]): { fresh: FileResult[]; stale: FileResult[]; missing: string[] } {
  const fresh = results.filter(r => r.status === 'fresh');
  const stale = results.filter(r => r.status === 'stale');
  const missing = results.filter(r => r.status === 'missing').map(r => r.file);

  return { fresh, stale, missing };
}
