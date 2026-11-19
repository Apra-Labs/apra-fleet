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
 *    names the sharer; otherwise the legacy file and global key are removed,
 *    together with any per-member file of that label.
 *  - opts.legacyOnly (provision_vcs_auth's migration of a legacy entry):
 *    only the legacy shared file and global key are removed (same sharer
 *    rule). The member's per-member file of that label is NEVER removed --
 *    the provision has just written it and the record already points at it.
 */
import type { Agent } from '../types.js';
import type { OsCommands } from '../os/os-commands.js';
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
    await exec(cmds.gitCredentialHelperRemoveLegacyGlobal(PROVIDER_HOSTS[entry.provider], entry.label, entry.scopeUrl));
    return { success: true, message: 'Legacy shared credential helper removed' };
  }
  const result: VcsCredentialRevokeResult = await service.revoke(agent, cmds, exec, entry.label, entry.scopeUrl);
  if (!entry.memberScoped) {
    await exec(cmds.gitCredentialHelperRemoveLegacyGlobal(PROVIDER_HOSTS[entry.provider], entry.label, entry.scopeUrl));
  }
  return result;
}
