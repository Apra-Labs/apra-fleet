import { apiUrl } from "./base-path";
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
  /** Resolved absolute fleet data directory, always present on the server
   *  payload (see src/tools/check-status.ts) -- the authoritative source for
   *  the Health page's "Data dir" row. Optional here only so this type still
   *  accepts a payload from an older server that predates the field. */
  dataDir?: string;
  /** Active server log file path, e.g. "<dataDir>/logs/fleet-1234.log".
   *  deriveDataDir below strips the trailing "logs/fleet-<pid>.log" segments
   *  off this to recover the data dir; kept only as a legacy fallback for a
   *  console talking to an older server whose payload has no dataDir. */
  logFile?: string;
  /** apra-fleet-i9ag.12.9: pre-rendered by the server from
   *  src/cli/fleet-se-prereqs.ts's summarizeFleetSePrereqs() -- e.g.
   *  "ready (node 22.16.0, npm 10.5.0)" or "NOT INSTALLED (node: NOT
   *  INSTALLED) -- <fix line>". Rendered here VERBATIM: the browser bundle
   *  cannot import that module itself (it shells out via node:child_process,
   *  which has no browser build), so the server is the single place that
   *  computes this text -- this lane must never restate the minimum version
   *  or the fix line as its own literal. When this field is absent (older
   *  server, or the server-side probe threw), Health.tsx renders an explicit
   *  "unknown" fleet-se row rather than omitting the row (apra-fleet-
   *  i9ag.13.9) -- omitting it silently collapsed "prerequisites fine" and
   *  "not reported" into one indistinguishable state. */
  fleetSePrereqs?: string;
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
  const response = await fetch(apiUrl("/api/fleet/status"), {
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
