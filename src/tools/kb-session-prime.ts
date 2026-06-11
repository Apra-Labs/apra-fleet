import { z } from 'zod';
import { getKBService } from '../services/knowledge/kb-service.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbSessionPrimeSchema = z.object({
  session_files: z.array(z.string()).optional().describe('Files the agent expects to touch this session'),
  hint_symbols: z.array(z.string()).optional().describe('Symbols likely to be relevant'),
  hint_modules: z.array(z.string()).optional().describe('Module names likely to be relevant'),
});

export type KbSessionPrimeInput = z.infer<typeof kbSessionPrimeSchema>;

export async function kbSessionPrime(input: KbSessionPrimeInput): Promise<string> {
  if (input.session_files?.length) validateFilePaths(input.session_files);

  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const result = await provider.prime({
    session_files: input.session_files,
    hint_symbols: input.hint_symbols,
    hint_modules: input.hint_modules,
  });

  return JSON.stringify(result);
}
