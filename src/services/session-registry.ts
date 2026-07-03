import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type SessionStatus = 'online' | 'busy' | 'idle';

export interface SessionState {
  member_id: string;
  project_id: string;
  role: string;
  work_folder: string;
  server: McpServer | null;
  sessionId?: string;
  pid?: number;
  status: SessionStatus;
}

class SessionRegistry {
  private sessions = new Map<string, SessionState>();

  register(member_id: string, state: SessionState): void {
    this.sessions.set(member_id, state);
  }

  unregister(member_id: string): void {
    this.sessions.delete(member_id);
  }

  get(member_id: string): SessionState | undefined {
    return this.sessions.get(member_id);
  }

  list(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  setStatus(member_id: string, status: SessionStatus): void {
    const s = this.sessions.get(member_id);
    if (s) s.status = status;
  }

  setMcpServer(member_id: string, server: McpServer): void {
    const s = this.sessions.get(member_id);
    if (s) s.server = server;
  }

  setPid(member_id: string, pid: number): void {
    const s = this.sessions.get(member_id);
    if (s) s.pid = pid;
  }
}

export const sessionRegistry = new SessionRegistry();
