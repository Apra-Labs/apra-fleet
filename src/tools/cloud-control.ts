import { z } from 'zod';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, formatUptimeDuration, uptimeHoursFromLaunch } from '../services/cloud/cost.js';
import type { Agent } from '../types.js';

export const cloudControlSchema = z.object({
  member_id: z.string().describe('UUID of the cloud member'),
  action: z.enum(['start', 'stop', 'status']).describe(
    'start: auto-start and wait for SSH ready | stop: stop instance immediately | status: return current state'
  ),
});

export type CloudControlInput = z.infer<typeof cloudControlSchema>;

export async function cloudControl(input: CloudControlInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  if (!agent.cloud) {
    return `Member "${agent.friendlyName}" is not a cloud member (no cloud config).`;
  }

  switch (input.action) {
    case 'start': {
      try {
        const readyAgent = await ensureCloudReady(agent);
        return `Started "${readyAgent.friendlyName}" — SSH ready at ${readyAgent.host ?? agent.host ?? '(unknown IP)'}.`;
      } catch (err: any) {
        return `Failed to start "${agent.friendlyName}": ${err.message}`;
      }
    }

    case 'stop': {
      try {
        await awsProvider.stopInstance(agent.cloud);
        return `Stopped "${agent.friendlyName}" (${agent.cloud.instanceId}).`;
      } catch (err: any) {
        return `Failed to stop "${agent.friendlyName}": ${err.message}`;
      }
    }

    case 'status': {
      try {
        const details = await awsProvider.getInstanceDetails(agent.cloud);
        const uptimeHrs = uptimeHoursFromLaunch(details.launchTime);
        const uptime = details.launchTime ? formatUptimeDuration(uptimeHrs) : '-';
        const cost = estimateCost(details.instanceType, uptimeHrs);
        const typeStr = details.instanceType ?? 'unknown type';
        const ipStr = details.publicIp ?? 'no public IP';
        return (
          `"${agent.friendlyName}" cloud status:\n` +
          `  state:    ${details.state}\n` +
          `  instance: ${agent.cloud.instanceId} (${typeStr})\n` +
          `  region:   ${agent.cloud.region}\n` +
          `  ip:       ${ipStr}\n` +
          `  uptime:   ${uptime}\n` +
          `  est cost: ${cost}\n` +
          `  idle timeout: ${agent.cloud.idleTimeoutMin}min`
        );
      } catch (err: any) {
        return `Failed to get status for "${agent.friendlyName}": ${err.message}`;
      }
    }
  }
}
