// Thin fetch wrapper over the /api/fleet/ console routes this page needs.
// Each page gets its own api module (apra-fleet-9h9j.2.1) so the members and
// secrets/health lanes never contend for one shared src/api/fleet.ts file.

/** Shape mirrors the "member" entries list_members(format: "json") returns
 *  (src/tools/list-members.ts) -- only the fields the S1/W1 table needs are
 *  declared here. `owner` is populated by a sibling sprint that owns
 *  src/tools/ -- absent today, rendered as "(none)" until it lands. `shell`
 *  is likewise not yet emitted by list_members; rendered as "-" when absent. */
export interface FleetMember extends Record<string, unknown> {
  id: string;
  name: string;
  type: string;
  os?: string;
  shell?: string;
  llmProvider: string;
  llm_auth: string;
  tags?: string[] | null;
  reservedBy?: string | null;
  owner?: string | null;
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

export function composePermissions(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/compose-permissions", { member_id: memberId });
}

export function updateLlmCli(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/update-llm-cli", { member_id: memberId });
}

export function removeMember(memberId: string): Promise<MemberActionResult> {
  return postJson("/api/fleet/remove-member", { member_id: memberId });
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
