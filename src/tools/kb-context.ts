import { z } from 'zod';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbContextSchema = z.object({
  confidence: z.array(z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED'])).min(1).optional()
    .describe('Only consider cached file entries whose confidence tier is in this list. Default when omitted: ["CONFIRMED"] -- INFERRED and UNVERIFIED entries are considered only when listed explicitly.'),
  files: z.array(z.string()).min(1).describe('File paths to check freshness for'),
});

export type KbContextInput = z.infer<typeof kbContextSchema>;

export async function kbContext(input: KbContextInput, anchor?: KbAnchor): Promise<string> {
  validateFilePaths(input.files);

  const providers = await getSelfKbProviders(anchor);

  const confidence = input.confidence?.length ? input.confidence : (['CONFIRMED'] as NonNullable<KbContextInput['confidence']>);
  // Default-trusted read: CONFIRMED and undisputed unless a tier list is given.
  const excludeDisputed = !input.confidence?.length;
  let results = await providers.project.context(input.files, confidence, excludeDisputed);

  // Fallback to global if project has no results
  const hasFresh = results.some(r => r.status === 'fresh');
  if (!hasFresh) {
    const globalResults = await providers.global.context(input.files, confidence, excludeDisputed);
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
