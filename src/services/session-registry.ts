export type SessionStatus = 'online' | 'busy' | 'idle';

export interface SessionState {
  member_id: string;
  project_id: string;
  role: string;
  work_folder: string;
  sseRes: any | null;
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

  setSseResponse(member_id: string, sseRes: any): void {
    const s = this.sessions.get(member_id);
    if (s) s.sseRes = sseRes;
  }
}

export const sessionRegistry = new SessionRegistry();
