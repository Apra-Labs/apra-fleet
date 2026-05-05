import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getStoredPid, getAgentOS } from '../utils/agent-helpers.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import { logLine } from '../utils/log-helpers.js';
import { inFlightAgents } from './execute-prompt.js';
import { writeStatusline } from '../services/statusline.js';
import { getStallDetector } from '../services/stall/index.js';

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
  getStallDetector().remove(agent.id);

  if (pid !== undefined) {
    // Poll until execute_prompt's finally block clears inFlightAgents so a
    // re-dispatch immediately after stop_prompt doesn't race against cleanup.
    const deadline = Date.now() + 2000;
    while (inFlightAgents.has(agent.id) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Unconditionally clear busy state — handles pid=none case where inFlightAgents
  // still holds the agent but the process never recorded a PID.
  inFlightAgents.delete(agent.id);
  writeStatusline();

  logLine('stop_prompt', `pid=${pid ?? 'none'}`, agent);

  if (pid !== undefined) {
    return `🛑 Agent "${agent.friendlyName}" stopped (killed PID ${pid}).`;
  }
  return `🛑 Agent "${agent.friendlyName}" stopped (no active session was running).`;
}
