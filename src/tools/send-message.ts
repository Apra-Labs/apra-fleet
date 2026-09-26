import crypto from 'node:crypto';
import { z } from 'zod';
import { sessionRegistry } from '../services/session-registry.js';
import { getTokenIssuer } from '../services/token-issuer.js';
import { logLine } from '../utils/log-helpers.js';

export const sendMessageSchema = z.object({
  member_id: z.string().describe('ID (UUID) of the target member session'),
  content: z.string().describe('Message content to send to the member'),
  reply_to: z.string().optional().describe('Optional message ID this is in reply to'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Send a message to a connected member session.
 *
 * Workspace enforcement: the target session must belong to the SENDER's
 * workspace. The sender here is the local orchestrator (PM/tool path), whose
 * workspace comes from the active token issuer; a hub-era caller passes its
 * own verified workspace_id via senderWorkspaceId. A member connected under a
 * different workspace is indistinguishable from "not connected" -- lookup is
 * scoped, so cross-workspace sends cannot happen and existence is not leaked.
 */
export async function sendMessage(input: SendMessageInput, senderWorkspaceId?: string): Promise<string> {
  const { member_id, content, reply_to } = input;
  const workspaceId = senderWorkspaceId ?? getTokenIssuer().workspaceId();

  const registeredKeys = sessionRegistry.list(workspaceId).map(s => s.member_id);
  logLine('send_message', `lookup member_id=${member_id} workspace_id=${workspaceId} registry_keys=[${registeredKeys.join(',')}]`);

  const session = sessionRegistry.get(workspaceId, member_id);
  if (!session) {
    logLine('send_message', `member_id=${member_id} not found in workspace ${workspaceId}`);
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

  sessionRegistry.setStatus(workspaceId, member_id, 'busy');

  return JSON.stringify({ ok: true, msgid });
}
