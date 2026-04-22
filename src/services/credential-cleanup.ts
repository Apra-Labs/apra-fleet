import { getAllAgents } from './registry.js';
import { getStrategy } from './strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { githubProvider } from './vcs/github.js';
import { bitbucketProvider } from './vcs/bitbucket.js';
import { azureDevOpsProvider } from './vcs/azure-devops.js';
import type { VcsProviderService } from './vcs/types.js';

const DEFAULT_TTL_MS = 55 * 60 * 1000; // 55 minutes

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
      delayMs = Math.max(0, expiresMs - Date.now());
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

      const cmds = getOsCommands(getAgentOS(agent));
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
