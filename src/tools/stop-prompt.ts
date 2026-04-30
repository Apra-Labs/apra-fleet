import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getStoredPid, getAgentOS } from '../utils/agent-helpers.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import { logLine } from '../utils/log-helpers.js';

export const stopPromptSchema = z.object({
  ...memberIdentifier,
});

export type StopPromptInput = z.infer<typeof stopPromptSchema>;

export async function stopPrompt(input: StopPromptInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  const pid = getStoredPid(agent.id);

  await tryKillPid(agent, strategy, cmds);

  logLine('stop_prompt', `pid=${pid ?? 'none'}`, agent);

  if (pid !== undefined) {
    return `🛑 Agent "${agent.friendlyName}" stopped (killed PID ${pid}).`;
  }
  return `🛑 Agent "${agent.friendlyName}" stopped (no active session was running).`;
}
