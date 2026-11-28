/**
 * Revoke ONE recorded VCS credential of a member (credential-cleanup timer,
 * revoke_vcs_auth, remove_member, provision_vcs_auth's supersede/migration).
 *
 *  - A member-scoped entry: the member's own helper file (per member + label)
 *    is removed -- it is nobody else's, so a host+user sharer does not matter.
 *  - A LEGACY entry (deployed by a release that wrote the shared per-OS-user
 *    file `.fleet-git-credential-<label>` and the global git config key): when
 *    another registered member runs as the same user on the same host, nothing
 *    is removed (that file and key are shared by all of them) and the result
 *    names the sharer; otherwise the legacy file and fleet's OWN values on the
 *    global key are removed (never an operator's or another tool's helper),
 *    together with any per-member file of that label.
 *  - opts.legacyOnly (provision_vcs_auth's migration of a legacy entry):
 *    only the legacy shared file and fleet's own values on the global key are removed (same sharer
 *    rule). The member's per-member file of that label is NEVER removed --
 *    the provision has just written it and the record already points at it.
 */
import type { Agent } from '../types.js';
import type { OsCommands, LegacyHelperReport } from '../os/os-commands.js';
import { parseLegacyHelperReport } from '../os/os-commands.js';
import type { VcsDeployResult, VcsProviderService } from './vcs/types.js';
import type { VcsCredentialEntry } from './vcs-credential-record.js';
import { PROVIDER_HOSTS } from './vcs/constants.js';
import { memberSharingHostUser } from './member-host-user.js';
import { githubProvider } from './vcs/github.js';
import { bitbucketProvider } from './vcs/bitbucket.js';
import { azureDevOpsProvider } from './vcs/azure-devops.js';

const providers: Record<string, VcsProviderService> = {
  github: githubProvider,
  bitbucket: bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

export interface VcsCredentialRevokeResult extends VcsDeployResult {
  /** A legacy shared helper was left in place because a host+user sharer exists. */
  legacyLeftForSharer?: Agent;
  /**
   * What the legacy global key cleanup did (only fleet's own values are ever
   * removed); absent when it did not run. null report: no parsable output.
   */
  legacyGlobalKey?: { scopeUrl: string; report: LegacyHelperReport | null };
}

/** Human line for a legacy global key cleanup, or '' when nothing worth saying happened. */
export function describeLegacyGlobalKey(r: VcsCredentialRevokeResult): string {
  if (r.legacyLeftForSharer) {
    return `[WARN] Upgrade: fleet's legacy global git credential helper was left in place because member "${r.legacyLeftForSharer.friendlyName}" runs as the same user on this host. Fleet no longer refreshes it, so a short-lived token in it (GitHub App: about 1 hour) stops working for git run outside fleet dispatches. Fix: run 'apra-fleet operator-auth github' once (a refreshing helper for git/dolt in your shell), and run gh as 'apra-fleet operator-auth exec -- gh ...'. See docs/design-git-auth.md "Upgrading from 0.4.5 or older".`;
  }
  const g = r.legacyGlobalKey;
  if (!g) return '';
  const key = `credential.${g.scopeUrl}.helper`;
  if (!g.report) return `[WARN] Upgrade: could not confirm the cleanup of fleet's legacy helper on global git config key ${key}; check it with: git config --global --get-all ${key}`;
  if (g.report.failed) return `[WARN] Upgrade: git refused to remove fleet's legacy helper value from global git config key ${key}; the key was left unchanged.`;
  if (g.report.removed === 0) return '';
  const kept = g.report.kept > 0
    ? `${g.report.kept} other value(s) on that key were not written by fleet and were kept`
    : (g.report.resetRemoved ? 'no other value was on that key, so it is now gone' : 'no other helper was on that key');
  return `[WARN] Upgrade: removed fleet's legacy helper from global git config key ${key} (${kept}). Git run OUTSIDE fleet dispatches (your shell, cron, hooks) no longer gets the fleet token for ${g.scopeUrl}; fleet dispatches are unaffected. To keep host git working, run 'apra-fleet operator-auth github' once (and 'apra-fleet operator-auth exec -- gh ...' for gh). See docs/design-git-auth.md "Upgrading from 0.4.5 or older".`;
}

async function removeLegacyGlobal(
  entry: Pick<VcsCredentialEntry, 'label' | 'provider' | 'scopeUrl'>,
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
): Promise<NonNullable<VcsCredentialRevokeResult['legacyGlobalKey']>> {
  const host = PROVIDER_HOSTS[entry.provider];
  const out = await exec(cmds.gitCredentialHelperRemoveLegacyGlobal(host, entry.label, entry.scopeUrl));
  return { scopeUrl: entry.scopeUrl ?? `https://${host}`, report: parseLegacyHelperReport(out) };
}

export async function revokeVcsCredential(
  agent: Agent,
  entry: Pick<VcsCredentialEntry, 'label' | 'provider' | 'scopeUrl' | 'memberScoped'>,
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
  opts: { legacyOnly?: boolean } = {},
): Promise<VcsCredentialRevokeResult> {
  const service = providers[entry.provider];
  if (!service) return { success: false, message: `Unknown VCS provider "${entry.provider}"` };
  if (opts.legacyOnly && entry.memberScoped) {
    return { success: true, message: 'No legacy credential helper to migrate' };
  }
  if (!entry.memberScoped) {
    const sharer = memberSharingHostUser(agent);
    if (sharer) {
      return { success: true, message: 'Shared legacy credential helper left in place', legacyLeftForSharer: sharer };
    }
  }
  if (opts.legacyOnly) {
    const legacyGlobalKey = await removeLegacyGlobal(entry, cmds, exec);
    return { success: true, message: 'Legacy shared credential helper removed (only fleet\'s own global git config values)', legacyGlobalKey };
  }
  const result: VcsCredentialRevokeResult = await service.revoke(agent, cmds, exec, entry.label, entry.scopeUrl);
  if (!entry.memberScoped) {
    result.legacyGlobalKey = await removeLegacyGlobal(entry, cmds, exec);
  }
  return result;
}
