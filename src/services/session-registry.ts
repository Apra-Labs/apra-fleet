import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type SessionStatus = 'online' | 'busy' | 'idle';

export interface SessionState {
  member_id: string;
  /** HARD security boundary -- every session belongs to exactly one workspace.
   *  All lookups are scoped by it (see docs/hub-spoke-master-plan.md section 3). */
  workspace_id: string;
  role: string;
  work_folder: string;
  server: McpServer | null;
  sessionId?: string;
  pid?: number;
  status: SessionStatus;
  /** Optional grouping label inside a workspace; zero security weight. */
  project_id?: string;
}

/**
 * Session registry keyed on the (workspace_id, member_id) composite.
 * A member_id can never be addressed across a workspace boundary: every
 * accessor requires the caller's workspace_id.
 */
class SessionRegistry {
  private sessions = new Map<string, SessionState>();

  // apra-fleet-eft.50.1: durable per-member record of the last launch-time
  // claude pid ever seen for a member, surviving the SessionState churn
  // (disconnect -> unregister -> reconnect -> re-register) that a persistent
  // interactive member goes through across dispatch retries. The live
  // SessionState can be re-registered with pid=undefined on a connect-back
  // whose priorPid lookup found no entry (the entry was already unregistered),
  // which used to leave the execute_prompt interactive liveness check
  // (eft.28.1) and its in-flight poll with NO pid to test -- so a dead
  // launch-time process on a RETRY (attempt 2+) reused the broken channel and
  // hung silently for the full timeout_s instead of being detected and
  // re-dispatched. This map is the liveness fallback of last resort: it is
  // NEVER cleared on unregister (that churn is exactly what it outlives) and is
  // only overwritten when a newer pid is registered for the same member.
  private lastPids = new Map<string, number>();

  private key(workspace_id: string, member_id: string): string {
    // '::' cannot appear in either component (workspace ids are hex-derived,
    // member ids are UUIDs or [a-zA-Z0-9._-] names), so this is unambiguous.
    return workspace_id + '::' + member_id;
  }

  register(state: SessionState): void {
    this.sessions.set(this.key(state.workspace_id, state.member_id), state);
    if (state.pid !== undefined) {
      this.lastPids.set(this.key(state.workspace_id, state.member_id), state.pid);
    }
  }

  unregister(workspace_id: string, member_id: string): void {
    this.sessions.delete(this.key(workspace_id, member_id));
  }

  /** Workspace-scoped lookup: returns undefined for a member connected in a
   *  DIFFERENT workspace, indistinguishable from "not connected". */
  get(workspace_id: string, member_id: string): SessionState | undefined {
    return this.sessions.get(this.key(workspace_id, member_id));
  }

  /** List sessions in one workspace. Omitting workspace_id returns ALL
   *  sessions -- for local diagnostics only, never for routing decisions. */
  list(workspace_id?: string): SessionState[] {
    const all = Array.from(this.sessions.values());
    if (workspace_id === undefined) return all;
    return all.filter(s => s.workspace_id === workspace_id);
  }

  setStatus(workspace_id: string, member_id: string, status: SessionStatus): void {
    const s = this.get(workspace_id, member_id);
    if (s) s.status = status;
  }

  setMcpServer(workspace_id: string, member_id: string, server: McpServer): void {
    const s = this.get(workspace_id, member_id);
    if (s) s.server = server;
  }

  setPid(workspace_id: string, member_id: string, pid: number): void {
    const s = this.get(workspace_id, member_id);
    if (s) s.pid = pid;
    // Keep the durable launch-pid anchor in step so it can back-stop a later
    // reconnect that loses the live SessionState pid (apra-fleet-eft.50.1).
    this.lastPids.set(this.key(workspace_id, member_id), pid);
  }

  /**
   * The last launch-time claude pid seen for a member, independent of whether
   * a live SessionState currently exists or still carries a pid
   * (apra-fleet-eft.50.1). Used ONLY as a liveness fallback by the
   * execute_prompt interactive dead-session guard and http-transport's
   * connect-back carry-forward, so a dead persistent process is still
   * detectable on a dispatch retry that reuses a reconnected session. Returns
   * undefined for a member that never had a pid captured (e.g. a provider that
   * never went through register_member's local spawn, or a pure test session)
   * -- those keep the pre-existing behavior unchanged.
   */
  lastKnownPid(workspace_id: string, member_id: string): number | undefined {
    return this.lastPids.get(this.key(workspace_id, member_id));
  }

  /** Finds the session owning a given MCP transport sessionId. Used by tools a
   *  connected member calls on ITS OWN session (e.g. report_status), where the
   *  caller has no member_id/workspace_id to pass explicitly -- only the MCP
   *  session it's already talking on. Diagnostics-tier linear scan, same
   *  tradeoff as list() with no workspace filter. */
  findBySessionId(sessionId: string): SessionState | undefined {
    return Array.from(this.sessions.values()).find(s => s.sessionId === sessionId);
  }
}

export const sessionRegistry = new SessionRegistry();
