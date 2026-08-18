export type { CloudConfig } from './services/cloud/types.js';
import type { CloudConfig } from './services/cloud/types.js';

export type LlmProvider = 'claude' | 'gemini' | 'codex' | 'copilot' | 'agy' | 'opencode' | 'none';

export interface Agent {
  id: string;
  friendlyName: string;
  agentType: 'local' | 'remote' | 'relay';
  /** Hub-side member id this agent is addressed by over the relay (only
   *  set/used for agentType: 'relay' -- apra-fleet-jfn). Maps a local
   *  registry entry to the hub's member record, which relay-executor.ts's
   *  getAgentForMember (the reverse direction) and RelayStrategy (this
   *  direction) both key on. */
  relayMemberId?: string;
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
  gitAccess?: 'read' | 'push' | 'push+pr' | 'admin' | 'issues' | 'full';
  gitRepos?: string[];
  vcsProvider?: 'github' | 'bitbucket' | 'azure-devops';
  vcsTokenExpiresAt?: string;  // ISO 8601
  llmProvider?: LlmProvider;  // default: 'claude' for backwards compat
  modelCheap?: string;
  modelStandard?: string;
  modelPremium?: string;
  encryptedEnvVars?: Record<string, string>;  // envVarName -> encrypted value
  lastBranch?: string;
  tokenUsage?: { input: number; output: number };
  unattended?: false | 'auto' | 'dangerous';
  lastLlmActivityAt?: string;  // ISO 8601
  modelTiers?: { cheap?: string; standard?: string; premium?: string };
  category?: string;
  tags?: string[];
  codeIntelProvider?: 'codebase-memory' | 'gitnexus' | 'none';
  /** sprintId that currently reserves this member for exclusive dispatch, or
   *  null/absent when unreserved. Server-side reservation authority
   *  (apra-fleet-eft.10) -- closes the manual-CLI bypass around the
   *  service-local supervisor ledger. Set/enforced by later eft.10.x tasks;
   *  this field only introduces and persists the value. */
  reservedBy?: string | null;
  /** Whether this member's sshd permits SSH remote (reverse) port forwarding,
   *  i.e. whether openReverseTunnel (src/services/ssh.ts) can give it a
   *  reachable fleet MCP endpoint (rmkb-3n5.5.2). Probed ONCE, on the
   *  remote-member registration path, and read from here by the dispatch path
   *  -- dispatch must never re-probe. `false` means the sshd refused the
   *  forward (AllowTcpForwarding no) or was unreachable when probed, so
   *  dispatch degrades to the committed knowledge bible instead of failing.
   *  `undefined` means never probed: local members (never tunnelled), and
   *  cloud members registered while their instance was stopped. */
  sshTcpForwarding?: boolean;
  /** ISO 8601 timestamp of the sshTcpForwarding probe above, so a stale
   *  `false` can be re-probed deliberately (update_member) rather than
   *  implicitly per dispatch. */
  sshTcpForwardingProbedAt?: string;
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
