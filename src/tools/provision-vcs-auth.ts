import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell, touchAgent, checkVcsTokenExpiry } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getAgent } from '../services/registry.js';
import { getVcsCredentials, listVcsCredentials, recordVcsCredential } from '../services/vcs-credential-record.js';
import { revokeVcsCredential, describeLegacyGlobalKey } from '../services/vcs-credential-revoke.js';
import type { VcsCredentialRevokeResult } from '../services/vcs-credential-revoke.js';
import { vcsGitEnvPrefix } from '../services/vcs-git-env.js';
import { isSafeGitCredentialScope } from '../os/os-commands.js';
import { credentialResolve } from '../services/credential-store.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { githubProvider } from '../services/vcs/github.js';
import { mapAccessLevel } from '../services/github-app.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import { scheduleCredentialCleanup, cancelCredentialCleanup } from '../services/credential-cleanup.js';
import { PROVIDER_HOSTS } from '../services/vcs/constants.js';
import { logLine, logWarn } from '../utils/log-helpers.js';
import { redactKnownSecrets } from '../utils/redact-known-secrets.js';
import { findSecretTokens, legacyTokenWarning } from '../services/secret-token.js';
import type { Agent } from '../types.js';
import type { VcsProviderService, VcsDeployResult } from '../services/vcs/types.js';

/**
 * The three distinct {{secret.NAME}} resolution failures. Previously all three
 * collapsed into one emoji-prefixed prose string, so a caller could not tell
 * "no such credential" from "this member may not use it" from "it expired"
 * without matching the wording (apra-fleet-3swo.7.2).
 */
type SecretFieldFailure = 'secret_variable_not_found' | 'secret_variable_denied' | 'secret_variable_expired';

function resolveSecretField(value: string, callingMember: string): { resolved: string; legacyNames: string[] } | { error: string; code: SecretFieldFailure } {
  const tokens = findSecretTokens(value);
  const tokenNames = new Set(tokens.map((t) => t.name));
  const legacyNames = tokens.filter((t) => t.legacy).map((t) => t.name);
  let resolved = value;
  for (const name of tokenNames) {
    const entry = credentialResolve(name, callingMember);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.`, code: 'secret_variable_not_found' };
    if ('denied' in entry) return { error: entry.denied, code: 'secret_variable_denied' };
    if ('expired' in entry) return { error: entry.expired, code: 'secret_variable_expired' };
    resolved = resolved.replaceAll(`{{secret.${name}}}`, entry.plaintext);
    resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext); // legacy spelling
  }
  return { resolved, legacyNames };
}

/** What each GitHub App git_access level lets a member do, in plain words (grants: mapAccessLevel). */
export const GIT_ACCESS_ACTIONS = {
  read: 'clone and fetch only',
  push: 'clone and push, including workflow files; cannot create pull requests or dispatch workflows',
  'push+pr': 'clone, push, create pull requests, dispatch workflows and re-run CI jobs',
  admin: 'clone, push, change repository settings, dispatch workflows and re-run CI jobs; cannot create pull requests',
  issues: 'manage issues and discussions and create pull requests from existing branches; cannot clone private code, push or dispatch workflows',
  full: 'clone, push, create pull requests, dispatch workflows, re-run CI jobs, manage issues and discussions, and change repository settings',
} as const;

/** The GitHub permissions a level requests, read from mapAccessLevel so the text cannot drift from it. */
export function gitAccessGrants(level: string): string {
  const permissions = Object.entries(mapAccessLevel(level));
  const named = (value: string) => permissions.filter(([, v]) => v === value).map(([name]) => name).join(', ');
  return [`write: ${named('write')}`, `read: ${named('read')}`].filter((part) => !part.endsWith(': ')).join('; ');
}

const GIT_ACCESS_DESCRIPTION =
  'GitHub App mode only (ignored for a GitHub PAT, Bitbucket and Azure DevOps, whose token grants what it was created with). ' +
  "The level the minted token gets, overriding the member's configured one. Pick push+pr to create pull requests or dispatch workflows. Levels: " +
  Object.entries(GIT_ACCESS_ACTIONS).map(([level, actions]) => `${level} (${gitAccessGrants(level)}): ${actions}.`).join(' ') +
  ' The GitHub App itself must hold these permissions, or minting fails.';

const providers: Record<string, VcsProviderService> = {
  'github': githubProvider,
  'bitbucket': bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

/**
 * Every key a built-in provider's deploy() metadata may legitimately carry,
 * measured against src/services/vcs/{github,bitbucket,azure-devops}.ts:
 * github ('mode', 'access', 'repos', 'token', 'expiresAt', 'permissions',
 * 'ghCliAuth'), bitbucket ('workspace', 'email'), azure-devops ('org',
 * 'expiresAt'). An allowlist (rather than a value-pattern redactor) was
 * chosen because this set is small and stable and an allowlist fails closed
 * on a key it has never seen, where a redactor only catches patterns it
 * recognises (apra-fleet-3swo.59). `token` is included because every
 * provider that emits it already masks it to 4 chars + asterisks before
 * returning -- this allowlist governs which KEYS may pass through, not
 * whether a given value is itself safe to display.
 */
const PROVIDER_METADATA_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'mode', 'access', 'repos', 'token', 'expiresAt', 'permissions', 'ghCliAuth',
  'workspace', 'email', 'org',
]);

/**
 * The single enforcement point for provider deploy() metadata reaching a
 * caller-visible channel (apra-fleet-3swo.59). Both structuredContent.metadata
 * and the rendered text call this -- there is deliberately no second,
 * independently-maintained copy of the key list. A key not on
 * PROVIDER_METADATA_KEY_ALLOWLIST is dropped outright (never passed through
 * as-is and never replaced with a redaction placeholder), so a future
 * fourth provider or an edited existing provider cannot silently publish a
 * new metadata key -- including a raw secret -- through this path just by
 * adding it to the object it returns.
 */
function filterProviderMetadata(metadata: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!metadata) return null;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (PROVIDER_METADATA_KEY_ALLOWLIST.has(key)) filtered[key] = value;
  }
  return filtered;
}

export const provisionVcsAuthSchema = z.object({
  ...memberIdentifier,
  provider: z.enum(['github', 'bitbucket', 'azure-devops']).describe('VCS provider to configure'),
  label: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe('Credential label (slug, e.g. "work-github"). Defaults to provider name. Enables multiple credentials per provider.'),
  non_interactive: z.boolean().optional().describe('When true, never prompt out of band: a missing secret field (api_token / pat / token) returns ok=false with reason credential_missing naming the field. Use from automation that has no operator at a terminal. Default false.'),
  scope_url: z.string().optional().describe('Git credential scope URL (e.g. "https://github.com/my-org"). Defaults to "https://<host>". For an Azure DevOps repo on the legacy host, pass "https://ORG.visualstudio.com" so the PAT is bound to the host the member actually pushes to. Must be a plain scheme://host[:port][/path] URL (no quotes, spaces, dollar signs, equals signs, query, fragment or backslashes).'),

  // GitHub fields
  github_mode: z.enum(['github-app', 'pat']).optional().describe('GitHub auth mode: github-app (mint via configured app) or pat (personal access token)'),
  token: z.string().optional().describe('Personal access token (GitHub PAT or Azure DevOps PAT). Supports {{secret.NAME}} token -- value is resolved from the credential store before use.'),
  git_access: z.enum(['read', 'push', 'push+pr', 'admin', 'issues', 'full']).optional().describe(GIT_ACCESS_DESCRIPTION),
  repos: z.array(z.string()).optional().describe('GitHub App repository list override'),
  gh_login: z.boolean().optional().describe('GitHub only: also log the gh CLI in with the new token. gh keeps ONE login per OS user, so this replaces the token every other process of that user runs gh with (the operator sessions on a local member, other members on the same host user). Default: only for label "github" on a remote member that no other registered member shares; skipped otherwise, and metadata.ghCliAuth says why. true: always log gh in (refresh the host gh on purpose). false: never. Git and vcs_credential_exec use the per-member, per-label credential either way.'),

  // Bitbucket fields
  email: z.string().optional().describe('OPTIONAL Bitbucket account email. Ignored for authentication (git uses the fixed token username x-bitbucket-api-token-auth, REST uses a Bearer token); kept only as metadata if given.'),
  api_token: z.string().optional().describe('Bitbucket API token (required for bitbucket). Store it as the fleet secret bitbucket_api_token and pass {{secret.bitbucket_api_token}} -- the value is resolved from the credential store before use.'),
  workspace: z.string().optional().describe('Bitbucket workspace slug (required for bitbucket). Verification GETs the member origin repository in this workspace over REST, then runs git ls-remote against the origin.'),

  // Azure DevOps fields
  org_url: z.string().optional().describe('Azure DevOps organization URL (e.g. https://dev.azure.com/myorg, or the legacy https://myorg.visualstudio.com)'),
  pat: z.string().optional().describe('Azure DevOps personal access token. Supports {{secret.NAME}} token -- value is resolved from the credential store before use.'),
  // apra-fleet-5co8.5.1: OPTIONAL, caller-supplied -- Azure DevOps exposes no
  // API to query a PAT's expiry back, so this must come from the operator
  // (the date they picked in the "Set expiration" step when creating the
  // PAT; see skills/fleet/auth-azdevops.md). Deliberately NOT the
  // credential-store's own TTL (credential_store_set ttl_seconds): that
  // mechanism DELETES the stored secret on a resolve past its TTL, which is
  // why e.g. the fleet-e2e-ado store entry is set up with no store-side TTL
  // at all -- conflating the two would silently start deleting a credential
  // whose PAT is merely nearing expiry, not gone. This field only ever flows
  // into deploy metadata to warn/cleanup, never to delete a stored secret.
  // A malformed value here is NOT harmless: it is truthy, so it reaches
  // vcsTokenExpiresAt verbatim and makes every checkVcsTokenExpiry comparison
  // NaN, silencing the day-scale expiry warning entirely (scheduleCredentialCleanup
  // itself now treats an unparseable expiresAt the same as an absent one --
  // it skips scheduling rather than falling back to any default TTL -- so
  // the risk here is the silenced warning, not an auto-revoke). Rejected at
  // the schema boundary so no caller can construct that state.
  pat_expires_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'pat_expires_at must be a parseable date/time (ISO 8601, e.g. 2027-08-20T00:00:00Z)',
  }).optional().describe('ISO 8601 date/time the Azure DevOps PAT expires, as chosen when creating the token. Propagated to the member registry so provisioning can warn when the PAT is nearing expiry.'),
});

export type ProvisionVcsAuthInput = z.infer<typeof provisionVcsAuthSchema>;

/**
 * Machine-readable reason code for every outcome provision_vcs_auth previously
 * expressed only as prose (apra-fleet-3swo.7.2). Callers branch on
 * `structuredContent.reason`, never on the human summary in `text`.
 */
export type ProvisionVcsAuthReason =
  /** Credentials deployed and connectivity verified. */
  | 'ok'
  /** Deployed, but the connectivity check failed. ok=true -- the credential IS on the member. */
  | 'deployed_unverified'
  /** Deployed, but the connectivity check was not performed (no concrete repo URL). ok=true. */
  | 'deployed_verification_skipped'
  /** No member matched member_id/member_name. */
  | 'member_not_found'
  /** The member is unreachable. */
  | 'member_offline'
  /** A {{secret.NAME}} token names no stored credential. */
  | 'secret_variable_not_found'
  /** A {{secret.NAME}} token resolved to a credential this member may not use. */
  | 'secret_variable_denied'
  /** A {{secret.NAME}} token resolved to an expired credential. */
  | 'secret_variable_expired'
  /** Out-of-band credential collection was cancelled or returned nothing. */
  | 'oob_cancelled'
  /** non_interactive was set and the secret field is absent; nothing was prompted. */
  | 'credential_missing'
  /** The resolved provider implements no buildCredentials hook (a wiring bug). */
  | 'credential_assembly_unsupported'
  /** The provider rejected the supplied fields (e.g. a required field is absent). */
  | 'credential_assembly_failed'
  /** service.deploy() threw. */
  | 'deploy_threw'
  /** service.deploy() returned success:false. */
  | 'deploy_failed'
  /** scope_url is not a plain scheme://host[:port][/path] URL; nothing was deployed. */
  | 'scope_url_invalid';

interface ProvisionVcsAuthFields {
  /** True when the credential was actually deployed onto the member. */
  ok: boolean;
  /** Machine-readable outcome code. Branch on this, never on `text`. */
  reason: ProvisionVcsAuthReason;
  /** The VCS provider requested ('github' | 'bitbucket' | 'azure-devops'). */
  provider: string;
  /** Credential label the helper was deployed under (defaults to the provider name). */
  credentialLabel: string;
  /** Git credential scope URL the helper was registered for, or null pre-resolution. */
  scopeUrl: string | null;
  /**
   * Token expiry as an ISO timestamp, or null meaning "no expiry tracked ->
   * OK" -- the same reading checkVcsTokenExpiry already applies server-side.
   */
  expiresAt: string | null;
  /** True only when testConnectivity() actually ran AND succeeded. */
  verified: boolean;
  /** True when testConnectivity() reported it did not perform the check. */
  verificationSkipped: boolean;
  /**
   * The provider's machine-readable verification cause when it reports one
   * (Bitbucket: 'ok', 'rest_unauthorized', 'rest_failed', 'git_auth_failed',
   * 'git_failed'), naming which channel failed; null when the provider
   * reports none or no check ran.
   */
  verificationReason: string | null;
  /**
   * The provider's own deploy metadata, filtered through
   * filterProviderMetadata()'s PROVIDER_METADATA_KEY_ALLOWLIST before it
   * reaches this field (the same filter also gates the rendered `text`).
   * Providers additionally mask the token value itself to its first four
   * characters plus asterisks (see src/services/vcs/github.ts), so this
   * payload never carries the plaintext token -- but the guarantee that no
   * OTHER unexpected key (e.g. a future provider's raw secret) reaches this
   * field now comes from that enforced allowlist, not from provider
   * convention alone.
   */
  metadata: Record<string, string> | null;
  /** Near-expiry warning text when one applies, else null. */
  expiryWarning: string | null;
  /**
   * Upgrade migration of a LEGACY helper this label held (an older release
   * registered it in the per-OS-user global git config), or null when there
   * was none. Only fleet's own values are ever removed from the global key.
   */
  legacyGlobalHelper: LegacyGlobalHelperOutcome | null;
  /** Registry id of the resolved member, or null. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null. */
  memberName: string | null;
  /**
   * The human-readable cause of a non-ok outcome (e.g. "No repos specified
   * and none on agent config.", "Member \"x\" is offline: ..."), or null for
   * an ok result. Previously this text only ever reached the caller inside
   * `text`, so a structured-content-only caller saw nothing but the bare
   * `reason` code (e.g. 'deploy_failed') and lost the actual cause. Derived
   * from the same text rendered into `text`, after the known credential
   * values in play (raw, URL-encoded, base64 user:token, quote-escaped) and
   * any Authorization header value have been replaced with **** by
   * redactKnownSecrets(). Provider/OS error text is NOT otherwise sanitized,
   * which is why every result goes through that redaction.
   */
  message: string | null;
}

export interface LegacyGlobalHelperOutcome {
  /** The credential scope whose global key `credential.<scopeUrl>.helper` was looked at. */
  scopeUrl: string;
  /**
   * "removed": fleet's legacy value was removed from the global key.
   * "not_present": the key held no fleet value; nothing was changed.
   * "kept_for_member": left in place because another member runs as the same
   *   host user (keptForMember names it); fleet no longer refreshes it.
   * "failed": the cleanup failed or its result could not be confirmed;
   *   check the key (the notice says how).
   */
  outcome: 'removed' | 'not_present' | 'kept_for_member' | 'failed';
  /** Fleet's own values removed from the key. */
  removedValues: number;
  /** Values on the key fleet did not write (counted, never echoed); always kept. */
  keptValues: number;
  /** Friendly name of the member the legacy helper was kept for, else null. */
  keptForMember: string | null;
  /** The upgrade notice line also shown in `text`, or null when there is nothing to say. */
  notice: string | null;
}

function legacyGlobalHelperOutcome(scopeUrl: string, r: VcsCredentialRevokeResult): LegacyGlobalHelperOutcome {
  const notice = describeLegacyGlobalKey(r) || null;
  if (r.legacyLeftForSharer) {
    return { scopeUrl, outcome: 'kept_for_member', removedValues: 0, keptValues: 0, keptForMember: r.legacyLeftForSharer.friendlyName, notice };
  }
  const rep = r.legacyGlobalKey?.report ?? null;
  if (!rep || rep.failed) return { scopeUrl, outcome: 'failed', removedValues: 0, keptValues: 0, keptForMember: null, notice };
  return { scopeUrl, outcome: rep.removed > 0 ? 'removed' : 'not_present', removedValues: rep.removed, keptValues: rep.kept, keptForMember: null, notice };
}

export interface ProvisionVcsAuthStructured extends ProvisionVcsAuthFields {
  [key: string]: unknown;
}

export interface ProvisionVcsAuthResult {
  text: string;
  structuredContent: ProvisionVcsAuthStructured;
}

const VCS_OK_REASONS: ProvisionVcsAuthReason[] = ['ok', 'deployed_unverified', 'deployed_verification_skipped'];

/**
 * `text` is always a human-readable summary prefixed with a `[TAG]` marker
 * (`[FAIL]`, `[WARN]`, `[OK]`, `[SKIP]`) -- see every vcsResult() call site
 * below. Stripping the marker yields the plain cause string, which is the
 * same text already used to build `text` itself, so this introduces no new
 * information (and no new secret exposure) beyond what already rendered.
 */
function stripResultMarker(text: string): string {
  return text.replace(/^\[[A-Z]+\]\s*/, '');
}

export async function provisionVcsAuth(input: ProvisionVcsAuthInput): Promise<ProvisionVcsAuthResult> {
  const label = input.label ?? input.provider;
  // Secret values in play (resolved token/api_token/pat, OOB-collected value).
  // Every result built below is redacted against this list so a provider or OS
  // error that echoes the credential never reaches `text`, `message` or a log.
  const knownSecrets: string[] = [];
  const knownUsernames = ['x-bitbucket-api-token-auth', 'x-access-token', 'git', 'oauth2'];
  if (input.email) knownUsernames.push(input.email);
  const redact = (t: string): string => redactKnownSecrets(t, knownSecrets, knownUsernames);
  const vcsResult = (
    rawText: string,
    fields: Partial<ProvisionVcsAuthFields> & { reason: ProvisionVcsAuthReason },
  ): ProvisionVcsAuthResult => {
    const text = redact(rawText);
    const ok = fields.ok ?? VCS_OK_REASONS.includes(fields.reason);
    return {
      text,
      structuredContent: {
        ok,
        reason: fields.reason,
        provider: input.provider,
        credentialLabel: label,
        scopeUrl: fields.scopeUrl ?? null,
        expiresAt: fields.expiresAt ?? null,
        verified: fields.verified ?? false,
        verificationSkipped: fields.verificationSkipped ?? false,
        verificationReason: fields.verificationReason ?? null,
        metadata: fields.metadata ?? null,
        expiryWarning: fields.expiryWarning ?? null,
        legacyGlobalHelper: fields.legacyGlobalHelper ?? null,
        memberId: fields.memberId ?? null,
        memberName: fields.memberName ?? null,
        message: fields.message != null ? redact(fields.message) : (ok ? null : stripResultMarker(text)),
      },
    };
  };

  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') {
    return vcsResult(agentOrError, {
      reason: 'member_not_found',
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
    });
  }
  const agent = agentOrError as Agent;
  const who = { memberId: agent.id, memberName: agent.friendlyName };

  const service = providers[input.provider];

  // Resolve {{secret.NAME}} / legacy {{secure.NAME}} tokens in credential fields
  const resolvedInput = { ...input };
  const legacyNames: string[] = [];
  for (const field of ['token', 'api_token', 'pat'] as const) {
    if (resolvedInput[field]) {
      const r = resolveSecretField(resolvedInput[field]!, agent.friendlyName);
      if ('error' in r) return vcsResult(`[FAIL] ${r.error}`, { ...who, reason: r.code });
      resolvedInput[field] = r.resolved;
      if (r.resolved) knownSecrets.push(r.resolved);
      legacyNames.push(...r.legacyNames);
    }
  }
  if (legacyNames.length > 0) {
    logWarn('provision_vcs_auth', legacyTokenWarning(legacyNames), agent);
  }

  // OOB fallback for an absent credential field, dispatched through the
  // resolved provider (apra-fleet-5co8.3.2). The provider owns which field its
  // secret lives in, when it counts as missing and what the operator is asked
  // -- no provider name and no auth-mode knowledge is left at this call site.
  // Order is unchanged: {{secret.NAME}} resolution first, then OOB collection
  // (an OOB-collected secret is deliberately NOT re-run through
  // resolveSecretField), then credential assembly.
  //
  // Every required NON-secret field is validated first, so a call that would
  // fail credential assembly anyway never prompts the operator for a secret.
  const nonSecretError = service.validateNonSecretFields?.(resolvedInput) ?? null;
  if (nonSecretError) {
    return vcsResult(`[FAIL] ${nonSecretError}`, { ...who, reason: 'credential_assembly_failed' });
  }
  const missing = service.missingCredential;
  if (missing && missing.isMissing(resolvedInput)) {
    if (input.non_interactive) {
      return vcsResult(
        `[FAIL] The "${missing.field}" field is missing and non_interactive is set, so it was not prompted for. Pass it (e.g. as {{secret.NAME}}).`,
        { ...who, reason: 'credential_missing' },
      );
    }
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_vcs_auth', {
      prompt: missing.promptFor(agent.friendlyName),
    });
    if ('fallback' in oob) {
      return vcsResult(oob.fallback ?? 'Error: OOB operation cancelled.', { ...who, reason: 'oob_cancelled' });
    }
    resolvedInput[missing.field] = decryptPassword(oob.password!);
    knownSecrets.push(resolvedInput[missing.field] as string);
  }

  // buildCredentials is still optional on VcsProviderService while the seam is
  // being adopted; every provider registered above implements it, so an absent
  // implementation is a wiring bug, reported rather than silently deploying
  // undefined credentials.
  const assemblyUnsupported = !service.buildCredentials;
  const creds = service.buildCredentials
    ? service.buildCredentials(resolvedInput)
    : `Provider "${input.provider}" does not support credential assembly.`;
  if (typeof creds === 'string') {
    return vcsResult(`[FAIL] ${creds}`, {
      ...who,
      reason: assemblyUnsupported ? 'credential_assembly_unsupported' : 'credential_assembly_failed',
    });
  }

  const host = PROVIDER_HOSTS[input.provider];
  const scopeUrl = input.scope_url ?? `https://${host}`;
  // The scope URL is registered for git through the member's dispatch
  // environment (src/services/vcs-git-env.ts), where it must survive several
  // quoting layers unescaped -- refuse anything but a plain URL up front.
  if (!isSafeGitCredentialScope(scopeUrl)) {
    return vcsResult(
      `[FAIL] scope_url "${scopeUrl}" is not a plain scheme://host[:port][/path] URL (no quotes, spaces, '$', '=', '?', '#' or backslashes). Nothing was deployed.`,
      { ...who, reason: 'scope_url_invalid' },
    );
  }

  // Cancel the cleanup timer of THIS label only: every other label this
  // member holds keeps its own timer (src/services/credential-cleanup.ts).
  cancelCredentialCleanup(agent.id, label);

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return vcsResult(`[FAIL] Member "${agent.friendlyName}" is offline: ${conn.error}`,
      { ...who, reason: 'member_offline', scopeUrl });
  }

  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const exec = async (cmd: string): Promise<string> => {
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) throw new Error(result.stderr);
    return result.stdout;
  };

  // Legacy migration: remove the pre-label, single-file credential helper
  // (`.fleet-git-credential`, no label suffix) left by installs predating
  // labeled credentials.
  //
  // This used to call gitCredentialHelperRemove(host) with NO label, which
  // additionally ran `git config --global --unset-all
  // credential.https://<host>.helper`. That was actively destructive, and
  // scoping the call to `label` would NOT have fixed it: the credential-helper
  // config key is HOST/SCOPE-scoped, not label-scoped (the same fact PR #473
  // turned on), so every variant of that call unsets the registration for
  // whatever credential is currently live on that host. Because this ran
  // unconditionally BEFORE the deploy, any failure in between -- a dropped
  // connection, a GitHub App mint error, a racing second provision for the
  // same member -- left the member with its credential FILE present and fresh
  // but NO git-config registration, which is exactly the state observed
  // repeatedly on fleet-lin-dev1 on 2026-09-11 (git and `bd dolt push` both
  // failing with "could not read Username" while the token on disk was still
  // valid for the better part of an hour).
  //
  // Dropping the config half costs nothing: helpers are no longer registered
  // in any git config file at all (src/services/vcs-git-env.ts). The FILE
  // removal is kept so a pre-label install does not keep an orphaned,
  // still-valid token on disk -- the security wart PR #473 called out.
  try {
    await exec(cmds.gitCredentialHelperRemoveLegacyFile());
  } catch { /* best-effort */ }

  // What this label held before this provision (read fresh: a concurrent
  // provision of another label must not be lost). Provisioning a NEW label
  // never touches another label's credential -- a member can hold several
  // labels at once (src/services/vcs-credential-record.ts).
  const previous = getVcsCredentials(getAgent(agent.id) ?? agent)[label];
  // A pre-label (unlabeled) entry: recording this label replaces it in the
  // record, so its global key is migrated below like a labeled legacy one.
  const unlabeled = listVcsCredentials(getAgent(agent.id) ?? agent).find(e => e.label === undefined);

  let deployResult;
  try {
    deployResult = await service.deploy(agent, cmds, exec, creds, label, scopeUrl);
  } catch (err: any) {
    return vcsResult(`[FAIL] Failed to deploy ${input.provider} credentials on "${agent.friendlyName}": ${err.message}`,
      { ...who, reason: 'deploy_threw', scopeUrl });
  }

  if (!deployResult.success) {
    return vcsResult(`[FAIL] ${deployResult.message}`, { ...who, reason: 'deploy_failed', scopeUrl });
  }

  // Persist VCS provider, token expiry, and the exact label/scopeUrl this
  // deploy used, so a later cleanup timer (credential-cleanup.ts) revokes the
  // SAME credential-helper file/config-key pair, not an unlabeled/default-host
  // guess that could clobber a different, still-valid credential.
  // The record is per label: every other label this member holds is kept.
  // memberScoped: the helper is this member's own file, registered for git
  // through the dispatch environment rather than any git config file.
  const expiresAt = deployResult.metadata?.expiresAt;
  const fresh = recordVcsCredential(agent.id, label, {
    provider: input.provider,
    scopeUrl,
    ...(expiresAt ? { expiresAt } : {}),
    memberScoped: true,
  }) ?? agent;

  // Migration of a LEGACY entry this label held (a release that wrote the
  // shared per-OS-user file and the global git config key): only now, after
  // the new helper is in place and recorded, so a failure above never leaves
  // the member with no working registration (the 2026-09-11 failure mode).
  // revokeVcsCredential removes the legacy file and global key only when no
  // other member runs as the same user on the same host -- it is shared by
  // all of them. legacyOnly: the per-member file of this label is the one
  // the deploy above just wrote, so it must never be removed here. A previous
  // member-scoped entry needs nothing: the same file was just overwritten and
  // its registration comes from the record.
  // The outcome is reported loudly (text + legacyGlobalHelper): a removed
  // global value changes what git OUTSIDE fleet dispatches authenticates with.
  let legacyGlobalHelper: LegacyGlobalHelperOutcome | null = null;
  const legacyEntry = previous && !previous.memberScoped
    ? { label, provider: previous.provider, scopeUrl: previous.scopeUrl }
    : unlabeled;
  if (legacyEntry) {
    const legacyScope = legacyEntry.scopeUrl ?? `https://${PROVIDER_HOSTS[legacyEntry.provider]}`;
    try {
      const r = await revokeVcsCredential(agent, legacyEntry, cmds, exec, { legacyOnly: true });
      legacyGlobalHelper = legacyGlobalHelperOutcome(legacyScope, r);
    } catch (err: any) {
      legacyGlobalHelper = {
        scopeUrl: legacyScope, outcome: 'failed', removedValues: 0, keptValues: 0, keptForMember: null,
        notice: `[WARN] Upgrade: the cleanup of fleet's legacy global git credential helper for ${legacyScope} failed (${err?.message ?? err}); the global git config was left as it was.`,
      };
    }
  }

  // Schedule auto-cleanup of this label when its token expires
  scheduleCredentialCleanup(agent.id, label, expiresAt);

  // Best-effort connectivity test
  let connectivity: VcsDeployResult;
  // git in the connectivity check finds the new helper the same way every
  // dispatch does: through the member's git credential environment.
  const gitEnv = vcsGitEnvPrefix(fresh, cmds);
  const execWithGitEnv = (cmd: string) => exec(gitEnv + cmd);
  try {
    connectivity = await service.testConnectivity(agent, execWithGitEnv, scopeUrl, creds);
  } catch {
    connectivity = { success: false, message: 'connectivity test threw' };
  }

  touchAgent(agent.id);
  logLine('provision_vcs_auth', `provider=${input.provider}`, agent);

  const filteredMetadata = filterProviderMetadata(deployResult.metadata);
  const meta = filteredMetadata
    ? Object.entries(filteredMetadata).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : '';

  // Check if the just-deployed token is already near expiry. `agent` was
  // resolved before the updateAgent() call above, so its own vcsProvider may
  // still be stale/absent (e.g. a member's first-ever azure-devops
  // provision) -- pass input.provider explicitly rather than relying on
  // `agent.vcsProvider` reflecting the write that just happened.
  const expiryWarning = deployResult.metadata?.expiresAt
    ? checkVcsTokenExpiry({ ...agent, vcsProvider: input.provider, vcsTokenExpiresAt: deployResult.metadata.expiresAt })
    : null;

  // apra-fleet-5co8.43: a skipped connectivity check must never read as a
  // verified credential just because `success` is also true on that result
  // -- branch on the machine-detectable `skipped` field (never string-match
  // `message`), kept generic here (no provider special-casing) since
  // `skipped` lives on the shared VcsDeployResult contract every provider's
  // testConnectivity() returns.
  const verificationLine = connectivity.skipped
    ? `[SKIP] Skipped: ${connectivity.message}`
    : connectivity.success
      ? connectivity.message
      : `[WARN] ${connectivity.message}`;

  // The credential IS deployed on all three branches below -- ok stays true
  // and `reason` distinguishes verified / unverified / not-checked, which is
  // exactly the distinction apra-fleet-5co8.43 established must never be
  // inferred from the message text.
  const reason: ProvisionVcsAuthReason = connectivity.skipped
    ? 'deployed_verification_skipped'
    : connectivity.success
      ? 'ok'
      : 'deployed_unverified';

  return vcsResult(
    `[OK] ${deployResult.message} on "${agent.friendlyName}"\n`
    + (meta ? meta + '\n' : '')
    + `  Verification: ${verificationLine}`
    + (expiryWarning ? `\n  ${expiryWarning}` : '')
    + (legacyNames.length > 0 ? `\n${legacyTokenWarning(legacyNames)}` : '')
    + (legacyGlobalHelper?.notice ? `\n  ${legacyGlobalHelper.notice}` : ''),
    {
      ...who,
      reason,
      scopeUrl,
      legacyGlobalHelper,
      expiresAt: deployResult.metadata?.expiresAt ?? null,
      verified: !connectivity.skipped && connectivity.success === true,
      verificationSkipped: connectivity.skipped === true,
      verificationReason: connectivity.skipped ? null : (connectivity.reason ?? null),
      metadata: filteredMetadata,
      expiryWarning: expiryWarning ?? null,
    },
  );
}
