/**
 * Cost estimation for common AWS instance types (us-east-1 on-demand pricing).
 * These are approximate rates — see AWS pricing pages for exact figures.
 */

const HOURLY_RATES: Record<string, number> = {
  // GPU instances — G4dn family (NVIDIA T4)
  'g4dn.xlarge':   0.526,
  'g4dn.2xlarge':  0.752,
  'g4dn.4xlarge':  1.204,
  'g4dn.8xlarge':  2.264,
  'g4dn.12xlarge': 3.912,
  'g4dn.16xlarge': 4.528,
  'g4dn.metal':    7.824,

  // GPU instances — G5 family (NVIDIA A10G)
  'g5.xlarge':    1.006,
  'g5.2xlarge':   1.212,
  'g5.4xlarge':   1.624,
  'g5.8xlarge':   2.448,
  'g5.12xlarge':  5.672,
  'g5.16xlarge':  4.096,
  'g5.24xlarge':  8.144,
  'g5.48xlarge': 16.288,

  // GPU instances — P3 family (NVIDIA V100)
  'p3.2xlarge':   3.06,
  'p3.8xlarge':  12.24,
  'p3.16xlarge': 24.48,

  // GPU instances — P4d family (NVIDIA A100)
  'p4d.24xlarge': 32.77,

  // General purpose — T3 family
  't3.nano':    0.0052,
  't3.micro':   0.0104,
  't3.small':   0.0208,
  't3.medium':  0.0416,
  't3.large':   0.0832,
  't3.xlarge':  0.1664,
  't3.2xlarge': 0.3328,

  // General purpose — M5 family
  'm5.large':    0.096,
  'm5.xlarge':   0.192,
  'm5.2xlarge':  0.384,
  'm5.4xlarge':  0.768,
  'm5.8xlarge':  1.536,
  'm5.12xlarge': 2.304,
  'm5.16xlarge': 3.072,
  'm5.24xlarge': 4.608,

  // Compute optimized — C5 family
  'c5.large':    0.085,
  'c5.xlarge':   0.170,
  'c5.2xlarge':  0.340,
  'c5.4xlarge':  0.680,
  'c5.9xlarge':  1.530,
  'c5.12xlarge': 2.040,
  'c5.18xlarge': 3.060,
  'c5.24xlarge': 4.080,
};

/**
 * Returns estimated hourly cost as a formatted string (e.g. "$2.42"),
 * or "?" if the instance type is not in the lookup table.
 */
export function estimateCost(instanceType: string | undefined, uptimeHours: number): string {
  if (!instanceType) return '?';
  const rate = HOURLY_RATES[instanceType];
  if (rate === undefined) return '?';
  const total = rate * uptimeHours;
  return '$' + total.toFixed(2);
}

/**
 * Returns hourly rate string (e.g. "$0.526/hr"), or "?" if unknown.
 */
export function hourlyRate(instanceType: string | undefined): string {
  if (!instanceType) return '?';
  const rate = HOURLY_RATES[instanceType];
  if (rate === undefined) return '?';
  return '$' + rate.toFixed(3) + '/hr';
}

/**
 * Formats uptime in hours as a human-readable duration string.
 * Examples: "45m", "2h 30m", "1d 3h"
 */
export function formatUptimeDuration(hours: number): string {
  if (hours < 0) return '0m';
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const remainingAfterDays = totalMinutes % (60 * 24);
  const hrs = Math.floor(remainingAfterDays / 60);
  const mins = remainingAfterDays % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

/**
 * Calculate uptime hours from an ISO launch time string.
 * Returns 0 if launchTime is missing or unparseable.
 */
export function uptimeHoursFromLaunch(launchTime: string | undefined): number {
  if (!launchTime) return 0;
  try {
    const launched = new Date(launchTime).getTime();
    return (Date.now() - launched) / 3_600_000;
  } catch {
    return 0;
  }
}
