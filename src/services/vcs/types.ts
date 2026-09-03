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
  /**
   * apra-fleet-5co8.5.1: OPTIONAL, caller-supplied ISO 8601 expiry for `pat`
   * (the operator picks this when creating the PAT -- see skills/fleet/
   * auth-azdevops.md's "Set expiration" step -- Azure DevOps exposes no API
   * to query it back, so there is nothing for the fleet server to resolve on
   * its own). Deliberately distinct from credential-store TTL semantics
   * (services/credential-store.ts's `expiresAt`, which DELETES the entry on
   * a resolve past its TTL): this field only ever flows into deploy metadata
   * for the existing vcsTokenExpiresAt/checkVcsTokenExpiry/
   * scheduleCredentialCleanup plumbing to warn/cleanup, never to delete a
   * stored secret early. Absent -> no expiry propagated, no behavior change.
   */
  expires_at?: string;
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
  /**
   * apra-fleet-5co8.43: set true ONLY by testConnectivity() when the check
   * was not actually performed (e.g. no concrete repo URL could be derived
   * to ls-remote against). Machine-detectable so a caller cannot mistake a
   * skipped check for a verified credential merely because `success` is
   * true -- see src/tools/provision-vcs-auth.ts's Verification line, which
   * branches on this field rather than string-matching `message`. Absent
   * (undefined) for every deploy()/revoke() result and for a testConnectivity
   * result that actually ran the check (success or failure).
   */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Credential assembly / missing-credential descriptor (apra-fleet-5co8.3.1)
// ---------------------------------------------------------------------------

/**
 * The provider-agnostic view of a provision_vcs_auth payload that credential
 * assembly needs. Structural on purpose: `ProvisionVcsAuthInput` (the zod
 * inference in src/tools/provision-vcs-auth.ts) is assignable to it, so the
 * tool can hand its input straight to a provider WITHOUT this seam importing
 * the tool layer -- services must never depend on tools, and the zod schema
 * carries wire concerns (descriptions, member identifiers) that credential
 * assembly has no business seeing.
 */
export interface VcsCredentialInput {
  provider: VcsProvider;
  github_mode?: 'github-app' | 'pat';
  token?: string;
  git_access?: Agent['gitAccess'];
  repos?: string[];
  email?: string;
  api_token?: string;
  workspace?: string;
  org_url?: string;
  pat?: string;
  pat_expires_at?: string;
}

/**
 * Which input field a provider's credential lives in, and when it must be
 * collected out of band instead of read from the payload.
 *
 * This replaces the per-provider `if (input.provider === 'x' && ...)` blocks
 * in provision_vcs_auth: the tool asks the resolved provider whether its
 * credential is missing, prompts with the provider's own text, and writes the
 * collected secret back into the provider's own `field`. No provider name and
 * no auth-mode knowledge is left at the call site.
 */
export interface VcsMissingCredentialDescriptor {
  /** The `VcsCredentialInput` key an out-of-band collected secret fills. */
  field: 'token' | 'api_token' | 'pat';
  /** True when the credential is absent from the payload for THIS input --
   *  provider-specific, e.g. GitHub only needs one in `pat` mode, and Azure
   *  DevOps accepts either `pat` or `token`. */
  isMissing(input: VcsCredentialInput): boolean;
  /** The exact operator-facing prompt for the out-of-band collection. */
  promptFor(memberName: string): string;
}

// ---------------------------------------------------------------------------
// Provider service interface
// ---------------------------------------------------------------------------

export interface VcsProviderService {
  /**
   * Assemble this provider's credential object from a provision payload, or
   * return a plain error string naming the fields it requires (apra-fleet-
   * 5co8.3.1). Pure/deterministic: validation and shaping only -- never
   * network, filesystem or credential-store access, all of which happen
   * before (secure-token resolution) or after (deploy) this call.
   *
   * OPTIONAL only while providers are migrated onto the seam one at a time;
   * the tool keeps its own switch for a provider that has not implemented it.
   */
  buildCredentials?(input: VcsCredentialInput): unknown | string;

  /**
   * How this provider's credential is collected when the payload omits it.
   * OPTIONAL: a provider whose credential is always derived server-side (a
   * GitHub App minting flow) has nothing to prompt for.
   */
  missingCredential?: VcsMissingCredentialDescriptor;

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

  /**
   * Lightweight connectivity check (API call or git ls-remote).
   * `scopeUrl` (apra-fleet-5co8.5.2) is the same credential-scope URL passed to
   * deploy/revoke -- optional because most providers derive what they need
   * from `agent` alone; Azure DevOps uses it as a repo-derivation fallback
   * when `agent.gitRepos` does not already carry a usable clone URL.
   */
  testConnectivity(
    agent: Agent,
    exec: (cmd: string) => Promise<string>,
    scopeUrl?: string,
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

/** Provider-owned mapping from a create-pull-request response body to
 *  { id, url } (apra-fleet-lzfv.4). Mirrors the `pullRequestResponse`
 *  descriptor hook field-for-field from packages/apra-fleet-se/fleet-sprint/
 *  vcs-providers/index.mjs's REQUIRED EXPORT SHAPE, so the canonical
 *  server-side contract and the fleet-sprint provider registry never drift.
 *  `idField`/`webUrlField`/`webUrlTemplate` are the DECLARATION -- what a
 *  consumer mirroring this contract restates; the executable `map(body, ctx)`
 *  the JS descriptor also carries is deliberately NOT restated here (it must
 *  read the declared fields, not repeat them, per index.mjs's own contract
 *  comment) since this seam is not yet compiled against a JS caller.
 *  Both provider dialects: GitHub reads `number` off the body plus the
 *  browsable `html_url` it already carries (see ./github.mjs); Azure DevOps
 *  reads `pullRequestId` and has no web-URL field at all -- its browsable URL
 *  must be CONSTRUCTED from `webUrlTemplate` plus the request's own
 *  org/project/repo (see ./azure-devops.mjs). A mapping must never throw and
 *  must yield a null id/url rather than a guessed value when a field is
 *  unreadable, so a successful PR is never turned into a crash by its own
 *  reporting step. */
export interface VcsPullRequestResponseMapping {
  /** Body field carrying the PR identifier (GitHub: 'number', Azure DevOps: 'pullRequestId'). */
  idField: string;
  /** Body field carrying the browsable PR URL, or null when the body carries none (Azure DevOps). */
  webUrlField: string | null;
  /** Template to CONSTRUCT the browsable URL when webUrlField is null, or null when the URL is read straight from the body. */
  webUrlTemplate: string | null;
}

/** Provider-dispatched PR/VCS-action command builder. Pure/deterministic:
 *  no network I/O. Implementations must throw an Error whose message starts
 *  with the ASCII marker "ERROR:" for an unsupported provider or missing
 *  required fields, rather than silently producing a wrong command. */
export interface VcsPrCommandBuilder {
  buildCreatePrCommand(request: VcsCreatePrRequest): VcsCommandResult;
  buildCommentCommand(request: VcsCommentRequest): VcsCommandResult;
  /**
   * This provider's create-pull-request response dialect (apra-fleet-lzfv.4).
   * OPTIONAL, mirroring the JS descriptor's "response axis" hook -- a
   * classification-only provider, or one with no PR builder, declares none.
   */
  pullRequestResponse?: VcsPullRequestResponseMapping;
}
