/**
 * In-process facade over the fleet tool handlers (apra-fleet-v6t7.2.1).
 *
 * Console route modules call THIS, never the MCP wire: no HTTP self-call back
 * into the server's own /mcp endpoint, no spawned client, no child process.
 * The console runs inside the same process that owns the registry, so a
 * round trip would only buy latency, a second failure mode, and an auth
 * boundary we would then have to punch a hole through.
 *
 * Each function here is a thin adapter: pick the tool handler, pin the
 * machine-readable output format, return the payload. Shaping/formatting for
 * a specific screen belongs in the route module, not here.
 *
 * ADAPTER RULES (apra-fleet-9h9j.1.1, when the other 17 landed):
 *  - One exported adapter per tool, importing the tool handler DIRECTLY from
 *    ../tools/<file>.js. Never reach into the MCP registration layer.
 *  - No validation here -- the route validates the body before calling in.
 *  - No response shaping, no field whitelisting, no error mapping here --
 *    all of that is the route's job (see ./routes/fleet.ts).
 *  - Keeping every adapter a one-liner is what lets a test vi.mock the
 *    underlying ../tools/* module and have the whole route exercised.
 */
import { listMembers } from '../tools/list-members.js';
import { memberDetail, type MemberDetailInput } from '../tools/member-detail.js';
import { registerMember, type RegisterMemberInput } from '../tools/register-member.js';
import { updateMember, type UpdateMemberInput } from '../tools/update-member.js';
import { removeMember, type RemoveMemberInput } from '../tools/remove-member.js';
import { setupSSHKey, type SetupSSHKeyInput } from '../tools/setup-ssh-key.js';
import { provisionAuth, type ProvisionAuthInput, type ProvisionAuthResult } from '../tools/provision-auth.js';
import { provisionVcsAuth, type ProvisionVcsAuthInput, type ProvisionVcsAuthResult } from '../tools/provision-vcs-auth.js';
import { revokeVcsAuth, type RevokeVcsAuthInput } from '../tools/revoke-vcs-auth.js';
import { composePermissions, type ComposePermissionsInput } from '../tools/compose-permissions.js';
import { updateAgentCli, type UpdateAgentCliInput } from '../tools/update-agent-cli.js';
import { credentialStoreSet, type CredentialStoreSetInput, type CredentialStoreSetToolResult } from '../tools/credential-store-set.js';
import { credentialStoreList } from '../tools/credential-store-list.js';
import { credentialStoreUpdate, type CredentialStoreUpdateInput } from '../tools/credential-store-update.js';
import { credentialStoreDelete, type CredentialStoreDeleteInput } from '../tools/credential-store-delete.js';
import { setupGitApp, type SetupGitAppInput } from '../tools/setup-git-app.js';
import { fleetStatus, type FleetStatusInput } from '../tools/check-status.js';
import { version } from '../tools/version.js';
import { executeCommand, type ExecuteCommandInput, type ExecuteCommandResult } from '../tools/execute-command.js';

/**
 * The list_members tool's json payload, as a JSON string (exactly what the
 * tool produces -- parsing and re-stringifying it here would only risk
 * drifting from the tool's own contract).
 */
export async function getMembersJson(tags?: string[]): Promise<string> {
  return await listMembers({ format: 'json', tags });
}

/** member_detail. Returns the tool's JSON string when format is "json". */
export async function runMemberDetail(input: MemberDetailInput): Promise<string> {
  return await memberDetail(input);
}

/** register_member. */
export async function runRegisterMember(input: RegisterMemberInput): Promise<string> {
  return await registerMember(input);
}

/** update_member. */
export async function runUpdateMember(input: UpdateMemberInput): Promise<string> {
  return await updateMember(input);
}

/** remove_member. */
export async function runRemoveMember(input: RemoveMemberInput): Promise<string> {
  return await removeMember(input);
}

/** setup_ssh_key (tool export is setupSSHKey, not setupSshKey). */
export async function runSetupSshKey(input: SetupSSHKeyInput): Promise<string> {
  return await setupSSHKey(input);
}

/** provision_llm_auth (tool export is provisionAuth). */
export async function runProvisionLlmAuth(input: ProvisionAuthInput): Promise<ProvisionAuthResult> {
  return await provisionAuth(input);
}

/** provision_vcs_auth. */
export async function runProvisionVcsAuth(input: ProvisionVcsAuthInput): Promise<ProvisionVcsAuthResult> {
  return await provisionVcsAuth(input);
}

/** revoke_vcs_auth. */
export async function runRevokeVcsAuth(input: RevokeVcsAuthInput): Promise<string> {
  return await revokeVcsAuth(input);
}

/** compose_permissions. */
export async function runComposePermissions(input: ComposePermissionsInput): Promise<string> {
  return await composePermissions(input);
}

/** update_llm_cli (tool export is updateAgentCli). */
export async function runUpdateLlmCli(input: UpdateAgentCliInput): Promise<string> {
  return await updateAgentCli(input);
}

/** credential_store_set. The route always pins return_url, never this adapter. */
export async function runCredentialStoreSet(
  input: CredentialStoreSetInput,
): Promise<string | CredentialStoreSetToolResult> {
  return await credentialStoreSet(input);
}

/** credential_store_list. Returns a JSON string of metadata-only entries. */
export async function runCredentialStoreList(): Promise<string> {
  return await credentialStoreList();
}

/** credential_store_update. */
export async function runCredentialStoreUpdate(input: CredentialStoreUpdateInput): Promise<string> {
  return await credentialStoreUpdate(input);
}

/** credential_store_delete. */
export async function runCredentialStoreDelete(input: CredentialStoreDeleteInput): Promise<string> {
  return await credentialStoreDelete(input);
}

/** setup_git_app. */
export async function runSetupGitApp(input: SetupGitAppInput): Promise<string> {
  return await setupGitApp(input);
}

/** fleet_status (tool export is fleetStatus, in check-status.ts). */
export async function runFleetStatus(input: FleetStatusInput): Promise<string> {
  return await fleetStatus(input);
}

/** version. */
export async function runVersion(): Promise<string> {
  return await version();
}

/** execute_command. */
export async function runExecuteCommand(
  input: ExecuteCommandInput,
): Promise<string | ExecuteCommandResult> {
  return await executeCommand(input);
}
