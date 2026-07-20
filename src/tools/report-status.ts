import { z } from 'zod';
import { sessionRegistry } from '../services/session-registry.js';
import { fleetEvents } from '../services/event-bus.js';
import { logLine } from '../utils/log-helpers.js';

/**
 * Status lifecycle + response/ack path (apra-fleet-2xs.7).
 *
 * send_message flips a member to 'busy' and, until now, nothing ever flipped
 * it back -- there was no response/ack path from the member back to the PM.
 * This tool closes that loop: a connected member's OWN interactive session
 * calls it (via its MCP connection to this server, the same connection
 * send_message pushed the original notification over) to report it has
 * finished responding.
 *
 * Tier-2-local only (docs/hub-spoke-wire-protocol.md section 4 explicitly
 * reserves the `presence.member_status` envelope name for the hub-era
 * equivalent but does not spec its body, since this was unimplemented at
 * that document's time of writing) -- this is the local state machine that
 * future hub relay will eventually carry upward, not the hub relay itself.
 */
export const reportStatusSchema = z.object({
  status: z.enum(['online', 'idle']).default('online').describe(
    'Status to report. "online" (default) means available for new work; "idle" means the member is still connected but not actively engaged.'
  ),
});

export type ReportStatusInput = z.infer<typeof reportStatusSchema>;

/**
 * Identifies the calling member via the MCP session it's already connected
 * on (extra.sessionId, populated by the SDK's StreamableHTTPServerTransport)
 * -- there is no member_id parameter, because a member reporting its own
 * status has no business asserting an identity other than its own session's.
 */
export async function reportStatus(input: ReportStatusInput, extra?: any): Promise<string> {
  const sessionId = extra?.sessionId;
  if (!sessionId) {
    return 'error: report_status must be called from a connected interactive session (no session ID on this call).';
  }

  const session = sessionRegistry.findBySessionId(sessionId);
  if (!session) {
    return 'error: no registered member session found for this connection.';
  }

  sessionRegistry.setStatus(session.workspace_id, session.member_id, input.status);
  logLine('report_status', `member_id=${session.member_id} workspace_id=${session.workspace_id} status=${input.status}`);
  fleetEvents.emit('member:status-changed', { memberId: session.member_id, status: input.status });

  return JSON.stringify({ ok: true, member_id: session.member_id, status: input.status });
}
