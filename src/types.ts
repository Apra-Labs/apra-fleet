export interface Agent {
  id: string;
  friendlyName: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key';
  encryptedPassword?: string;
  keyPath?: string;
  remoteFolder: string;
  sessionId?: string;
  os?: 'windows' | 'macos' | 'linux';
  scpAvailable?: boolean;
  createdAt: string;
  lastUsed?: string;
}

export interface FleetRegistry {
  version: string;
  agents: Agent[];
  fleetToken?: string;
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
