import { getAllAgents } from '../registry.js';
import { awsProvider } from './aws.js';
import { checkMemberActivity } from './activity.js';
import { setIdleTouchHook } from '../../utils/agent-helpers.js';

const IDLE_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function log(msg: string): void {
  process.stderr.write('[idle-manager] ' + msg + '\n');
}

export class IdleManager {
  private interval: NodeJS.Timeout | null = null;
  private stopping = new Set<string>();
  private lastActivity = new Map<string, number>();
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

  /**
   * Start the idle manager. Idempotent — safe to call multiple times.
   * @param idleTimeoutMs Global fallback idle timeout (ms). Per-agent timeout takes priority if set.
   */
  start(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS): void {
    if (this.interval) return; // already running
    this.idleTimeoutMs = idleTimeoutMs;

    // R-9: pre-populate lastActivity from persisted lastUsed so we survive server restarts.
    for (const agent of getAllAgents()) {
      if (agent.cloud && agent.lastUsed) {
        this.lastActivity.set(agent.id, new Date(agent.lastUsed).getTime());
      }
    }

    // Wire into touchAgent so tool calls reset the idle timer.
    setIdleTouchHook(id => this.resetTimer(id));

    this.interval = setInterval(() => void this.check(), IDLE_CHECK_INTERVAL_MS);
    this.interval.unref(); // don't prevent process exit
    log('started (idle timeout: ' + (idleTimeoutMs / 60000) + 'min)');
  }

  /** Stop the idle manager and clear the interval. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Reset the idle timer for a member. Called on every tool invocation via touchAgent. */
  resetTimer(agentId: string): void {
    this.lastActivity.set(agentId, Date.now());
  }

  /** Run one idle check cycle immediately (exposed for testing). */
  async checkOnce(): Promise<void> {
    return this.check();
  }

  private async check(): Promise<void> {
    const cloudAgents = getAllAgents().filter(a => a.cloud);

    for (const agent of cloudAgents) {
      // Mutex: skip if a stop is already in progress for this instance
      if (this.stopping.has(agent.id)) continue;

      // Determine effective idle timeout: per-agent setting takes priority over global
      const perAgentMs = agent.cloud!.idleTimeoutMin
        ? agent.cloud!.idleTimeoutMin * 60_000
        : 0;
      const effectiveTimeoutMs = perAgentMs > 0 ? perAgentMs : this.idleTimeoutMs;

      // Check idle time
      const lastActive = this.lastActivity.get(agent.id)
        ?? (agent.lastUsed ? new Date(agent.lastUsed).getTime() : 0);
      const idleMs = Date.now() - lastActive;
      if (idleMs < effectiveTimeoutMs) continue;

      // Only stop running instances
      let state: string;
      try {
        state = await awsProvider.getInstanceState(agent.cloud!);
      } catch (e) {
        log('cannot get state for ' + agent.friendlyName + ': ' + (e as Error).message);
        continue;
      }
      if (state !== 'running') continue;

      // Check for active work before stopping (safe default: unknown → don't stop)
      const activity = await checkMemberActivity(agent);
      if (activity !== 'idle') {
        log(agent.friendlyName + ' is ' + activity + ' — deferring idle stop');
        this.lastActivity.set(agent.id, Date.now()); // bump to avoid re-checking every cycle
        continue;
      }

      // Stop the instance
      this.stopping.add(agent.id);
      const mins = Math.round(idleMs / 60000);
      log('stopping ' + agent.friendlyName + ' (idle ' + mins + 'min)');
      try {
        await awsProvider.stopInstance(agent.cloud!);
        log('stopped ' + agent.friendlyName);
      } catch (e) {
        log('failed to stop ' + agent.friendlyName + ': ' + (e as Error).message);
      } finally {
        this.stopping.delete(agent.id);
      }
    }
  }
}

export const idleManager = new IdleManager();
