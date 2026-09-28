import { useEffect, useState } from "react";
import { Page } from "@apralabs/apra-fleet-ui-kit";
import {
  deriveDataDir,
  fetchFleetStatus,
  fetchWorkflowPackages,
  packageLabel,
  type FleetStatusPayload,
  type WorkflowPackageView
} from "../api/health";
import { fetchSupervisorProjectState, type SupervisorProjectState } from "../api/supervisor-health";

type StatusState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; payload: FleetStatusPayload };

type PackagesState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; packages: WorkflowPackageView[] };

/** Adds a transient `loading` state on top of the three settled states
 *  fetchSupervisorProjectState() returns -- the row must never be blank or
 *  omitted, so it renders an explicit "loading" text until the fetch
 *  settles into one of the three distinguishable states. */
type ProjectFolderState = { kind: "loading" } | SupervisorProjectState;

/** Row content for the supervisor project-folder row, from its own
 *  independent fetch state -- fetched separately from /api/fleet/status, so
 *  this row's failure never depends on, or affects, the other status rows
 *  (apra-fleet-i9ag.17.3.1). */
function renderProjectFolder(state: ProjectFolderState) {
  if (state.kind === "loading") return "loading...";
  if (state.kind === "configured") return `${state.projectDir} (${state.source})`;
  if (state.kind === "not-configured") {
    return "not configured -- pass --beads-dir <project-or-.beads-path> or set a project folder in supervisor.config.json";
  }
  return "unknown (supervisor unreachable or does not report this field)";
}

/** S3 screen: server version, data dir, update-available notice, the fleet
 *  status summary, and the workflow-packages list -- a 404 or network
 *  failure from GET /api/workflow-packages is the EXPECTED "registry not
 *  landed yet" response and renders the same empty state as a genuinely
 *  empty list, never an error. */
export function Health() {
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [packages, setPackages] = useState<PackagesState>({ kind: "loading" });
  const [projectFolder, setProjectFolder] = useState<ProjectFolderState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const payload = await fetchFleetStatus();
        if (!cancelled) setStatus({ kind: "loaded", payload });
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "unknown error";
          setStatus({ kind: "error", message });
        }
      }
    }

    async function loadPackages() {
      // An `error` result (404 / network failure / unreadable body) is the
      // EXPECTED "registry not present" case and renders the same empty
      // state as a genuinely empty registry -- never an error state.
      const { packages: list } = await fetchWorkflowPackages();
      if (cancelled) return;
      if (list.length === 0) {
        setPackages({ kind: "empty" });
      } else {
        setPackages({ kind: "loaded", packages: list });
      }
    }

    async function loadProjectFolder() {
      // fetchSupervisorProjectState() never throws -- a supervisor outage
      // degrades to its own `unknown` state, so this fetch's failure can
      // never break the status or workflow-packages rows above.
      const state = await fetchSupervisorProjectState();
      if (!cancelled) setProjectFolder(state);
    }

    void loadStatus();
    void loadPackages();
    void loadProjectFolder();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page title="Health" subtitle="Server version, data dir and fleet status">
      {status.kind === "loading" ? <p>Loading status...</p> : null}
      {status.kind === "error" ? <p role="alert">Failed to load status: {status.message}</p> : null}
      {status.kind === "loaded" ? (
        <dl>
          <dt>Version</dt>
          <dd>{status.payload.version}</dd>
          <dt>Data dir</dt>
          <dd>
            {status.payload.dataDir && status.payload.dataDir.length > 0
              ? status.payload.dataDir
              : deriveDataDir(status.payload.logFile) ?? "-"}
          </dd>
          <dt>Update available</dt>
          <dd>
            {status.payload.updateAvailable
              ? `${status.payload.updateAvailable.latest} (installed ${status.payload.updateAvailable.installed})`
              : "up to date"}
          </dd>
          <dt>Fleet status</dt>
          <dd>
            {status.payload.summary.total} member(s): {status.payload.summary.online} online,{" "}
            {status.payload.summary.offline} offline
          </dd>
          <dt>fleet-se</dt>
          <dd>
            {status.payload.fleetSePrereqs ?? "unknown (not reported by server)"}
          </dd>
        </dl>
      ) : null}

      {/* Fetched independently of /api/fleet/status, through the console's
       *  /ext/<package id>/* proxy to the supervisor's own GET /api/health
       *  (apra-fleet-i9ag.17.3.1) -- a supervisor outage degrades only this
       *  row, never the status rows above or the workflow-packages list
       *  below. */}
      <dl>
        <dt>Project folder</dt>
        <dd>{renderProjectFolder(projectFolder)}</dd>
      </dl>

      <h2>Workflow packages</h2>
      {packages.kind === "loading" ? <p>Loading workflow packages...</p> : null}
      {packages.kind === "empty" ? <p>no workflow packages registered</p> : null}
      {packages.kind === "loaded" ? (
        <ul>
          {packages.packages.map((view) => (
            <li key={view.id}>
              {view.id}
              {packageLabel(view) === view.id ? null : ` (${packageLabel(view)})`}
              {view.version ? ` v${view.version}` : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
