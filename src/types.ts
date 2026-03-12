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
  workFolder: string;
  sessionId?: string;
  os?: 'windows' | 'macos' | 'linux';
  createdAt: string;
  lastUsed?: string;
  icon?: string;
  gitAccess?: 'read' | 'push' | 'admin' | 'issues' | 'full';
  gitRepos?: string[];
}

export interface GitHubAppConfig {
  appId: string;
  privateKeyPath: string;
  installationId: number;
  createdAt: string;
}

export interface FleetGitConfig {
  version: string;
  github?: GitHubAppConfig;
}

export interface TransferResult {
  success: string[];
  failed: { path: string; error: string }[];
}

export interface FleetRegistry {
  version: string;
  agents: Agent[];
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
