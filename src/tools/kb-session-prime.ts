import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbSessionPrimeSchema = z.object({
  session_files: z.array(z.string()).optional().describe('Files the agent expects to touch this session'),
  hint_symbols: z.array(z.string()).optional().describe('Symbols likely to be relevant'),
  hint_modules: z.array(z.string()).optional().describe('Module names likely to be relevant'),
});

export type KbSessionPrimeInput = z.infer<typeof kbSessionPrimeSchema>;

export async function kbSessionPrime(input: KbSessionPrimeInput): Promise<string> {
  if (input.session_files?.length) validateFilePaths(input.session_files);

  const providers = await getKbProviders();

  const result = await providers.project.prime({
    session_files: input.session_files,
    hint_symbols: input.hint_symbols,
    hint_modules: input.hint_modules,
  });

  // Append up to 3 global knowledge entries
  const searchTerm = input.session_files?.join(' ') ?? input.hint_symbols?.join(' ') ?? '';
  if (searchTerm) {
    try {
      const globalResult = await providers.global.query({
        query: searchTerm,
        l1_only: true,
        limit: 10,
        include_stale: false,
      });
      const globalEntries = globalResult.results
        .filter(e => e.type === 'knowledge')
        .slice(0, 3);
      if (globalEntries.length > 0) {
        result.top_entries = [...(result.top_entries ?? []), ...globalEntries];
      }
    } catch {}
  }

  return JSON.stringify(result);
}
