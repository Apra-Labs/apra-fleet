import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell, touchAgent, checkVcsTokenExpiry } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { updateAgent } from '../services/registry.js';
import { credentialResolve } from '../services/credential-store.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import { scheduleCredentialCleanup, cancelCredentialCleanup } from '../services/credential-cleanup.js';
import { PROVIDER_HOSTS } from '../services/vcs/constants.js';
import { logLine } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;

/**
 * The three distinct {{secure.NAME}} resolution failures. Previously all three
 * collapsed into one emoji-prefixed prose string, so a caller could not tell
 * "no such credential" from "this member may not use it" from "it expired"
 * without matching the wording (apra-fleet-3swo.7.2).
 */
type SecureFieldFailure = 'secure_credential_not_found' | 'secure_credential_denied' | 'secure_credential_expired';

function resolveSecureField(value: string, callingMember: string): { resolved: string } | { error: string; code: SecureFieldFailure } {
  const tokenNames = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(value)) !== null) tokenNames.add(match[1]);
  let resolved = value;
  for (const name of tokenNames) {
    const entry = credentialResolve(name, callingMember);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.`, code: 'secure_credential_not_found' };
    if ('denied' in entry) return { error: entry.denied, code: 'secure_credential_denied' };
    if ('expired' in entry) return { error: entry.expired, code: 'secure_credential_expired' };
    resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext);
  }
  return { resolved };
}

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
  scope_url: z.string().optional().describe('Git credential scope URL (e.g. "https://github.com/my-org"). Defaults to "https://<host>".'),

  // GitHub fields
  github_mode: z.enum(['github-app', 'pat']).optional().describe('GitHub auth mode: github-app (mint via configured app) or pat (personal access token)'),
  token: z.string().optional().describe('Personal access token (GitHub PAT or Azure DevOps PAT). Supports {{secure.NAME}} token -- value is resolved from the credential store before use.'),
  git_access: z.enum(['read', 'push', 'push+pr', 'admin', 'issues', 'full']).optional().describe('GitHub App access level override'),
  repos: z.array(z.string()).optional().describe('GitHub App repository list override'),

  // Bitbucket fields
  email: z.string().optional().describe('Bitbucket account email'),
  api_token: z.string().optional().describe('Bitbucket API token. Supports {{secure.NAME}} token -- value is resolved from the credential store before use.'),
  workspace: z.string().optional().describe('Bitbucket workspace slug'),

  // Azure DevOps fields
  org_url: z.string().optional().describe('Azure DevOps organization URL (e.g. https://dev.azure.com/myorg)'),
  pat: z.string().optional().describe('Azure DevOps personal access token. Supports {{secure.NAME}} token -- value is resolved from the credential store before use.'),
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
  /** A {{secure.NAME}} token names no stored credential. */
  | 'secure_credential_not_found'
  /** A {{secure.NAME}} token resolved to a credential this member may not use. */
  | 'secure_credential_denied'
  /** A {{secure.NAME}} token resolved to an expired credential. */
  | 'secure_credential_expired'
  /** Out-of-band credential collection was cancelled or returned nothing. */
  | 'oob_cancelled'
  /** The resolved provider implements no buildCredentials hook (a wiring bug). */
  | 'credential_assembly_unsupported'
  /** The provider rejected the supplied fields (e.g. a required field is absent). */
  | 'credential_assembly_failed'
  /** service.deploy() threw. */
  | 'deploy_threw'
  /** service.deploy() returned success:false. */
  | 'deploy_failed';

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
  /** Registry id of the resolved member, or null. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null. */
  memberName: string | null;
}

export interface ProvisionVcsAuthStructured extends ProvisionVcsAuthFields {
  [key: string]: unknown;
}

export interface ProvisionVcsAuthResult {
  text: string;
  structuredContent: ProvisionVcsAuthStructured;
}

const VCS_OK_REASONS: ProvisionVcsAuthReason[] = ['ok', 'deployed_unverified', 'deployed_verification_skipped'];

export async function provisionVcsAuth(input: ProvisionVcsAuthInput): Promise<ProvisionVcsAuthResult> {
  const label = input.label ?? input.provider;
  const vcsResult = (
    text: string,
    fields: Partial<ProvisionVcsAuthFields> & { reason: ProvisionVcsAuthReason },
  ): ProvisionVcsAuthResult => ({
    text,
    structuredContent: {
      ok: fields.ok ?? VCS_OK_REASONS.includes(fields.reason),
      reason: fields.reason,
      provider: input.provider,
      credentialLabel: label,
      scopeUrl: fields.scopeUrl ?? null,
      expiresAt: fields.expiresAt ?? null,
      verified: fields.verified ?? false,
      verificationSkipped: fields.verificationSkipped ?? false,
      metadata: fields.metadata ?? null,
      expiryWarning: fields.expiryWarning ?? null,
      memberId: fields.memberId ?? null,
      memberName: fields.memberName ?? null,
    },
  });

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

  // Resolve {{secure.NAME}} tokens in credential fields
  const resolvedInput = { ...input };
  for (const field of ['token', 'api_token', 'pat'] as const) {
    if (resolvedInput[field]) {
      const r = resolveSecureField(resolvedInput[field]!, agent.friendlyName);
      if ('error' in r) return vcsResult(`[FAIL] ${r.error}`, { ...who, reason: r.code });
      resolvedInput[field] = r.resolved;
    }
  }

  // OOB fallback for an absent credential field, dispatched through the
  // resolved provider (apra-fleet-5co8.3.2). The provider owns which field its
  // secret lives in, when it counts as missing and what the operator is asked
  // -- no provider name and no auth-mode knowledge is left at this call site.
  // Order is unchanged: {{secure.NAME}} resolution first, then OOB collection
  // (an OOB-collected secret is deliberately NOT re-run through
  // resolveSecureField), then credential assembly.
  const missing = service.missingCredential;
  if (missing && missing.isMissing(resolvedInput)) {
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_vcs_auth', {
      prompt: missing.promptFor(agent.friendlyName),
    });
    if ('fallback' in oob) {
      return vcsResult(oob.fallback ?? 'Error: OOB operation cancelled.', { ...who, reason: 'oob_cancelled' });
    }
    resolvedInput[missing.field] = decryptPassword(oob.password!);
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

  // Cancel any existing credential cleanup timer before re-provisioning
  cancelCredentialCleanup(agent.id);

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
  // Dropping the config half costs nothing: gitCredentialHelperWrite's own
  // `git config --global --replace-all "credential.<url>.helper" ""` already
  // clears every existing value of that key before re-adding the new one, on
  // all three OS command implementations. So the unset was pure redundancy
  // with a destructive failure mode. The FILE removal is kept (rather than
  // dropping the step wholesale) so a pre-label install does not keep an
  // orphaned, still-valid token on disk -- the security wart PR #473 called
  // out.
  try {
    await exec(cmds.gitCredentialHelperRemoveLegacyFile());
  } catch { /* best-effort */ }

  // The agent record only tracks ONE active (label, scopeUrl) pair for
  // cleanup purposes, and cancelCredentialCleanup() above just discarded
  // whatever timer belonged to it. If this deploy is SUPERSEDING a different
  // previously-provisioned credential (a different label and/or scopeUrl,
  // or even a different provider), that superseded credential's timer is now
  // gone forever and nothing else will ever revoke it -- explicitly revoke it
  // here so its git-config registration and on-disk file don't stay orphaned
  // indefinitely. A same-label/same-scopeUrl re-provision (a plain refresh)
  // skips this: gitCredentialHelperWrite's --replace-all below overwrites the
  // existing entry in place, so there is nothing to revoke first.
  if (agent.vcsProvider && agent.vcsCredentialLabel !== undefined &&
      (agent.vcsCredentialLabel !== label || agent.vcsCredentialScopeUrl !== scopeUrl)) {
    const supersededService = providers[agent.vcsProvider];
    if (supersededService) {
      try {
        await supersededService.revoke(agent, cmds, exec, agent.vcsCredentialLabel, agent.vcsCredentialScopeUrl);
      } catch { /* best-effort */ }
    }
  }

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
  updateAgent(agent.id, {
    vcsProvider: input.provider,
    vcsTokenExpiresAt: deployResult.metadata?.expiresAt,
    vcsCredentialLabel: label,
    vcsCredentialScopeUrl: scopeUrl,
  });

  // Schedule auto-cleanup when token expires
  scheduleCredentialCleanup(agent.id, deployResult.metadata?.expiresAt);

  // Best-effort connectivity test
  let connectivity;
  try {
    connectivity = await service.testConnectivity(agent, exec, scopeUrl);
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
    + (expiryWarning ? `\n  ${expiryWarning}` : ''),
    {
      ...who,
      reason,
      scopeUrl,
      expiresAt: deployResult.metadata?.expiresAt ?? null,
      verified: !connectivity.skipped && connectivity.success === true,
      verificationSkipped: connectivity.skipped === true,
      metadata: filteredMetadata,
      expiryWarning: expiryWarning ?? null,
    },
  );
}
