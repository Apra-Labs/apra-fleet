import { getAllAgents } from './registry.js';
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

export function scheduleCredentialCleanup(agentId: string, expiresAt?: string): void {
  cancelCredentialCleanup(agentId);

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

  const timer = setTimeout(async () => {
    cleanupTimers.delete(agentId);
    try {
      const agents = getAllAgents();
      const agent = agents.find(a => a.id === agentId);
      if (!agent?.vcsProvider) return;

      const service = providers[agent.vcsProvider];
      if (!service) return;

      const strategy = getStrategy(agent);
      const conn = await strategy.testConnection();
      if (!conn.ok) return;

      const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
      const exec = async (cmd: string) => {
        const result = await strategy.execCommand(cmd, 15000);
        return result.stdout;
      };

      // Revoke the SAME label/scopeUrl this deploy actually used (persisted
      // by provision-vcs-auth.ts at deploy time) -- not an unlabeled/
      // default-host guess, which can unset a different, still-valid
      // credential's git-config entry and/or delete the wrong on-disk file.
      await service.revoke(agent, cmds, exec, agent.vcsCredentialLabel, agent.vcsCredentialScopeUrl);
    } catch { /* silent — best-effort cleanup */ }
  }, delayMs);

  if (timer.unref) timer.unref();
  cleanupTimers.set(agentId, timer);
}

export function cancelCredentialCleanup(agentId: string): void {
  const timer = cleanupTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    cleanupTimers.delete(agentId);
  }
}

export function _getCleanupTimers(): Map<string, ReturnType<typeof setTimeout>> {
  return cleanupTimers;
}
