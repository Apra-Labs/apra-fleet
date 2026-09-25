// Thin fetch wrapper over the /api/fleet/status route plus the (sibling-
// sprint-owned) GET /api/workflow-packages registry, for the Health screen
// (S3, apra-fleet-9h9j.3.1). Its own module, separate from secrets.ts and
// members.ts, per this lane's file-ownership rule.

export interface FleetStatusSummary {
  total: number;
  online: number;
  offline: number;
}

export interface UpdateAvailable {
  latest: string;
  installed: string;
}

/** Mirrors the json payload fleet_status(format:"json") returns
 *  (src/tools/check-status.ts) -- only the fields the Health screen needs. */
export interface FleetStatusPayload {
  version: string;
  summary: FleetStatusSummary;
  updateAvailable?: UpdateAvailable;
  /** Active server log file path, e.g. "<dataDir>/logs/fleet-1234.log".
   *  There is no dedicated "data dir" field on this payload -- deriveDataDir
   *  below strips the trailing "logs/fleet-<pid>.log" segments off this to
   *  recover it, since src/tools/ is off-limits to this lane and no other
   *  console route exposes it directly. */
  logFile?: string;
}

/** Recovers the fleet data directory from the active log file path
 *  (<dataDir>/logs/fleet-<pid>.log, see src/utils/log-helpers.ts
 *  getActiveLogFile). Returns null when logFile is absent or does not have
 *  the expected two trailing segments -- callers render "-" in that case
 *  rather than guessing. */
export function deriveDataDir(logFile: string | undefined | null): string | null {
  if (!logFile) return null;
  const normalized = logFile.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.length < 3) return null;
  // Drop "fleet-<pid>.log" and "logs".
  segments.pop();
  const logsSegment = segments.pop();
  if (logsSegment !== "logs") return null;
  return segments.join("/") || null;
}

export async function fetchFleetStatus(): Promise<FleetStatusPayload> {
  const response = await fetch("/api/fleet/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "json" })
  });
  if (!response.ok) {
    throw new Error(`request failed with status ${response.status}`);
  }
  return (await response.json()) as FleetStatusPayload;
}

/** The workflow-packages registry lands from a sibling sprint -- until then
 *  a 404 (or any network-level failure) from this GET is the EXPECTED
 *  response on this branch and must read as "no packages", not an error. */
export async function fetchWorkflowPackages(): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetch("/api/workflow-packages");
  } catch {
    return null;
  }
  if (response.status === 404) return null;
  if (!response.ok) return null;
  try {
    const data = (await response.json()) as { packages?: unknown };
    return Array.isArray(data.packages) ? data.packages.filter((p): p is string => typeof p === "string") : null;
  } catch {
    return null;
  }
}
