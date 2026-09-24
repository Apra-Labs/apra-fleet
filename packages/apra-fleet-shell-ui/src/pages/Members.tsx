import { useEffect, useState } from "react";
import { Page, Table, type TableColumn } from "@apralabs/apra-fleet-ui-kit";

// Shape mirrors the "member" entries list_members(format: "json") already
// returns (src/tools/list-members.ts) -- only the fields the S1/W1 table
// needs are declared here, no invented fields.
interface FleetMember extends Record<string, unknown> {
  id: string;
  name: string;
  type: string;
  llmProvider: string;
  llm_auth: string;
}

interface ListMembersResponse {
  members: FleetMember[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; members: FleetMember[] };

const columns: Array<TableColumn<FleetMember>> = [
  { key: "name", header: "Name" },
  {
    key: "type",
    header: "Type / Provider",
    render: (row) => `${row.type} / ${row.llmProvider}`
  },
  { key: "llm_auth", header: "Status" }
];

/**
 * S1 screen, minimal W1 table: fetches the registered members from the
 * same-origin API (relative URL, no hardcoded host/port) and renders them
 * through the ui-kit Table.
 */
export function Members() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/fleet/members");
        if (!response.ok) {
          throw new Error(`request failed with status ${response.status}`);
        }
        const data = (await response.json()) as ListMembersResponse;
        if (!cancelled) {
          setState({ kind: "loaded", members: data.members ?? [] });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "unknown error";
          setState({ kind: "error", message });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page title="Members" subtitle="Registered fleet members">
      {state.kind === "loading" ? <p>Loading members...</p> : null}
      {state.kind === "error" ? (
        <p role="alert">Failed to load members: {state.message}</p>
      ) : null}
      {state.kind === "loaded" ? (
        <Table
          columns={columns}
          rows={state.members}
          rowKey={(row) => row.id}
          emptyMessage="No members registered."
        />
      ) : null}
    </Page>
  );
}
