import type { Agent } from '../../types.js';
import { getStrategy } from '../strategy.js';
import { getOsCommands } from '../../os/index.js';
import { getAgentOS } from '../../utils/agent-helpers.js';

export type ActivityStatus = 'busy-gpu' | 'busy-process' | 'idle' | 'unknown';

const ACTIVITY_TIMEOUT_MS = 5000;

/**
 * Check whether a fleet member is actively doing work.
 *
 * Returns:
 *   'busy-gpu'     – CUDA compute processes detected on the GPU
 *   'busy-process' – fleet or other process running (fleetProcessCheck)
 *   'idle'         – no activity detected
 *   'unknown'      – check failed; callers should treat this as busy (safe default: don't stop)
 *
 * GPU check is skipped gracefully when nvidia-smi is not installed (non-zero exit).
 * Parse errors are treated defensively to prevent accidental instance stops.
 */
export async function checkMemberActivity(agent: Agent): Promise<ActivityStatus> {
  let strategy;
  try {
    strategy = getStrategy(agent);
  } catch {
    return 'unknown';
  }

  const cmds = getOsCommands(getAgentOS(agent));

  // GPU check — exit 2 (or any non-zero) means nvidia-smi unavailable, skip gracefully
  try {
    const gpuResult = await strategy.execCommand(cmds.gpuProcessCheck(), ACTIVITY_TIMEOUT_MS);
    if (gpuResult.code === 0 && gpuResult.stdout.trim() === 'busy') return 'busy-gpu';
    // non-zero exit: nvidia-smi not installed or other GPU error — skip GPU check, continue
  } catch {
    // SSH/strategy error during GPU check — skip, continue to process check
  }

  // Custom activity command — runs between GPU and process checks (U4)
  // MUST use ACTIVITY_TIMEOUT_MS to prevent hanging the idle manager check loop (Risk R-1)
  if (agent.cloud?.activityCommand) {
    try {
      const actResult = await strategy.execCommand(agent.cloud.activityCommand, ACTIVITY_TIMEOUT_MS);
      if (actResult.code === 0 && actResult.stdout.trim() === 'busy') return 'busy-process';
      // Any other result (idle, error, non-zero exit): fall through to process check
    } catch {
      // Timeout or SSH error — fall through to process check (safe: don't stop on uncertainty)
    }
  }

  // Process check
  try {
    const result = await strategy.execCommand(
      cmds.fleetProcessCheck(agent.workFolder),
      ACTIVITY_TIMEOUT_MS,
    );
    const status = result.stdout.trim();
    if (status === 'fleet-busy' || status === 'other-busy') return 'busy-process';
  } catch {
    return 'unknown'; // cannot check → safe default: don't stop
  }

  return 'idle';
}
