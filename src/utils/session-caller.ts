import type { Agent } from '../types.js';
import { sessionRegistry, type SessionState } from '../services/session-registry.js';
import { getAgentOrFail } from './agent-helpers.js';

/**
 * Result of mapping an MCP session to a caller identity.
 *
 * `identity` is what credential scoping consumes:
 * - `*` -- stdio / fleet-operator (no sessionId at all)
 * - a member friendly name -- registered session whose agent is still in the registry
 * - `session:<id>` -- HTTP session that cannot be resolved to a live member
 *   (unknown sid, or the backing agent was removed). Never a raw member UUID.
 */
export interface SessionCaller {
  sessionId?: string;
  session?: SessionState;
  agent?: Agent;
  identity: string;
}

/**
 * Shared session -> caller identity lookup used by send_email (credential
 * scoping) and report_status (member identification).
 *
 * Fail-closed: only a caller with no sessionId gets the `*` operator scope.
 * An HTTP session that is not a registered member session, or whose agent
 * can no longer be resolved, gets a synthetic `session:<id>` identity so
 * member-scoped credentials are denied rather than silently bypassed.
 */
export function resolveSessionCaller(sessionId?: string): SessionCaller {
  if (!sessionId) return { identity: '*' };

  const session = sessionRegistry.findBySessionId(sessionId);
  if (!session) return { sessionId, identity: `session:${sessionId}` };

  const agent = getAgentOrFail(session.member_id);
  if (typeof agent === 'string') {
    return { sessionId, session, identity: `session:${sessionId}` };
  }
  return { sessionId, session, agent, identity: agent.friendlyName };
}
