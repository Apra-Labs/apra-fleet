import crypto from 'node:crypto';
import { z } from 'zod';
import { sessionRegistry } from '../services/session-registry.js';

export const sendMessageSchema = z.object({
  member_id: z.string().describe('ID of the target member session'),
  content: z.string().describe('Message content to send to the member'),
  reply_to: z.string().optional().describe('Optional message ID this is in reply to'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export async function sendMessage(input: SendMessageInput): Promise<string> {
  const { member_id, content, reply_to } = input;

  const session = sessionRegistry.get(member_id);
  if (!session || !session.sseRes) {
    return JSON.stringify({ error: 'member not connected or no SSE channel' });
  }

  const msgid = crypto.randomUUID();
  const event = JSON.stringify({ type: 'fleet:task', content, reply_to, from: 'pm', msgid });
  session.sseRes.write('event: message\ndata: ' + event + '\n\n');
  sessionRegistry.setStatus(member_id, 'busy');

  return JSON.stringify({ ok: true, msgid });
}
