export type { CloudConfig } from './services/cloud/types.js';
import type { CloudConfig } from './services/cloud/types.js';

export type LlmProvider = 'claude' | 'gemini' | 'codex' | 'copilot';

export interface Agent {
  id: string;
  friendlyName: string;
  agentType: 'local' | 'remote';
  cloud?: CloudConfig;
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
  vcsProvider?: 'github' | 'bitbucket' | 'azure-devops';
  vcsTokenExpiresAt?: string;  // ISO 8601
  llmProvider?: LlmProvider;  // default: 'claude' for backwards compat
  encryptedEnvVars?: Record<string, string>;  // envVarName -> encrypted value
  lastBranch?: string;
  tokenUsage?: { input: number; output: number };
  activePid?: number;
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

export interface OnboardingState {
  bannerShown: boolean;
  firstMemberRegistered: boolean;
  firstPromptExecuted: boolean;
  multiMemberNudgeShown: boolean;
}
