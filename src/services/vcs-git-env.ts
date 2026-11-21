/**
 * Git credential helper registration through the dispatch environment.
 *
 * provision_vcs_auth writes each credential helper as a per-member, per-label
 * file and registers it in NO git config file (src/os/os-commands.ts). Every
 * fleet dispatch to the member that can start git -- execute_command (sync and
 * long-running), execute_prompt, vcs_credential_exec and provision's own
 * connectivity check -- prepends vcsGitEnvPrefix(agent), which sets
 * GIT_CONFIG_PARAMETERS for that one command. Every git process the command
 * starts inherits it, whatever repository it runs in: the member's clone, a
 * worktree, or the bare cache repository bd/dolt pushes through.
 *
 * The member's own entries (memberScoped) are registered. A legacy entry is
 * still served by the global git config key an older release wrote, and is
 * registered here (its shared legacy file) only on a scope that also has a
 * member-scoped entry, because the prefix resets that scope's global list.
 *
 * Several labels on one scope URL: git uses the FIRST helper that answers, so
 * the order is explicit, never provisioning order (a refresh must not change
 * which token git pushes with): the provider-named label (the one the sprint
 * engine provisions, e.g. 'github') first, then the others alphabetically.
 * Every label stays readable on its own through vcs_credential_exec.
 */
import type { Agent } from '../types.js';
import { getOsCommands } from '../os/index.js';
import type { GitCredentialHelperRegistration, OsCommands } from '../os/os-commands.js';
import { isSafeGitCredentialScope } from '../os/os-commands.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { listVcsCredentials } from './vcs-credential-record.js';
import { logWarn } from '../utils/log-helpers.js';

/** The helpers to register for a member, in the order git should try them. */
export function vcsGitHelperRegistrations(agent: Agent): GitCredentialHelperRegistration[] {
  const labeled = listVcsCredentials(agent)
    .filter(e => e.label !== undefined && e.scopeUrl !== undefined);
  const ownScopes = new Set(labeled.filter(e => e.memberScoped).map(e => e.scopeUrl!));
  // A legacy entry (still served by the global key an older release wrote) is
  // registered too when its scope also has a member-scoped helper: the prefix
  // resets that scope's global list, which would otherwise hide it -- e.g. a
  // legacy 'github' push credential behind a newly provisioned 'github-issues'.
  const entries = labeled.filter(e => e.memberScoped
    || (ownScopes.has(e.scopeUrl!) && isSafeGitCredentialScope(e.scopeUrl!)));
  const rank = (e: (typeof entries)[number]) => (e.label === e.provider ? 0 : 1);
  return [...entries]
    .sort((a, b) => rank(a) - rank(b) || (a.label! < b.label! ? -1 : a.label! > b.label! ? 1 : 0))
    .map(e => ({ scopeUrl: e.scopeUrl!, label: e.label!, ...(e.memberScoped ? {} : { legacy: true }) }));
}

/**
 * The statement to prepend to a member command so git uses this member's own
 * credential helpers; '' when the member has none. A record that cannot be
 * expressed safely (it never can once recorded: provision_vcs_auth validates
 * the scope URL first) is logged and yields '' rather than a broken command.
 */
export function vcsGitEnvPrefix(agent: Agent, cmds?: OsCommands): string {
  const helpers = vcsGitHelperRegistrations(agent);
  if (helpers.length === 0) return '';
  try {
    return (cmds ?? getOsCommands(getAgentOS(agent), getAgentShell(agent))).gitCredentialEnvPrefix(helpers, agent.id);
  } catch (err) {
    logWarn('vcs_git_env', `git credential helpers not registered for this command: ${err instanceof Error ? err.message : String(err)}`, agent);
    return '';
  }
}
