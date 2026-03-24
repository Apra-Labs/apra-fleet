import { z } from 'zod';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, hourlyRate, formatUptimeDuration, uptimeHoursFromLaunch, costWarning, uptimeWarning } from '../services/cloud/cost.js';
import { parseGpuUtilization } from '../utils/gpu-parser.js';
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
        const rate = hourlyRate(details.instanceType);
        const typeStr = details.instanceType ?? 'unknown type';
        const ipStr = details.publicIp ?? 'no public IP';

        const warn = costWarning(details.instanceType, uptimeHrs);
        const uptimeWarn = uptimeWarning(uptimeHrs);

        // Anomaly: running but no recent activity and uptime is long
        const lastUsedMs = agent.lastUsed ? Date.now() - new Date(agent.lastUsed).getTime() : undefined;
        const idleAnomalyWarn = (
          details.state === 'running' &&
          lastUsedMs !== undefined &&
          lastUsedMs > 2 * 3_600_000 &&  // >2h since last activity
          uptimeHrs > 2
        ) ? '⚠ Instance running but no recent activity — idle manager may not be active' : null;

        // GPU utilization check (only when running and SSH is available)
        let gpuLine = '';
        if (details.state === 'running') {
          try {
            const strategy = getStrategy(agent);
            const cmds = getOsCommands(getAgentOS(agent));
            const gpuResult = await strategy.execCommand(cmds.gpuUtilization(), 10000);
            const gpuUtil = parseGpuUtilization(gpuResult.stdout);
            if (gpuUtil !== undefined) {
              gpuLine = `\n  gpu:      ${gpuUtil}%`;
            } else {
              // Empty stdout: nvidia-smi not found (suppressed by 2>/dev/null)
              gpuLine = '\n  gpu:      n/a (nvidia-smi not found)';
            }
          } catch {
            gpuLine = '\n  gpu:      n/a (check failed)';
          }
        }

        let out = (
          `"${agent.friendlyName}" cloud status:\n` +
          `  state:    ${details.state}\n` +
          `  instance: ${agent.cloud.instanceId} (${typeStr})\n` +
          `  region:   ${agent.cloud.region}\n` +
          `  ip:       ${ipStr}\n` +
          `  uptime:   ${uptime}\n` +
          `  rate:     ${rate}\n` +
          `  est cost: ${cost}` +
          gpuLine +
          `\n  idle timeout: ${agent.cloud.idleTimeoutMin}min`
        );
        if (warn) out += `\n  warning:  ${warn}`;
        if (uptimeWarn) out += `\n  warning:  ⚠ ${uptimeWarn}`;
        if (idleAnomalyWarn) out += `\n  warning:  ${idleAnomalyWarn}`;
        return out;
      } catch (err: any) {
        return `Failed to get status for "${agent.friendlyName}": ${err.message}`;
      }
    }
  }
}
