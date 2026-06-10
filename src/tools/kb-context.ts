import { z } from 'zod';
import { getKBService } from '../services/knowledge/kb-service.js';

export const kbContextSchema = z.object({
  files: z.array(z.string()).min(1).describe('File paths to check freshness for'),
});

export type KbContextInput = z.infer<typeof kbContextSchema>;

export async function kbContext(input: KbContextInput): Promise<string> {
  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const results = await provider.context(input.files);

  const fresh = results.filter(r => r.status === 'fresh');
  const stale = results.filter(r => r.status === 'stale');
  const missing = results.filter(r => r.status === 'missing').map(r => r.file);

  return JSON.stringify({ fresh, stale, missing });
}
