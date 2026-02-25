export interface Agent {
  id: string;
  friendlyName: string;
  agentType: 'local' | 'remote';
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key';
  encryptedPassword?: string;
  keyPath?: string;
  remoteFolder: string;
  sessionId?: string;
  os?: 'windows' | 'macos' | 'linux';
  scpAvailable?: boolean;
  createdAt: string;
  lastUsed?: string;
}

export interface TransferResult {
  success: string[];
  failed: { path: string; error: string }[];
}

export interface FleetRegistry {
  version: string;
  agents: Agent[];
  fleetToken?: string;              // Legacy plaintext (migrated on read)
  encryptedFleetToken?: string;     // Encrypted fleet token
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
