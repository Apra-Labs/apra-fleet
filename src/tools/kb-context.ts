import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbContextSchema = z.object({
  files: z.array(z.string()).min(1).describe('File paths to check freshness for'),
});

export type KbContextInput = z.infer<typeof kbContextSchema>;

export async function kbContext(input: KbContextInput): Promise<string> {
  validateFilePaths(input.files);

  const providers = await getKbProviders();

  let results = await providers.project.context(input.files);

  // Fallback to global if project has no results
  const hasFresh = results.some(r => r.status === 'fresh');
  if (!hasFresh) {
    const globalResults = await providers.global.context(input.files);
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
