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

// ---------------------------------------------------------------------------
// PR-command-build seam (apra-fleet-tfx.7)
// ---------------------------------------------------------------------------
//
// The orchestrator-side VCSModule (packages/apra-fleet-se/fleet-sprint/
// vcs-module.mjs) extends this seam rather than inventing a parallel one: it
// is provider-dispatched exactly like VcsProviderService above, but its job
// is different -- given an already-minted token, deterministically BUILD a
// command string for the member to run via execute_command (never run one
// itself, never touch the network). fleet-se is a plain-JS ESM package that
// does not compile/import this .ts seam directly; these types are the
// canonical contract VCSModule's JS mirrors, kept here so the shape has one
// source of truth alongside VcsProviderService instead of drifting.

/** Fields needed to build a "raise a PR" REST call. */
export interface VcsCreatePrRequest {
  /** "owner/name" (e.g. "Apra-Labs/apra-fleet"). */
  repo: string;
  /** Branch the PR merges INTO (e.g. "main"). */
  base: string;
  /** Branch containing the changes; must already be pushed. */
  head: string;
  title: string;
  body?: string;
  /** Already-minted credential (e.g. a GitHub App installation token). */
  token: string;
}

/** Fields needed to build a "comment on an existing PR/issue" REST call
 *  (used to annotate a PR that was already raised, e.g. on sprint abort). */
export interface VcsCommentRequest {
  repo: string;
  issue_number: number;
  body: string;
  token: string;
}

/** A fully-built, ready-to-dispatch command plus the metadata needed to
 *  interpret its output. `command` carries the real credential and must only
 *  ever be handed to execute_command; `logSafeCommand` has the credential
 *  redacted and is the only form that may appear in logs. */
export interface VcsCommandResult {
  provider: VcsProvider;
  action: 'create-pull-request' | 'comment';
  command: string;
  logSafeCommand: string;
  interpret: {
    successStatusRange: [number, number];
    alreadyExistsStatus?: number;
    alreadyExistsPattern?: string;
  };
}

/** Provider-dispatched PR/VCS-action command builder. Pure/deterministic:
 *  no network I/O. Implementations must throw an Error whose message starts
 *  with the ASCII marker "ERROR:" for an unsupported provider or missing
 *  required fields, rather than silently producing a wrong command. */
export interface VcsPrCommandBuilder {
  buildCreatePrCommand(request: VcsCreatePrRequest): VcsCommandResult;
  buildCommentCommand(request: VcsCommentRequest): VcsCommandResult;
}
