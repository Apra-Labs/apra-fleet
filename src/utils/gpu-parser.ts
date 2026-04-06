/**
 * Parse GPU utilization percentage from nvidia-smi stdout.
 * Returns the integer percentage (0-100) or undefined if non-numeric.
 */
export function parseGpuUtilization(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > 100) {
    return undefined;
  }
  return parsed;
}
