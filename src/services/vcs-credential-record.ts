/**
 * Per-label VCS credential record of a member (Agent.vcsCredentials).
 *
 * A member can hold several VCS credentials at once, one per label (e.g.
 * 'github' for push and 'github-issues' for issue work). Every reader goes
 * through listVcsCredentials()/getVcsCredentials() so the migration rule for
 * older registry entries lives in exactly one place:
 *
 *  1. `vcsCredentials` present (even empty): it is authoritative.
 *  2. Otherwise `vcsCredentialLabel` set (written by releases that tracked ONE
 *     label): read as a one-label map built from the legacy single fields
 *     (provider = vcsProvider, scopeUrl = vcsCredentialScopeUrl or the
 *     provider's default host URL, expiresAt = vcsTokenExpiresAt).
 *  3. Otherwise only `vcsProvider` set (a pre-label registry, or a member whose
 *     provider was declared at registration): one UNLABELED entry, revoked with
 *     no label and no scope URL -- exactly what releases before this map did.
 *
 * Reading never writes. The writers below re-read the member from the
 * registry right before updating, so a concurrent provision of another label
 * on the same member is not clobbered by a stale in-memory copy (updateAgent is
 * a shallow merge, and the read-modify-save below is synchronous).
 *
 * The legacy single fields are still written, mirroring the most recently
 * provisioned remaining label, so older readers (checkVcsTokenExpiry,
 * member_detail) keep working. `vcsProvider` is never cleared here: it also
 * records the provider declared at registration, not only a deployed
 * credential.
 */
import type { Agent, VcsCredentialRecord } from '../types.js';
import { getAgent, updateAgent } from './registry.js';
import { PROVIDER_HOSTS } from './vcs/constants.js';

/** One credential entry; `label` is undefined only for the legacy unlabeled case (rule 3). */
export interface VcsCredentialEntry {
  label: string | undefined;
  provider: VcsCredentialRecord['provider'];
  scopeUrl: string | undefined;
  expiresAt?: string;
}

function defaultScopeUrl(provider: VcsCredentialRecord['provider']): string {
  return `https://${PROVIDER_HOSTS[provider]}`;
}

/** The labeled credentials of a member (rules 1 and 2), in provisioning order (oldest first). */
export function getVcsCredentials(agent: Agent): Record<string, VcsCredentialRecord> {
  if (agent.vcsCredentials) return { ...agent.vcsCredentials };
  if (agent.vcsProvider && agent.vcsCredentialLabel !== undefined) {
    const record: VcsCredentialRecord = {
      provider: agent.vcsProvider,
      scopeUrl: agent.vcsCredentialScopeUrl ?? defaultScopeUrl(agent.vcsProvider),
    };
    if (agent.vcsTokenExpiresAt) record.expiresAt = agent.vcsTokenExpiresAt;
    return { [agent.vcsCredentialLabel]: record };
  }
  return {};
}

/** Every credential of a member to revoke, including the legacy unlabeled one (rule 3). */
export function listVcsCredentials(agent: Agent): VcsCredentialEntry[] {
  if (!agent.vcsCredentials && agent.vcsProvider && agent.vcsCredentialLabel === undefined) {
    return [{ label: undefined, provider: agent.vcsProvider, scopeUrl: agent.vcsCredentialScopeUrl, expiresAt: agent.vcsTokenExpiresAt }];
  }
  return Object.entries(getVcsCredentials(agent)).map(([label, r]) => ({
    label, provider: r.provider, scopeUrl: r.scopeUrl, expiresAt: r.expiresAt,
  }));
}

function mirrorFields(map: Record<string, VcsCredentialRecord>): Partial<Agent> {
  const labels = Object.keys(map);
  const last = labels[labels.length - 1];
  if (last === undefined) {
    return { vcsCredentialLabel: undefined, vcsCredentialScopeUrl: undefined, vcsTokenExpiresAt: undefined };
  }
  const r = map[last];
  return { vcsCredentialLabel: last, vcsCredentialScopeUrl: r.scopeUrl, vcsTokenExpiresAt: r.expiresAt };
}

/** Record (or replace) the credential of one label; other labels are kept. */
export function recordVcsCredential(agentId: string, label: string, record: VcsCredentialRecord): Agent | undefined {
  const fresh = getAgent(agentId);
  if (!fresh) return undefined;
  const map = getVcsCredentials(fresh);
  delete map[label];
  map[label] = record;
  return updateAgent(agentId, { vcsCredentials: map, vcsProvider: record.provider, ...mirrorFields(map) });
}

/**
 * Drop the credential of one label (undefined = the legacy unlabeled entry)
 * from the record; other labels are kept.
 */
export function forgetVcsCredential(agentId: string, label: string | undefined): Agent | undefined {
  const fresh = getAgent(agentId);
  if (!fresh) return undefined;
  const map = getVcsCredentials(fresh);
  if (label !== undefined) delete map[label];
  return updateAgent(agentId, { vcsCredentials: map, ...mirrorFields(map) });
}
