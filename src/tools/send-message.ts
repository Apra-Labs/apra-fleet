import crypto from 'node:crypto';
import { z } from 'zod';
import { sessionRegistry } from '../services/session-registry.js';
import { getTokenIssuer } from '../services/token-issuer.js';
import { logLine } from '../utils/log-helpers.js';

export const sendMessageSchema = z.object({
  member_id: z.string().describe('ID (UUID) of the target member session, or "orchestrator" for the operator\'s own channel-capable orchestrating session'),
  content: z.string().describe('Message content to send to the member'),
  reply_to: z.string().optional().describe('Optional message ID this is in reply to'),
  probe: z.boolean().optional().describe('When true, send nothing: only report whether a session holds member_id ({ probe: true, member_id, connected, channel_capable }). channel_capable is true only for a session that declared the claude/channel capability (for "orchestrator": a Claude Code session launched with --dangerously-load-development-channels), i.e. one that can actually receive a message. content is ignored.'),
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
  const { member_id, content, reply_to, probe } = input;
  const workspaceId = senderWorkspaceId ?? getTokenIssuer().workspaceId();

  // Read-only probe: the same workspace-scoped lookup a send makes, with no
  // notification and no status change. A session counts as able to receive
  // only when it is connected (has a live server) AND declared the
  // claude/channel capability -- a plain connect-back without it can never
  // receive notifications/claude/channel.
  if (probe) {
    const target = sessionRegistry.get(workspaceId, member_id);
    const connected = !!(target && target.server);
    const channelCapable = connected && !!target?.channelCapable;
    logLine('send_message', `probe member_id=${member_id} workspace_id=${workspaceId} connected=${connected} channel_capable=${channelCapable}`);
    return JSON.stringify({ probe: true, member_id, connected, channel_capable: channelCapable });
  }

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
