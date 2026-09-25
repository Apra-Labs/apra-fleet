import { useEffect, useState } from "react";
import { Page } from "@apralabs/apra-fleet-ui-kit";
import { deriveDataDir, fetchFleetStatus, fetchWorkflowPackages, type FleetStatusPayload } from "../api/health";

type StatusState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; payload: FleetStatusPayload };

type PackagesState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; packages: string[] };

/** S3 screen: server version, data dir, update-available notice, the fleet
 *  status summary, and the workflow-packages list -- a 404 or network
 *  failure from GET /api/workflow-packages is the EXPECTED "registry not
 *  landed yet" response and renders the same empty state as a genuinely
 *  empty list, never an error. */
export function Health() {
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [packages, setPackages] = useState<PackagesState>({ kind: "loading" });

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
      const list = await fetchWorkflowPackages();
      if (cancelled) return;
      if (list === null || list.length === 0) {
        setPackages({ kind: "empty" });
      } else {
        setPackages({ kind: "loaded", packages: list });
      }
    }

    void loadStatus();
    void loadPackages();

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
          <dd>{deriveDataDir(status.payload.logFile) ?? "-"}</dd>
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
        </dl>
      ) : null}

      <h2>Workflow packages</h2>
      {packages.kind === "loading" ? <p>Loading workflow packages...</p> : null}
      {packages.kind === "empty" ? <p>no workflow packages registered</p> : null}
      {packages.kind === "loaded" ? (
        <ul>
          {packages.packages.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
