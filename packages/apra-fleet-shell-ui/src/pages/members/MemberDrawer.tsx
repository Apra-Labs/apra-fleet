import { useState } from "react";
import { Drawer, SelectField } from "@apralabs/apra-fleet-ui-kit";
import {
  composePermissions,
  fetchMemberDetail,
  provisionLlmAuth,
  provisionVcsAuth,
  removeMember,
  revokeVcsAuth,
  setupSshKey,
  updateLlmCli,
  type FleetMember,
  type MemberActionResult
} from "../../api/members";

/** Providers provision-vcs-auth/revoke-vcs-auth accept (provisionVcsAuthSchema /
 *  revokeVcsAuthSchema in src/tools/, both z.enum(['github','bitbucket','azure-devops'])
 *  with no .optional() -- a bare {member_id} body 400s before dispatch). */
const VCS_PROVIDERS = [
  { value: "github", label: "GitHub" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "azure-devops", label: "Azure DevOps" }
];

interface ActionDef {
  key: string;
  label: string;
  /** True when the action's schema requires a provider choice (provision-vcs-auth,
   *  revoke-vcs-auth) -- rendered as a SelectField ahead of the button. */
  needsProvider?: boolean;
  call: (memberId: string, provider: string) => Promise<MemberActionResult>;
}

const ACTIONS: ActionDef[] = [
  { key: "provision-llm-auth", label: "Provision LLM auth", call: provisionLlmAuth },
  { key: "provision-vcs-auth", label: "Provision VCS auth", needsProvider: true, call: provisionVcsAuth },
  { key: "revoke-vcs-auth", label: "Revoke VCS auth", needsProvider: true, call: revokeVcsAuth },
  { key: "setup-ssh-key", label: "Setup SSH key", call: setupSshKey },
  { key: "compose-permissions", label: "Compose permissions", call: composePermissions },
  { key: "update-llm-cli", label: "Update LLM CLI", call: updateLlmCli },
  { key: "remove", label: "Remove member", call: removeMember }
];

type ActionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; message: string; isError: boolean };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; detail: Record<string, unknown> }
  | { status: "error"; message: string };

/** member_detail values are arbitrary json (nested connectivity/cloud/
 *  tokenUsage objects) -- stringify anything non-primitive so no object is
 *  ever handed to React as a child. */
function detailValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface MemberDrawerProps {
  member: FleetMember | null;
  onClose: () => void;
}

/** Row-click drawer (S1/W1): member detail plus one control per fleet
 *  action, each hitting its own /api/fleet/ route. A tool error renders
 *  inline -- the drawer never closes itself on failure. */
export function MemberDrawer({ member, onClose }: MemberDrawerProps) {
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  // One provider choice per needsProvider action, defaulting to the first
  // VCS_PROVIDERS option so a plain button click always posts a valid body.
  const [providers, setProviders] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ACTIONS.filter((a) => a.needsProvider).map((a) => [a.key, VCS_PROVIDERS[0].value])
    )
  );

  if (!member) return null;
  const memberId = member.id;

  async function loadDetail() {
    setDetail({ status: "loading" });
    try {
      setDetail({ status: "loaded", detail: await fetchMemberDetail(memberId) });
    } catch (err) {
      setDetail({ status: "error", message: err instanceof Error ? err.message : "unknown error" });
    }
  }

  async function runAction(action: ActionDef) {
    setStates((prev) => ({ ...prev, [action.key]: { status: "loading" } }));
    try {
      const provider = providers[action.key] ?? VCS_PROVIDERS[0].value;
      const result = await action.call(memberId, provider);
      setStates((prev) => ({
        ...prev,
        [action.key]: { status: "done", message: result.text ?? "", isError: false }
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      setStates((prev) => ({
        ...prev,
        [action.key]: { status: "done", message, isError: true }
      }));
    }
  }

  return (
    <Drawer open title={member.name} subtitle={member.id} onClose={onClose}>
      <dl>
        <dt>Type</dt>
        <dd>{member.type}</dd>
        <dt>OS</dt>
        <dd>{member.os ?? "-"}</dd>
        <dt>Provider</dt>
        <dd>{member.llmProvider}</dd>
        <dt>Auth state</dt>
        <dd>{member.llm_auth}</dd>
      </dl>

      <section aria-label="Member detail" style={{ marginBottom: "16px" }}>
        <button type="button" onClick={() => void loadDetail()} disabled={detail.status === "loading"}>
          Show member detail
        </button>
        {detail.status === "loading" ? <span> working...</span> : null}
        {detail.status === "error" ? <p role="alert">{detail.message}</p> : null}
        {detail.status === "loaded" ? (
          <dl data-testid="member-detail">
            {Object.entries(detail.detail).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{detailValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {ACTIONS.map((action) => {
          const state = states[action.key] ?? { status: "idle" };
          return (
            <li key={action.key} style={{ marginBottom: "12px" }}>
              {action.needsProvider ? (
                <SelectField
                  label={`${action.label} provider`}
                  name={`${action.key}-provider`}
                  value={providers[action.key] ?? VCS_PROVIDERS[0].value}
                  onChange={(value) =>
                    setProviders((prev) => ({ ...prev, [action.key]: value }))
                  }
                  options={VCS_PROVIDERS}
                />
              ) : null}
              <button
                type="button"
                onClick={() => void runAction(action)}
                disabled={state.status === "loading"}
              >
                {action.label}
              </button>
              {state.status === "loading" ? <span> working...</span> : null}
              {state.status === "done" ? (
                <p role={state.isError ? "alert" : "status"}>{state.message}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}
