import { getAllAgents } from './registry.js';
import { getStrategy } from './strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { githubProvider } from './vcs/github.js';
import { bitbucketProvider } from './vcs/bitbucket.js';
import { azureDevOpsProvider } from './vcs/azure-devops.js';
import type { VcsProviderService } from './vcs/types.js';

const DEFAULT_TTL_MS = 55 * 60 * 1000; // 55 minutes

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

  let delayMs = DEFAULT_TTL_MS;
  if (expiresAt) {
    const expiresMs = new Date(expiresAt).getTime();
    if (!isNaN(expiresMs)) {
      const untilExpiry = expiresMs - Date.now();
      if (untilExpiry > MAX_TIMEOUT_MS) {
        // Beyond setTimeout's ceiling: do not schedule an auto-revoke that
        // would silently fire near-immediately instead of at the real
        // expiry. checkVcsTokenExpiry's day-scale warning (fired on the next
        // provision/preflight check) and reactive AUTH_EXPIRED
        // classification are the backstop for this horizon instead.
        return;
      }
      delayMs = Math.max(0, untilExpiry);
    }
  }

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

      await service.revoke(agent, cmds, exec);
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
