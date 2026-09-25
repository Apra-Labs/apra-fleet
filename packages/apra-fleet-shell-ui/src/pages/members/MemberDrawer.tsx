import { useState } from "react";
import { Drawer, SelectField, TextField } from "@apralabs/apra-fleet-ui-kit";
import {
  composePermissions,
  fetchMemberDetail,
  provisionLlmAuth,
  provisionVcsAuth,
  removeMember,
  revokeVcsAuth,
  setupSshKey,
  updateLlmCli,
  updateMember,
  type ComposePermissionsBody,
  type FleetMember,
  type MemberActionResult,
  type UpdateMemberBody
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

// Compose permissions is NOT a generic ACTIONS entry (apra-fleet-i9ag.6.2.1):
// every ACTIONS entry is a bare button whose call signature is (memberId,
// provider), but compose needs four operator-supplied values (role, tags,
// grant, grant reason), so it gets its own section below with real inputs.
const ACTIONS: ActionDef[] = [
  { key: "provision-llm-auth", label: "Provision LLM auth", call: provisionLlmAuth },
  { key: "provision-vcs-auth", label: "Provision VCS auth", needsProvider: true, call: provisionVcsAuth },
  { key: "revoke-vcs-auth", label: "Revoke VCS auth", needsProvider: true, call: revokeVcsAuth },
  { key: "setup-ssh-key", label: "Setup SSH key", call: setupSshKey },
  { key: "update-llm-cli", label: "Update LLM CLI", call: updateLlmCli },
  { key: "remove", label: "Remove member", call: removeMember }
];

/** doer/reviewer role options for compose-permissions -- role is optional
 *  (composePermissionsSchema has no .refine(); the "at least one of role or
 *  tags" rule is enforced client-side below), so an empty choice is valid
 *  when tags alone are supplied. */
const COMPOSE_ROLE_OPTIONS = [
  { value: "", label: "(none)" },
  { value: "doer", label: "Doer" },
  { value: "reviewer", label: "Reviewer" }
];

/** llm_provider choices updateMemberSchema accepts (src/tools/update-member.ts) --
 *  narrower than register_member's list: no "none" here. */
const LLM_PROVIDER_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "agy", label: "Agy" },
  { value: "opencode", label: "Opencode" }
];

/** "" is the baseline/sentinel value, NOT a postable choice. list_members and
 *  member_detail now surface Agent.unattended (apra-fleet-i9ag.6.3), so the
 *  select below normally pre-fills the member's real current mode -- "" only
 *  remains reachable as a fallback against an older server build whose
 *  payload predates the field (see initialEditState below). Only an operator
 *  picking one of the three real options makes it dirty and postable --
 *  selecting "false" explicitly reaches update-member's "reset to
 *  interactive prompts" path. */
const UNATTENDED_OPTIONS = [
  { value: "", label: "(unchanged - not reported by the server)" },
  { value: "false", label: "Interactive (false)" },
  { value: "auto", label: "Auto-approve safe ops (auto)" },
  { value: "dangerous", label: "Skip all checks (dangerous)" }
];

interface EditFormState {
  friendlyName: string;
  category: string;
  tagsText: string;
  icon: string;
  unattended: "" | "false" | "auto" | "dangerous";
  llmProvider: string;
  host: string;
  port: string;
  username: string;
}

/** list_members'/member_detail's raw fields the shell-ui does not (yet) declare
 *  in FleetMemberFields -- read loosely through FleetMember's index signature
 *  rather than widening the drift-guarded interface for a display-only read. */
function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** formatAgentHost (src/utils/agent-helpers.ts) emits a combined "host:port"
 *  string for a remote member -- list_members has no separate raw host/port
 *  field. Split on the LAST ':' so a bare hostname/IPv4 host survives; a
 *  literal IPv6 host (itself containing colons) is a known, narrow gap --
 *  register_member's own host input has no IPv6 affordance either. */
function splitHostPort(combined: string): { host: string; port: string } {
  const idx = combined.lastIndexOf(":");
  if (idx === -1) return { host: combined, port: "" };
  return { host: combined.slice(0, idx), port: combined.slice(idx + 1) };
}

function initialEditState(member: FleetMember | null): EditFormState {
  const combinedHost = member ? rawString(member.host) : "";
  const { host, port } = member?.type === "remote" ? splitHostPort(combinedHost) : { host: "", port: "" };
  return {
    friendlyName: member?.name ?? "",
    category: member ? rawString(member.category) : "",
    tagsText: (member?.tags ?? []).join(", "),
    icon: member ? rawString(member.icon) : "",
    // Agent.unattended (src/types.ts) is surfaced by list_members/member_detail
    // as a real false|"auto"|"dangerous" value (apra-fleet-i9ag.6.3) -- pre-fill
    // the select from it so the form shows the member's actual current mode.
    // "" (the "unchanged - not reported by the server" sentinel, see
    // UNATTENDED_OPTIONS) is only reachable when member.unattended is
    // undefined, i.e. an older server build whose payload predates this field.
    unattended:
      member?.unattended === undefined ? "" : member.unattended === false ? "false" : member.unattended,
    llmProvider: member?.llmProvider ?? "",
    host,
    port,
    username: member ? rawString(member.username) : ""
  };
}

function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Builds the update_member body from the edit form's CURRENT state against
 *  the member's baseline (re-derived from `member`, not stored separately --
 *  MemberDrawer remounts fresh per selected member, so the baseline is stable
 *  for the component's lifetime). Returns null when nothing changed. Every
 *  field is included ONLY when it actually differs from the baseline --
 *  sending an untouched field back would rewrite it (and, for tags, replace
 *  or clear the existing list) on every submit. */
function buildUpdateBody(member: FleetMember, state: EditFormState): UpdateMemberBody | null {
  const baseline = initialEditState(member);
  const body: UpdateMemberBody = {};
  let dirty = false;

  if (state.friendlyName !== baseline.friendlyName) {
    body.friendly_name = state.friendlyName;
    dirty = true;
  }
  if (state.category !== baseline.category) {
    body.category = state.category;
    dirty = true;
  }
  const newTags = state.tagsText.split(",").map((t) => t.trim()).filter(Boolean);
  if (!tagsEqual(newTags, member.tags ?? [])) {
    body.tags = newTags;
    dirty = true;
  }
  const trimmedIcon = state.icon.trim();
  if (trimmedIcon && trimmedIcon !== baseline.icon) {
    body.icon = trimmedIcon;
    dirty = true;
  }
  // baseline.unattended is now usually the member's real reported mode (see
  // initialEditState), so this only fires when the operator actually changes
  // the selection away from it -- state.unattended can still be "" here (the
  // untouched sentinel) only when the server never reported a value, and "" is
  // never a postable UpdateMemberBody["unattended"] value, so that case can
  // never make it past this !== check into a dirty body.
  if (state.unattended !== baseline.unattended && state.unattended !== "") {
    body.unattended = state.unattended as UpdateMemberBody["unattended"];
    dirty = true;
  }
  if (state.llmProvider !== baseline.llmProvider) {
    body.llm_provider = state.llmProvider as UpdateMemberBody["llm_provider"];
    dirty = true;
  }
  if (member.type === "remote") {
    if (state.host !== baseline.host) {
      body.host = state.host;
      dirty = true;
    }
    if (state.port !== baseline.port) {
      body.port = Number(state.port);
      dirty = true;
    }
    if (state.username !== baseline.username) {
      body.username = state.username;
      dirty = true;
    }
  }

  return dirty ? body : null;
}

interface ComposeFormState {
  role: "" | "doer" | "reviewer";
  tagsText: string;
  grantText: string;
  grantReason: string;
}

const COMPOSE_INITIAL_STATE: ComposeFormState = { role: "", tagsText: "", grantText: "", grantReason: "" };

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
  /** Called after a successful update_member submit so the caller can
   *  re-fetch the members list (apra-fleet-i9ag.6.1). */
  onUpdated: () => void;
}

/** Row-click drawer (S1/W1): member detail plus one control per fleet
 *  action, each hitting its own /api/fleet/ route. A tool error renders
 *  inline -- the drawer never closes itself on failure. */
export function MemberDrawer({ member, onClose, onUpdated }: MemberDrawerProps) {
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  // One provider choice per needsProvider action, defaulting to the first
  // VCS_PROVIDERS option so a plain button click always posts a valid body.
  const [providers, setProviders] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ACTIONS.filter((a) => a.needsProvider).map((a) => [a.key, VCS_PROVIDERS[0].value])
    )
  );
  // MemberDrawer is re-keyed per selected member (Members.tsx), so this
  // initializer only runs once for the currently-open member -- it is the
  // dirty-diff baseline for the whole life of this mount.
  const [editState, setEditState] = useState<EditFormState>(() => initialEditState(member));
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editResult, setEditResult] = useState<{ message: string; isError: boolean } | null>(null);
  const [composeState, setComposeState] = useState<ComposeFormState>(COMPOSE_INITIAL_STATE);
  const [composeSubmitting, setComposeSubmitting] = useState(false);
  const [composeResult, setComposeResult] = useState<{ message: string; isError: boolean } | null>(null);

  if (!member) return null;
  // Re-bound to a plain const so nested function declarations below keep the
  // non-null narrowing (TS does not carry a parameter's narrowed type across
  // a function-declaration closure boundary).
  const currentMember: FleetMember = member;
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

  function updateEditField<K extends keyof EditFormState>(key: K, value: EditFormState[K]) {
    setEditState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleEditSubmit() {
    const body = buildUpdateBody(currentMember, editState);
    if (!body) {
      setEditResult({ message: "No changes to submit.", isError: true });
      return;
    }
    setEditSubmitting(true);
    setEditResult(null);
    try {
      const result = await updateMember(memberId, body);
      setEditResult({ message: result.text ?? "", isError: false });
      onUpdated();
    } catch (err) {
      setEditResult({ message: err instanceof Error ? err.message : "unknown error", isError: true });
    } finally {
      setEditSubmitting(false);
    }
  }

  function updateComposeField<K extends keyof ComposeFormState>(key: K, value: ComposeFormState[K]) {
    setComposeState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleComposeSubmit() {
    const tags = composeState.tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    const role = composeState.role || undefined;
    // composePermissionsSchema has no .refine() -- a bare body with neither
    // role nor tags answers HTTP 200 with a prose "provide at least one..."
    // string (isToolFailure treats a bare string as success), so this guard
    // must run client-side and issue NO fetch at all.
    if (!role && tags.length === 0) {
      setComposeResult({
        message: "Provide at least one of role or tags to compose permissions.",
        isError: true
      });
      return;
    }
    const grant = composeState.grantText.split(",").map((g) => g.trim()).filter(Boolean);
    const body: ComposePermissionsBody = {};
    if (role) body.role = role;
    if (tags.length > 0) body.tags = tags;
    if (grant.length > 0) body.grant = grant;
    if (composeState.grantReason.trim()) body.grant_reason = composeState.grantReason.trim();

    setComposeSubmitting(true);
    setComposeResult(null);
    try {
      // A NEVER_AUTO_GRANT refusal arrives as an HTTP 200 {text} envelope, not
      // a thrown error (composePermissions returns a plain string and
      // isToolFailure ignores strings) -- render it verbatim on the success
      // path exactly like any other result.
      const result = await composePermissions(memberId, body);
      setComposeResult({ message: result.text ?? "", isError: false });
    } catch (err) {
      setComposeResult({ message: err instanceof Error ? err.message : "unknown error", isError: true });
    } finally {
      setComposeSubmitting(false);
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

      <section aria-label="Edit member" style={{ marginBottom: "16px" }}>
        <h3>Edit member</h3>
        <TextField
          label="Friendly name"
          name="edit-friendly-name"
          value={editState.friendlyName}
          onChange={(v) => updateEditField("friendlyName", v)}
        />
        <TextField
          label="Category"
          name="edit-category"
          value={editState.category}
          onChange={(v) => updateEditField("category", v)}
        />
        <TextField
          label="Tags (comma-separated)"
          name="edit-tags"
          value={editState.tagsText}
          onChange={(v) => updateEditField("tagsText", v)}
        />
        <TextField
          label="Icon"
          name="edit-icon"
          value={editState.icon}
          onChange={(v) => updateEditField("icon", v)}
        />
        <SelectField
          label="Unattended mode"
          name="edit-unattended"
          value={editState.unattended}
          onChange={(v) => updateEditField("unattended", v as EditFormState["unattended"])}
          options={UNATTENDED_OPTIONS}
        />
        <SelectField
          label="LLM provider"
          name="edit-llm-provider"
          value={editState.llmProvider}
          onChange={(v) => updateEditField("llmProvider", v)}
          options={LLM_PROVIDER_OPTIONS}
        />
        {member.type === "remote" ? (
          <>
            <TextField label="Host" name="edit-host" value={editState.host} onChange={(v) => updateEditField("host", v)} />
            <TextField
              label="Port"
              name="edit-port"
              type="number"
              value={editState.port}
              onChange={(v) => updateEditField("port", v)}
            />
            <TextField
              label="Username"
              name="edit-username"
              value={editState.username}
              onChange={(v) => updateEditField("username", v)}
            />
          </>
        ) : null}
        <button type="button" onClick={() => void handleEditSubmit()} disabled={editSubmitting}>
          Save changes
        </button>
        {editSubmitting ? <span> working...</span> : null}
        {editResult ? <p role={editResult.isError ? "alert" : "status"}>{editResult.message}</p> : null}
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

      <section aria-label="Compose permissions" style={{ marginTop: "16px" }}>
        <h3>Compose permissions</h3>
        <SelectField
          label="Role"
          name="compose-role"
          value={composeState.role}
          onChange={(v) => updateComposeField("role", v as ComposeFormState["role"])}
          options={COMPOSE_ROLE_OPTIONS}
        />
        <TextField
          label="Tags (comma-separated)"
          name="compose-tags"
          value={composeState.tagsText}
          onChange={(v) => updateComposeField("tagsText", v)}
        />
        <TextField
          label="Grant (comma-separated)"
          name="compose-grant"
          value={composeState.grantText}
          onChange={(v) => updateComposeField("grantText", v)}
        />
        <TextField
          label="Grant reason"
          name="compose-grant-reason"
          value={composeState.grantReason}
          onChange={(v) => updateComposeField("grantReason", v)}
        />
        <button type="button" onClick={() => void handleComposeSubmit()} disabled={composeSubmitting}>
          Compose permissions
        </button>
        {composeSubmitting ? <span> working...</span> : null}
        {composeResult ? <p role={composeResult.isError ? "alert" : "status"}>{composeResult.message}</p> : null}
      </section>
    </Drawer>
  );
}
