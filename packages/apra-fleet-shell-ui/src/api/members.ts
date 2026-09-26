// Thin fetch wrapper over the /api/fleet/ console routes this page needs.
// Each page gets its own api module (apra-fleet-9h9j.2.1) so the members and
// secrets/health lanes never contend for one shared src/api/fleet.ts file.

/** list_members' owner tag: which package/consumer currently owns the member
 *  (Agent.owner in src/types.ts). An object, NOT a string -- rendering it
 *  directly as a React child throws and blanks the whole screen. */
export interface MemberOwner {
  package: string;
  ref: string;
}

/** The fields the shell-ui reads from each "member" entry list_members(format:
 *  "json") returns (src/tools/list-members.ts). Kept free of an index
 *  signature so memberFieldGuards below can be checked for completeness
 *  (keyof) -- FleetMember adds the index signature Table needs. Fields a
 *  given server build may not emit (owner/env/shell) are optional and
 *  render as "(none)"/"-". */
export interface FleetMemberFields {
  id: string;
  name: string;
  type: string;
  os?: string;
  shell?: string;
  llmProvider: string;
  llm_auth: string;
  tags?: string[] | null;
  reservedBy?: string | null;
  owner?: MemberOwner | null;
  env?: Record<string, string> | null;
  vcsTokenExpiresAt?: string | null;
  /** Permission mode for unattended execution (Agent.unattended in src/types.ts).
   *  Optional here even though list_members/member_detail always emit a concrete
   *  value (apra-fleet-i9ag.6.3) -- keeps the field readable against an older
   *  server build that predates it, same as the rest of this interface's
   *  "server may not emit" fields. */
  unattended?: false | "auto" | "dangerous";
}

export interface FleetMember extends FleetMemberFields, Record<string, unknown> {}

const isString = (v: unknown): v is string => typeof v === "string";
const optional = (guard: (v: unknown) => boolean) => (v: unknown) =>
  v === undefined || v === null || guard(v);

export function isMemberOwner(v: unknown): v is MemberOwner {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    isString((v as { package?: unknown }).package) &&
    isString((v as { ref?: unknown }).ref)
  );
}

/** Runtime shape check per declared field. The drift guard
 *  (test/list-members-drift.test.tsx) runs these against the REAL server
 *  list_members json output; the mapped type makes tsc (npm run build:ui)
 *  fail if a field is added to FleetMemberFields without a guard. */
export const memberFieldGuards: { [K in keyof FleetMemberFields]-?: (v: unknown) => boolean } = {
  id: isString,
  name: isString,
  type: isString,
  os: optional(isString),
  shell: optional(isString),
  llmProvider: isString,
  llm_auth: isString,
  tags: optional((v) => Array.isArray(v) && v.every(isString)),
  reservedBy: optional(isString),
  owner: optional(isMemberOwner),
  env: optional(
    (v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isString)
  ),
  vcsTokenExpiresAt: optional(isString),
  unattended: optional((v) => v === false || v === "auto" || v === "dangerous")
};

/** Display form of the owner tag: "<package>@<ref>", or "(none)". A
 *  malformed value renders "(none)" rather than crashing the table. */
export function formatOwner(owner: unknown): string {
  return isMemberOwner(owner) ? `${owner.package}@${owner.ref}` : "(none)";
}

interface ListMembersResponse {
  members: FleetMember[];
}

/** Generic result envelope every /api/fleet/ POST route answers with on
 *  success: prose in `text`, an optional machine-readable half in
 *  `structuredContent` (src/console/routes/fleet.ts sendToolResult). */
export interface MemberActionResult {
  text: string;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

async function postJson(path: string, body: unknown): Promise<MemberActionResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const errorText =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `request failed with status ${response.status}`;
    throw new Error(errorText);
  }
  return (data ?? { text: "" }) as MemberActionResult;
}

/** GET the current member list. Used for both the initial load and the
 *  background refresh -- callers decide how to fold a successful result into
 *  their own render state. */
export async function fetchMembers(): Promise<FleetMember[]> {
  const response = await fetch("/api/fleet/members");
  if (!response.ok) {
    throw new Error(`request failed with status ${response.status}`);
  }
  const data = (await response.json()) as ListMembersResponse;
  return data.members ?? [];
}

// ---------------------------------------------------------------------------
// Drawer actions -- one call per action button, each hitting its own route.
// ---------------------------------------------------------------------------

/** POST /api/fleet/member-detail (format json). On success the route writes
 *  member_detail's json object through unparsed; a non-json tool answer
 *  (e.g. "member not found" prose) arrives as the {text} envelope instead.
 *  Either way the caller gets a plain object back. */
export async function fetchMemberDetail(memberId: string): Promise<Record<string, unknown>> {
  return (await postJson("/api/fleet/member-detail", {
    member_id: memberId,
    format: "json"
  })) as Record<string, unknown>;
}

export function provisionLlmAuth(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/provision-llm-auth", { member_id: memberId });
}

/** provider is REQUIRED by provisionVcsAuthSchema (src/tools/provision-vcs-auth.ts) --
 *  a bare {member_id} body 400s before dispatch (routes/fleet.ts), so the caller
 *  must always thread a provider choice through. */
export function provisionVcsAuth(memberId: string, provider: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/provision-vcs-auth", { member_id: memberId, provider });
}

/** provider is REQUIRED by revokeVcsAuthSchema (src/tools/revoke-vcs-auth.ts) --
 *  see provisionVcsAuth's note above. */
export function revokeVcsAuth(memberId: string, provider: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/revoke-vcs-auth", { member_id: memberId, provider });
}

export function setupSshKey(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/setup-ssh-key", { member_id: memberId });
}

/** Widened per apra-fleet-i9ag.6.2.1: composePermissionsSchema (src/tools/
 *  compose-permissions.ts) has NO .refine() -- role and tags are both plain
 *  .optional(), so the "at least one of role or tags" rule must be enforced
 *  CLIENT-SIDE (the caller-facing guard lives in MemberDrawer, not here).
 *  Every field is optional and should be OMITTED from the body when empty --
 *  callers must not pass "" or [] for an unset field. */
export interface ComposePermissionsBody {
  role?: "doer" | "reviewer";
  tags?: string[];
  grant?: string[];
  grant_reason?: string;
}

export function composePermissions(
  memberId: string,
  body: ComposePermissionsBody = {}
): Promise<MemberActionResult> {
  return postJson("/api/fleet/compose-permissions", { member_id: memberId, ...body });
}

export function updateLlmCli(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/update-llm-cli", { member_id: memberId });
}

export function removeMember(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/remove-member", { member_id: memberId });
}

/** The deliberately-scoped subset of updateMemberSchema (src/tools/update-member.ts)
 *  the drawer's edit form exposes (apra-fleet-i9ag.6.1). password, rotate_password,
 *  key_path, cloud_* and model_* are excluded -- see the parent feature for why.
 *  Every field is optional and MUST be omitted (not sent as "" or []) unless the
 *  operator actually changed it: a non-empty `tags` REPLACES the existing tag
 *  list and an empty `tags` array CLEARS it, so sending an untouched tags value
 *  back would silently rewrite it on every save. */
export interface UpdateMemberBody {
  friendly_name?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  unattended?: "false" | "auto" | "dangerous";
  llm_provider?: "claude" | "codex" | "copilot" | "agy" | "opencode";
  host?: string;
  port?: number;
  username?: string;
}

export function updateMember(memberId: string, body: UpdateMemberBody): Promise<MemberActionResult> {
  return postJson("/api/fleet/update-member", { member_id: memberId, ...body });
}

// ---------------------------------------------------------------------------
// Add-member wizard submission.
// ---------------------------------------------------------------------------

/** Mirrors the register_member option shape the console route validates
 *  against (registerMemberSchema, packages/apra-fleet-client's
 *  RegisterMemberOptions) -- only the fields the wizard collects. */
export interface RegisterMemberBody {
  friendly_name: string;
  work_folder: string;
  member_type: "local" | "remote";
  llm_provider?: string;
  host?: string;
  port?: number;
  username?: string;
  auth_type?: "password" | "key";
  password?: string;
  key_path?: string;
  shell?: "gitbash" | "pwsh7" | "powershell5";
}

export function registerMember(body: RegisterMemberBody): Promise<MemberActionResult> {
  return postJson("/api/fleet/register-member", body);
}
