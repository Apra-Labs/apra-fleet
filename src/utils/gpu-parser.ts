/**
 * Parse GPU utilization percentage from nvidia-smi stdout.
 * Returns the integer percentage (0-100) or undefined if non-numeric.
 */
export function parseGpuUtilization(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const parsed = parseInt(trimmed, 10);
  return isNaN(parsed) ? undefined : parsed;
}
