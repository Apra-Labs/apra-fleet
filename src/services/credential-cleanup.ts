import { getAllAgents } from './registry.js';
import { listVcsCredentials, forgetVcsCredential } from './vcs-credential-record.js';
import { getStrategy } from './strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { githubProvider } from './vcs/github.js';
import { bitbucketProvider } from './vcs/bitbucket.js';
import { azureDevOpsProvider } from './vcs/azure-devops.js';
import type { VcsProviderService } from './vcs/types.js';

// apra-fleet-5co8.5.1: setTimeout's delay is a signed 32-bit int internally;
// Node (and browsers) SILENTLY CLAMP an overflowing delay to ~1ms rather than
// running it after the full requested duration (see Node's lib/timers.js
// `timeoutInfo` overflow handling / the Node TimeoutOverflowWarning). A
// long-lived Azure DevOps PAT (skills/fleet/auth-azdevops.md recommends 90
// days, i.e. ~7.8e9 ms) blows well past this ceiling -- scheduling a raw
// setTimeout for it would auto-revoke the credential we just deployed
// almost immediately, the exact opposite of "warn, never delete" this task
// was scoped to.
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // ~24.8 days

const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

const providers: Record<string, VcsProviderService> = {
  github: githubProvider,
  bitbucket: bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

/** Timer key: one cleanup timer per member AND label (labels and member ids never contain '|'). */
export function cleanupTimerKey(agentId: string, label: string | undefined): string {
  return `${agentId}|${label ?? ''}`;
}

/**
 * Schedule the auto-revoke of ONE label's credential on one member. Only that
 * label's previous timer is replaced: the other labels of the same member keep
 * theirs (a member can hold several labels at once -- see
 * src/services/vcs-credential-record.ts).
 */
export function scheduleCredentialCleanup(agentId: string, label: string | undefined, expiresAt?: string): void {
  cancelCredentialCleanup(agentId, label);

  // No known real expiry: do NOT fall back to a blind default-TTL
  // self-destruct (a prior version used a hardcoded 55-minute
  // DEFAULT_TTL_MS here, unrelated to the deployed credential's actual
  // lifetime -- every PAT-mode deploy scheduled its own near-arbitrary
  // self-revoke and looked like "tokens keep expiring too fast"). Skipping
  // scheduling entirely trades that for a real tradeoff of its own: a
  // credential deployed with no derivable expiry now lives on disk/in git
  // config until something explicit revokes it (revoke_vcs_auth, or a later
  // provision_vcs_auth call that supersedes it -- see the supersession-revoke
  // in provision-vcs-auth.ts) -- it is NOT auto-revoked at all, and unlike the
  // beyond-setTimeout-ceiling case below, checkVcsTokenExpiry has no warning
  // to offer either: it is only called (provision-vcs-auth.ts) when an
  // expiresAt actually exists, so a no-expiry credential gets no reactive
  // backstop of any kind. This is a deliberate, real security-posture
  // tradeoff (an indefinitely-live unrevoked credential vs. a blind
  // self-destruct at an arbitrary time), not a resolved one.
  if (!expiresAt) return;

  const expiresMs = new Date(expiresAt).getTime();
  if (isNaN(expiresMs)) return;

  const untilExpiry = expiresMs - Date.now();
  if (untilExpiry > MAX_TIMEOUT_MS) {
    // Beyond setTimeout's ceiling: do not schedule an auto-revoke that
    // would silently fire near-immediately instead of at the real
    // expiry. checkVcsTokenExpiry's day-scale warning (fired on the next
    // provision/preflight check) and reactive AUTH_EXPIRED
    // classification are the backstop for this horizon instead.
    return;
  }
  const delayMs = Math.max(0, untilExpiry);

  const key = cleanupTimerKey(agentId, label);
  const timer = setTimeout(async () => {
    cleanupTimers.delete(key);
    try {
      const agent = getAllAgents().find(a => a.id === agentId);
      if (!agent) return;
      // Revoke the SAME label/scopeUrl/provider this label's deploy recorded
      // (provision-vcs-auth.ts) -- never another label's, and never an
      // unlabeled/default-host guess that could unset a different, still-valid
      // credential's git-config entry and/or delete the wrong on-disk file.
      const entry = listVcsCredentials(agent).find(e => e.label === label);
      if (!entry) return;

      const service = providers[entry.provider];
      if (!service) return;

      const strategy = getStrategy(agent);
      const conn = await strategy.testConnection();
      if (!conn.ok) return;

      const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
      const exec = async (cmd: string) => {
        const result = await strategy.execCommand(cmd, 15000);
        return result.stdout;
      };

      await service.revoke(agent, cmds, exec, entry.label, entry.scopeUrl);
      forgetVcsCredential(agentId, entry.label);
    } catch { /* silent -- best-effort cleanup */ }
  }, delayMs);

  if (timer.unref) timer.unref();
  cleanupTimers.set(key, timer);
}

/**
 * Cancel the cleanup timer of one label of a member, or -- with no label
 * argument -- every cleanup timer of that member (remove_member).
 */
export function cancelCredentialCleanup(agentId: string, ...label: [string | undefined] | []): void {
  const keys = label.length > 0
    ? [cleanupTimerKey(agentId, label[0])]
    : [...cleanupTimers.keys()].filter(k => k.startsWith(`${agentId}|`));
  for (const key of keys) {
    const timer = cleanupTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      cleanupTimers.delete(key);
    }
  }
}

export function _getCleanupTimers(): Map<string, ReturnType<typeof setTimeout>> {
  return cleanupTimers;
}
