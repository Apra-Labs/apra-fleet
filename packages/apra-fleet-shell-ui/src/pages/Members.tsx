import { useEffect, useState } from "react";
import { Page, Table, type TableColumn } from "@apralabs/apra-fleet-ui-kit";
import { fetchMembers, formatOwner, type FleetMember } from "../api/members";
import { MemberDrawer } from "./members/MemberDrawer";
import { AddMemberWizard } from "./members/AddMemberWizard";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; members: FleetMember[] };

/** Background refresh cadence (risk 2): the table keeps showing the last
 *  fetched rows while a refresh is in flight, and only swaps them in once
 *  the new list resolves -- no flash back to the loading state. */
const REFRESH_INTERVAL_MS = 15000;

const columns: Array<TableColumn<FleetMember>> = [
  { key: "name", header: "Name" },
  { key: "os", header: "OS", render: (row) => row.os ?? "-" },
  { key: "shell", header: "Shell", render: (row) => row.shell ?? "-" },
  { key: "llmProvider", header: "Provider" },
  { key: "llm_auth", header: "Auth state" },
  {
    key: "tags",
    header: "Tags",
    render: (row) => (row.tags && row.tags.length > 0 ? row.tags.join(", ") : "-")
  },
  { key: "reservedBy", header: "Reserved by", render: (row) => row.reservedBy ?? "-" },
  { key: "owner", header: "Owner", render: (row) => formatOwner(row.owner) }
];

export interface MembersProps {
  /** Background refresh cadence override, for tests. Defaults to
   *  REFRESH_INTERVAL_MS. */
  refreshIntervalMs?: number;
}

/**
 * S1 screen, full W1 table: fetches the registered members from the
 * same-origin API, keeps refreshing them in the background, and opens a
 * detail/action drawer on row click plus an add-member wizard.
 */
export function Members({ refreshIntervalMs = REFRESH_INTERVAL_MS }: MembersProps = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<FleetMember | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function load(background: boolean) {
    try {
      const members = await fetchMembers();
      setState({ kind: "loaded", members });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      // A background refresh failure never replaces already-rendered rows
      // with an error screen -- only the initial load can do that (read via
      // the setState updater so this never depends on a stale closure).
      if (!background) {
        setState((prev) => (prev.kind === "loaded" ? prev : { kind: "error", message }));
      }
    }
  }

  useEffect(() => {
    void load(false);
    const interval = setInterval(() => {
      void load(true);
    }, refreshIntervalMs);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshIntervalMs]);

  return (
    <Page title="Members" subtitle="Registered fleet members">
      <div style={{ marginBottom: "16px" }}>
        <button type="button" onClick={() => setWizardOpen(true)}>
          Add member
        </button>
      </div>

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
          onRowClick={(row) => setSelected(row)}
        />
      ) : null}

      {/* keyed per member so action results / loaded detail never carry over
          from a previously opened member */}
      <MemberDrawer
        key={selected?.id ?? "none"}
        member={selected}
        onClose={() => setSelected(null)}
        onUpdated={() => void load(false)}
      />
      <AddMemberWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onRegistered={() => void load(false)} />
    </Page>
  );
}
