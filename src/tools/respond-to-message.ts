import { z } from 'zod';
import { resolvePending } from '../services/pending-responses.js';

/**
 * A connected member's response to a prompt delivered via execute_prompt's
 * interactive routing path (apra-fleet-2xs.8) or a plain send_message push.
 * `reply_to` is the `msgid` the member received in the original
 * notification's meta -- see docs/cloud-fleet-architecture.md section 6,
 * step 7 ("Claude calls send_message(type=response, ..., reply_to=...)").
 */
export const respondToMessageSchema = z.object({
  reply_to: z.string().describe('The msgid from the notification this is responding to'),
  content: z.string().describe('The response content'),
});

export type RespondToMessageInput = z.infer<typeof respondToMessageSchema>;

export async function respondToMessage(input: RespondToMessageInput): Promise<string> {
  const delivered = resolvePending(input.reply_to, input.content);
  if (!delivered) {
    return JSON.stringify({
      error: 'no pending execute_prompt call is waiting for this reply_to (it may have already timed out, already been answered, or the id is invalid)',
    });
  }
  return JSON.stringify({ ok: true });
}
