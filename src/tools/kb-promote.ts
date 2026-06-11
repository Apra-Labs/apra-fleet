import { z } from 'zod';
import { getKBService } from '../services/knowledge/kb-service.js';

export const kbPromoteSchema = z.object({
  id: z.string().min(1).describe('ID of the KB entry to promote'),
  reason: z.string().optional().describe('Reason for promotion (appended to content as evidence trail)'),
});

export type KbPromoteInput = z.infer<typeof kbPromoteSchema>;

export async function kbPromote(input: KbPromoteInput): Promise<string> {
  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const result = await provider.promote(input.id, input.reason);
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
  });
}
