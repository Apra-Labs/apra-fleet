import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { OsCommands } from '../os/os-commands.js';

/**
 * Budgets for the CLI install/update command. Both run under the FLEET_PID
 * wrapper (cmds.wrapPidCapture), so when a budget binds, execCommand kills
 * the remote process tree explicitly (ssh.ts killRemoteTree / the local
 * tree-kill) and the result says it was a timeout kill and how long the
 * step ran -- never a silent cut mid-install. The inactivity budget catches
 * a hung installer; the ceiling bounds one that keeps printing but never
 * finishes.
 *
 * Both inactivity windows are 600s: since the PID wrapper a timed-out
 * install is really killed (the previous release let it run on and usually
 * finish in the background), and real installers -- the agy and Claude
 * installers on a slow link -- can stay silent for minutes while
 * downloading. A long quiet window is cheaper than a killed, half-written
 * install; the 15-minute ceiling still bounds a runaway.
 */
export const INSTALL_INACTIVITY_TIMEOUT_MS = 600_000;
export const UPDATE_INACTIVITY_TIMEOUT_MS = 600_000;
export const INSTALL_MAX_TOTAL_MS = 15 * 60_000;

export const updateAgentCliSchema = z.object({
  ...memberIdentifier,
  install_if_missing: z.boolean().default(false).describe('Install the LLM agent CLI on the member if not already installed (default: false)'),
});

export type UpdateAgentCliInput = z.infer<typeof updateAgentCliSchema>;

interface UpdateResult {
  name: string;
  oldVersion: string;
  newVersion: string;
  success: boolean;
  installed?: boolean;
  error?: string;
}

const TIMEOUT_RE = /^Command (timed out after \d+ms of inactivity|exceeded max total time of \d+ms)/;

/**
 * Run an install/update step under the FLEET_PID wrapper. Resolves with the
 * command result, or with `{ timeoutError }` when a budget killed it: a
 * message naming the step, how long it ran, which budget bound, and the
 * remote PID whose tree was killed.
 */
async function runCliStep(
  strategy: AgentStrategy,
  cmds: OsCommands,
  step: 'install' | 'update',
  command: string,
  inactivityMs: number,
  maxTotalMs: number,
): Promise<SSHExecResult | { timeoutError: string }> {
  const started = Date.now();
  let pid: number | undefined;
  try {
    return await strategy.execCommand(cmds.wrapPidCapture(command), inactivityMs, maxTotalMs, (p) => { pid = p; });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!TIMEOUT_RE.test(msg)) throw err;
    const ranS = Math.round((Date.now() - started) / 1000);
    const why = msg.includes('max total time')
      ? `hit its ${Math.round(maxTotalMs / 1000)}s ceiling`
      : `produced no output for ${Math.round(inactivityMs / 1000)}s`;
    const killed = pid !== undefined
      ? `its remote process tree (PID ${pid}) was killed`
      : 'its SSH channel was closed (no PID was reported, so the remote process may still be running)';
    return {
      timeoutError:
        `CLI ${step} killed on timeout after running ${ranS}s: it ${why}; ${killed}. ` +
        `The CLI may be partially ${step === 'install' ? 'installed' : 'updated'} -- check the member and re-run update_llm_cli.`,
    };
  }
}

async function updateSingleAgent(agent: Agent, installIfMissing: boolean): Promise<UpdateResult> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const provider = getProvider(agent.llmProvider);
  const strategy = getStrategy(agent);
  const result: UpdateResult = {
    name: agent.friendlyName,
    oldVersion: 'unknown',
    newVersion: 'unknown',
    success: false,
  };

  try {
    // Get current version
    const vBefore = await strategy.execCommand(cmds.agentVersion(provider), 15000);
    const cliFound = vBefore.code === 0 && vBefore.stdout.trim().length > 0;
    result.oldVersion = cliFound ? vBefore.stdout.trim() : 'not installed';

    if (!cliFound && !installIfMissing) {
      result.error = `${provider.name} CLI not found — use install_if_missing: true to install`;
      return result;
    }

    if (!cliFound && installIfMissing) {
      const installResult = await runCliStep(strategy, cmds, 'install', cmds.installAgent(provider), INSTALL_INACTIVITY_TIMEOUT_MS, INSTALL_MAX_TOTAL_MS);
      if ('timeoutError' in installResult) {
        result.error = installResult.timeoutError;
        return result;
      }
      if (installResult.code !== 0) {
        result.error = installResult.stderr || 'Install command failed';
        return result;
      }
      result.installed = true;
    } else {
      const updateResult = await runCliStep(strategy, cmds, 'update', cmds.updateAgent(provider), UPDATE_INACTIVITY_TIMEOUT_MS, INSTALL_MAX_TOTAL_MS);
      if ('timeoutError' in updateResult) {
        result.error = updateResult.timeoutError;
        return result;
      }
      if (updateResult.code !== 0) {
        result.error = updateResult.stderr || 'Update command failed';
      }
    }

    // Get new version
    const vAfter = await strategy.execCommand(cmds.agentVersion(provider), 15000);
    result.newVersion = vAfter.stdout.trim() || 'unknown';
    result.success = true;

    if (!result.installed && result.oldVersion === result.newVersion) {
      result.error = 'Already up to date';
    }
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

export async function updateAgentCli(input: UpdateAgentCliInput): Promise<string> {
  let agents: Agent[];

  if (input.member_id || input.member_name) {
    const agentOrError = resolveMember(input.member_id, input.member_name);
    if (typeof agentOrError === 'string') return agentOrError;
    agents = [agentOrError as Agent];
  } else {
    // Update all online agents
    const allAgents = getAllAgents();
    if (allAgents.length === 0) {
      return 'No members registered.';
    }

    // Filter to online members
    const onlineChecks = await Promise.allSettled(
      allAgents.map(async a => {
        const strategy = getStrategy(a);
        const conn = await strategy.testConnection();
        return { agent: a, online: conn.ok };
      })
    );

    agents = onlineChecks
      .filter(r => r.status === 'fulfilled' && r.value.online)
      .map(r => (r as PromiseFulfilledResult<any>).value.agent);

    if (agents.length === 0) {
      return 'No members are currently online.';
    }
  }

  // Update all selected members in parallel
  const results = await Promise.allSettled(agents.map(a => updateSingleAgent(a, input.install_if_missing)));

  let report = `Agent CLI Update Report\n${'='.repeat(40)}\n\n`;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const res = r.value;
      const icon = res.success ? '✅' : '❌';
      report += `${icon} ${res.name}\n`;
      if (res.installed) {
        report += `   Installed: ${res.newVersion}\n`;
      } else {
        report += `   ${res.oldVersion} → ${res.newVersion}\n`;
      }
      if (res.error) {
        report += `   Note: ${res.error}\n`;
      }
      report += '\n';
    } else {
      report += `❌ Error: ${r.reason}\n\n`;
    }
  }

  return report;
}
