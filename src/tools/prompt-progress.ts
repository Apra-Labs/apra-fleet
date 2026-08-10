import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import type { Agent } from '../types.js';

export const promptProgressSchema = z.object({
  ...memberIdentifier,
  since_commit: z.string().optional().describe(
    'Show only commits after this SHA (exclusive). ' +
    'Useful when the caller recorded the HEAD SHA at dispatch time and wants a delta view.'
  ),
  max_commits: z.number().min(1).max(50).default(15).describe(
    'Maximum number of recent commits to return (default: 15).'
  ),
});

export type PromptProgressInput = z.infer<typeof promptProgressSchema>;

export async function promptProgress(input: PromptProgressInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent);
  } catch (err: any) {
    return `Cannot connect to "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const provider = getProvider(agent.llmProvider);
  const folder = agent.workFolder;

  const gitLogCmd = input.since_commit
    ? `cd ${folder} && git log --oneline ${input.since_commit}..HEAD -${input.max_commits} 2>/dev/null || echo "[]"`
    : `cd ${folder} && git log --oneline -${input.max_commits} 2>/dev/null || echo "[]"`;

  const [logResult, diffResult, busyResult, progressResult, branchResult] = await Promise.allSettled([
    strategy.execCommand(gitLogCmd, 10000),
    strategy.execCommand(`cd ${folder} && git diff --stat HEAD~1 2>/dev/null || echo ""`, 10000),
    strategy.execCommand(
      cmds.fleetProcessCheck(folder, agent.sessionId, provider.processName),
      10000,
    ),
    strategy.execCommand(`cd ${folder} && cat progress.json 2>/dev/null || echo "{}"`, 10000),
    strategy.execCommand(`cd ${folder} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown"`, 10000),
  ]);

  // Parse commits
  const commits: Array<{ sha: string; message: string }> = [];
  if (logResult.status === 'fulfilled') {
    const lines = logResult.value.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      if (line === '[]') break;
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx > 0) {
        commits.push({
          sha: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
        });
      }
    }
  }

  // Parse diff stat
  let filesChanged = '';
  if (diffResult.status === 'fulfilled') {
    filesChanged = diffResult.value.stdout.trim();
  }

  // Parse busy status
  let sessionStatus = 'unknown';
  if (busyResult.status === 'fulfilled') {
    const output = busyResult.value.stdout.trim().toLowerCase();
    if (output.includes('fleet-busy')) sessionStatus = 'busy';
    else if (output.includes('other-busy')) sessionStatus = 'idle (unrelated process)';
    else sessionStatus = 'idle';
  }

  // Parse progress.json task states
  let taskStates: Record<string, string> = {};
  if (progressResult.status === 'fulfilled') {
    try {
      const data = JSON.parse(progressResult.value.stdout.trim() || '{}');
      if (data.tasks && Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          if (t.id && t.status) {
            taskStates[t.id] = t.status;
          }
        }
      }
    } catch {
      // progress.json missing or malformed -- not an error
    }
  }

  // Parse branch
  const branch = branchResult.status === 'fulfilled'
    ? branchResult.value.stdout.trim()
    : 'unknown';

  // Compute last commit age
  let lastCommitAge: string | null = null;
  if (commits.length > 0) {
    try {
      const ageResult = await strategy.execCommand(
        `cd ${folder} && git log -1 --format=%cr 2>/dev/null || echo "unknown"`,
        5000,
      );
      lastCommitAge = ageResult.stdout.trim();
    } catch {
      // non-critical
    }
  }

  const result: Record<string, unknown> = {
    member: agent.friendlyName,
    branch,
    sessionStatus,
    commitCount: commits.length,
    commits,
    ...(lastCommitAge ? { lastCommitAge } : {}),
    ...(Object.keys(taskStates).length > 0 ? { taskStates } : {}),
    ...(filesChanged ? { diffStat: filesChanged } : {}),
    ...(input.since_commit ? { sinceCommit: input.since_commit } : {}),
  };

  return JSON.stringify(result, null, 2);
}
