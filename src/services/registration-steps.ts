/**
 * Per-step timing and wall-clock bounds for register_member.
 *
 * Registration runs a chain of member probes (shell detection, CLI version,
 * VCS remote, role-file provisioning, workspace trust, compose_permissions,
 * the fleetMcp member-session probe). On a local Windows member every one of
 * those is a fresh powershell.exe spawn, and a probe that never answers used
 * to hold the whole register_member call (and the console wizard waiting on
 * it) open for as long as the probe's own inactivity timer allowed -- or
 * forever, where there was none.
 *
 * `RegistrationTimer.run` wraps one step: it records how long the step took
 * and, when the step exceeds its bound, stops WAITING for it (the step's own
 * exec timeouts still kill the underlying process) and reports the step as
 * timed out so the caller can register the member with that probe marked
 * degraded instead of hanging.
 */

export type RegistrationStep =
  | 'connect'
  | 'shell-probe'
  | 'cli-version'
  | 'vcs-remote'
  | 'work-folder'
  | 'agent-files'
  | 'compose-permissions'
  | 'fleet-mcp';

export type RegistrationStepOutcome = 'ok' | 'timed-out';

export interface RegistrationStepRecord {
  step: RegistrationStep;
  ms: number;
  outcome: RegistrationStepOutcome;
}

/**
 * Default wall-clock bound per step (ms). Each is a ceiling on how long
 * registration WAITS for that step, set above the slowest legitimate run of
 * its probes on a cold Windows host:
 *  - shell-probe: up to five sequential probe spawns, each a PowerShell or
 *    bash cold start (about 1-3s apiece on a fresh install).
 *  - cli-version / vcs-remote / work-folder: run concurrently, each with its
 *    own 10-15s exec timeout.
 *  - agent-files: role-file provisioning, shadow recheck, workspace trust.
 *  - compose-permissions: the permission/MCP-entry write sequence -- a
 *    mandatory step; a timeout fails registration loudly.
 *  - fleet-mcp (local): one loopback MEMBER session to this same server.
 *  - fleet-mcp (remote): may download and run the member installer, whose
 *    own exec bound is 5 minutes.
 */
export const DEFAULT_STEP_BOUNDS_MS: Readonly<Record<RegistrationStep | 'fleet-mcp-remote', number>> = {
  'connect': 30_000,
  'shell-probe': 30_000,
  'cli-version': 20_000,
  'vcs-remote': 20_000,
  'work-folder': 20_000,
  'agent-files': 30_000,
  'compose-permissions': 60_000,
  'fleet-mcp': 30_000,
  'fleet-mcp-remote': 8 * 60_000,
};

export type RegistrationStepBounds = Partial<Record<RegistrationStep | 'fleet-mcp-remote', number>>;

export type StepResult<T> = { timedOut: false; value: T } | { timedOut: true; boundMs: number };

export class RegistrationTimer {
  readonly steps: RegistrationStepRecord[] = [];
  private readonly bounds: Record<RegistrationStep | 'fleet-mcp-remote', number>;

  constructor(bounds: RegistrationStepBounds = {}, private readonly now: () => number = () => Date.now()) {
    this.bounds = { ...DEFAULT_STEP_BOUNDS_MS, ...bounds };
  }

  boundFor(key: RegistrationStep | 'fleet-mcp-remote'): number {
    return this.bounds[key];
  }

  /**
   * Run `fn` as step `step`, waiting at most `boundMs` (default: the step's
   * configured bound). A rejection from `fn` propagates unchanged (and is
   * still timed); exceeding the bound resolves `{ timedOut: true }`.
   */
  async run<T>(step: RegistrationStep, fn: () => Promise<T>, boundMs: number = this.bounds[step]): Promise<StepResult<T>> {
    const started = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true; boundMs: number }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, boundMs }), boundMs);
      // Never keep the process alive just to time out a step.
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const result = await Promise.race([
        fn().then((value) => ({ timedOut: false as const, value })),
        timeout,
      ]);
      this.steps.push({ step, ms: this.now() - started, outcome: result.timedOut ? 'timed-out' : 'ok' });
      return result;
    } catch (err) {
      this.steps.push({ step, ms: this.now() - started, outcome: 'ok' });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Steps that hit their bound, in run order. */
  degraded(): RegistrationStep[] {
    return this.steps.filter((s) => s.outcome === 'timed-out').map((s) => s.step);
  }

  /** One ASCII line for the fleet log, e.g. "shell-probe=812ms cli-version=20000ms(timed-out) total=20812ms". */
  summary(): string {
    const total = this.steps.reduce((sum, s) => sum + s.ms, 0);
    const parts = this.steps.map((s) => `${s.step}=${s.ms}ms${s.outcome === 'timed-out' ? '(timed-out)' : ''}`);
    return `${parts.join(' ')} total=${total}ms`;
  }
}

/** Human-readable seconds for a bound, e.g. 30000 -> "30s". */
export function formatBound(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
