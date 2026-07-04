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

  private key(workspace_id: string, member_id: string): string {
    // '::' cannot appear in either component (workspace ids are hex-derived,
    // member ids are UUIDs or [a-zA-Z0-9._-] names), so this is unambiguous.
    return workspace_id + '::' + member_id;
  }

  register(state: SessionState): void {
    this.sessions.set(this.key(state.workspace_id, state.member_id), state);
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
