import type { Agent } from '../types.js';
import { getAllAgents } from './registry.js';
import { readMemberStatus } from './statusline.js';
import { logLine } from '../utils/log-helpers.js';
import { lazyIdleMinutes } from '../lazy/mode.js';

/**
 * Members created automatically by the orchestrator carry this tag. It is the
 * ONLY thing that makes a member eligible for reaping - a member the user
 * registered by hand is never swept, however old it is.
 */
export const AUTO_TAG = 'auto';

const DEFAULT_TTL_MIN = 120;

/** TTL in minutes before an idle auto-created member is removed. */
export function autoMemberTtlMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.FLEET_AUTO_MEMBER_TTL_MIN ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return lazyIdleMinutes() ?? DEFAULT_TTL_MIN;
}

export function isAutoMember(agent: Agent): boolean {
  return Array.isArray(agent.tags) && agent.tags.includes(AUTO_TAG);
}

/**
 * Last time the member did anything. Falls back to creation for a member that
 * was registered but never dispatched to.
 */
export function lastActivityMs(agent: Agent): number {
  return Date.parse(agent.lastUsed ?? agent.createdAt);
}

export interface ReapOptions {
  now?: number;
  ttlMin?: number;
  /** Injected for tests. Defaults to the real statusline reader. */
  isBusy?: (agentId: string) => boolean;
}

/**
 * Pure selector: which members are safe to reap right now.
 *
 * A member is reapable only when all hold:
 *   1. it carries the `auto` tag,
 *   2. it is not currently busy,
 *   3. its last activity is older than the TTL.
 *
 * A member whose timestamps cannot be parsed is never reaped - bad data must not
 * turn into deletion.
 */
export function selectReapable(agents: Agent[], opts: ReapOptions = {}): Agent[] {
  const now = opts.now ?? Date.now();
  const ttlMs = (opts.ttlMin ?? autoMemberTtlMin()) * 60_000;
  const isBusy = opts.isBusy ?? ((id: string) => readMemberStatus(id) === 'busy');

  return agents.filter((agent) => {
    if (!isAutoMember(agent)) return false;
    if (isBusy(agent.id)) return false;
    const last = lastActivityMs(agent);
    if (!Number.isFinite(last)) return false;
    return now - last > ttlMs;
  });
}

export interface ReapResult {
  reaped: string[];
  failed: Array<{ name: string; error: string }>;
}

type RemoveFn = (input: { member_id: string; force: boolean }) => Promise<string>;

/**
 * Remove every idle, expired, auto-created member.
 *
 * `force` is deliberately false: a member that turned busy between selection and
 * removal is left alone and picked up by the next sweep.
 */
export async function reapAutoMembers(
  opts: ReapOptions & { agents?: Agent[]; remove?: RemoveFn } = {},
): Promise<ReapResult> {
  const agents = opts.agents ?? getAllAgents();
  const doomed = selectReapable(agents, opts);
  const result: ReapResult = { reaped: [], failed: [] };
  if (doomed.length === 0) return result;

  const remove =
    opts.remove ??
    (async (input) => {
      const { removeMember } = await import('../tools/remove-member.js');
      return removeMember(input as never);
    });

  for (const agent of doomed) {
    try {
      await remove({ member_id: agent.id, force: false });
      result.reaped.push(agent.friendlyName);
    } catch (err) {
      result.failed.push({
        name: agent.friendlyName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logLine(
    'reaper',
    `auto-member sweep: reaped=${result.reaped.length} failed=${result.failed.length}` +
      (result.reaped.length ? ` [${result.reaped.join(', ')}]` : ''),
  );
  return result;
}
