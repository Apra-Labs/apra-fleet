import crypto from 'node:crypto';
import { z } from 'zod';
import { sessionRegistry } from '../services/session-registry.js';
import { logLine } from '../utils/log-helpers.js';

export const sendMessageSchema = z.object({
  member_id: z.string().describe('ID of the target member session'),
  content: z.string().describe('Message content to send to the member'),
  reply_to: z.string().optional().describe('Optional message ID this is in reply to'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export async function sendMessage(input: SendMessageInput): Promise<string> {
  const { member_id, content, reply_to } = input;

  const registeredKeys = sessionRegistry.list().map(s => s.member_id);
  logLine('send_message', `lookup member_id=${member_id} registry_keys=[${registeredKeys.join(',')}]`);

  const session = sessionRegistry.get(member_id);
  if (!session) {
    logLine('send_message', `member_id=${member_id} not found in registry`);
    return JSON.stringify({ error: 'member not connected or no MCP session' });
  }
  if (!session.server) {
    logLine('send_message', `member_id=${member_id} found but server=null (not yet connected)`);
    return JSON.stringify({ error: 'member not connected or no MCP session' });
  }

  const msgid = crypto.randomUUID();

  await (session.server as any).server.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: { from: 'pm', msgid, ...(reply_to ? { reply_to } : {}) },
    },
  });

  sessionRegistry.setStatus(member_id, 'busy');

  return JSON.stringify({ ok: true, msgid });
}
