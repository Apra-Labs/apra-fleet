/**
 * VCS provider types and service interface for multi-provider credential management.
 *
 * Supports GitHub (App + PAT), Bitbucket (API token), and Azure DevOps (PAT).
 * Each agent supports a single VCS provider at a time.
 */

import type { Agent } from '../../types.js';
import type { OsCommands } from '../../os/os-commands.js';

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

export type VcsProvider = 'github' | 'bitbucket' | 'azure-devops';

// ---------------------------------------------------------------------------
// Credential discriminated unions
// ---------------------------------------------------------------------------

export interface GitHubAppCredentials {
  type: 'github-app';
  git_access?: Agent['gitAccess'];
  repos?: string[];
}

export interface GitHubPatCredentials {
  type: 'pat';
  token: string;
}

export type GitHubCredentials = GitHubAppCredentials | GitHubPatCredentials;

export interface BitbucketCredentials {
  email: string;
  api_token: string;
  workspace: string;
}

export interface AzureDevOpsCredentials {
  org_url: string;
  pat: string;
}

export type VcsCredentials =
  | { provider: 'github'; credentials: GitHubCredentials }
  | { provider: 'bitbucket'; credentials: BitbucketCredentials }
  | { provider: 'azure-devops'; credentials: AzureDevOpsCredentials };

// ---------------------------------------------------------------------------
// Deploy result
// ---------------------------------------------------------------------------

export interface VcsDeployResult {
  success: boolean;
  message: string;
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Provider service interface
// ---------------------------------------------------------------------------

export interface VcsProviderService {
  /** Deploy credentials to the agent's filesystem and configure git credential helper. */
  deploy(
    agent: Agent,
    cmds: OsCommands,
    exec: (cmd: string) => Promise<string>,
    credentials: unknown,
    label?: string,
    scopeUrl?: string,
  ): Promise<VcsDeployResult>;

  /** Remove deployed credentials and git config from the agent. */
  revoke(
    agent: Agent,
    cmds: OsCommands,
    exec: (cmd: string) => Promise<string>,
    label?: string,
    scopeUrl?: string,
  ): Promise<VcsDeployResult>;

  /** Lightweight connectivity check (API call or git ls-remote). */
  testConnectivity(
    agent: Agent,
    exec: (cmd: string) => Promise<string>,
  ): Promise<VcsDeployResult>;
}
