// Thin fetch wrapper over the /api/fleet/status route, for the Health screen
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

/** The workflow-packages registry now answers with the OBJECT shape
 *  ({packages: WorkflowPackageView[]}), not the string[] this module used to
 *  filter for -- that filter silently yielded "no packages" for every real
 *  registry. The reader moved to ./workflow-packages, which owns the view
 *  type; it is re-exported here so the Health screen (and any other
 *  consumer) keeps a single stable import for everything it fetches. */
export {
  fetchWorkflowPackages,
  isPackageOffline,
  packageLabel,
  type WorkflowPackageView,
  type WorkflowPackagesResult
} from "./workflow-packages";
