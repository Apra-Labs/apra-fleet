// Single source of truth for which fleet MCP tools a MEMBER session may see.
//
// A member session (an MCP connection identified as a registered fleet member,
// e.g. via ?member=<uuid> or a member JWT) is given a reduced tool list: the
// knowledge-bank and code-intelligence tools plus a few self-reporting tools.
// Everything that drives OTHER members or administers the fleet (execute_prompt,
// execute_command, stop_prompt, send_files, receive_files, member/credential/
// admin/shutdown tools) is excluded by omission.
//
// This module is deliberately dependency-free so it can be imported from the
// built dist (dist/services/member-tool-allowlist.js) by a plain Node .mjs test
// without a hardcoded copy of the list.
//
// The member lists are EXPLICIT, not derived by name prefix: a newly registered
// kb_ or code_ tool is NOT member-visible until it is added here on purpose.
// (The unit test that enumerates tool-registry.ts keeps REGISTERED_TOOL_NAMES
// complete, and a test asserts every kb_/code_ tool is classified below.)
//
// KB write policy (owner decision 2026-10-06):
//   - kb_setup (writes the machine-wide provider config and stores credentials)
//     and kb_export (auto-commits into the work tree) are NEVER served to a
//     member session -- not in any list below.
//   - kb_promote and kb_resolve_contradiction mint CONFIRMED. They are served
//     only to the repository's kb_maintainer member session, i.e. a member
//     session opened with the engine's kb_maintainer grant (see
//     MEMBER_MAINTAINER_TOOLS and src/services/tool-scope.ts). Every other
//     member session -- including a role agent dispatched on the maintainer
//     member, which connects through the plain per-folder ?member= entry --
//     does not see them.
//   - kb_demote lowers CONFIRMED to INFERRED. It is served on the same terms
//     as kb_promote (kb_maintainer session only): the engine applies every
//     reviewer demotion through the maintainer session, and no role agent
//     needs to call it directly.

/**
 * Every tool name registered by registerAllTools (src/services/tool-registry.ts).
 * Kept in sync by a unit test that enumerates the registry's server.tool(...)
 * calls; adding a tool there without adding it here fails that test.
 */
export const REGISTERED_TOOL_NAMES: readonly string[] = Object.freeze([
  'register_member', 'list_members', 'get_member_model_pricing', 'remove_member',
  'update_member', 'dolt_push_mutex', 'child_id_allocator', 'member_reservation',
  'send_files', 'receive_files', 'execute_prompt', 'execute_command',
  'provision_llm_auth', 'setup_ssh_key', 'setup_git_app', 'provision_vcs_auth',
  'revoke_vcs_auth', 'vcs_credential_exec', 'fleet_status', 'member_detail',
  'update_llm_cli', 'shutdown_server', 'version', 'session_stats', 'compose_permissions',
  'cloud_control', 'monitor_task', 'stop_prompt', 'credential_store_set',
  'credential_store_list', 'credential_store_delete', 'credential_store_update',
  'send_email', 'send_message', 'report_status', 'respond_to_message',
  'code_graph', 'code_impact', 'code_query', 'code_context', 'code_map',
  'code_flow', 'code_tests', 'code_reindex', 'code_status',
  'kb_capture', 'kb_invalidate', 'kb_context', 'kb_session_prime', 'kb_query',
  'kb_list', 'kb_harvest', 'kb_promote', 'kb_demote', 'kb_freshness_sweep', 'kb_import',
  'kb_resolve_contradiction', 'kb_reconcile_prefilter', 'kb_setup', 'kb_export',
  'kb_stats', 'kb_feedback', 'kb_bible_commit',
]);

/**
 * Name prefixes of the member tool families. NOT an allow rule: membership is
 * the explicit MEMBER_BASE_TOOLS list. Used to pick the kb_ and code_ tools
 * out of an allowlist (e.g. the role-agent MCP grants in agent-transform.ts).
 */
export const MEMBER_TOOL_PREFIXES: readonly string[] = Object.freeze(['kb_', 'code_']);

/**
 * Every tool a member session is served (the base member allowlist, before
 * registration filtering). Explicit by design -- see the header.
 */
export const MEMBER_BASE_TOOLS: readonly string[] = Object.freeze([
  'version', 'report_status', 'session_stats',
  'code_graph', 'code_impact', 'code_query', 'code_context', 'code_map',
  'code_flow', 'code_tests', 'code_reindex', 'code_status',
  'kb_capture', 'kb_invalidate', 'kb_context', 'kb_session_prime', 'kb_query',
  'kb_list', 'kb_harvest', 'kb_freshness_sweep', 'kb_import',
  'kb_reconcile_prefilter', 'kb_stats', 'kb_feedback', 'kb_bible_commit',
]);

/**
 * Tools served ONLY to a kb_maintainer member session (the engine's grant), on
 * top of the base allowlist. They mint CONFIRMED, or (kb_demote) withdraw it. Not part of
 * MEMBER_ALLOWED_TOOLS, so client-side deny rules keep them denied for every
 * agent session on a member.
 */
export const MEMBER_MAINTAINER_TOOLS: readonly string[] = Object.freeze(['kb_promote', 'kb_demote', 'kb_resolve_contradiction']);

/**
 * kb_ tools no member session is ever served, whatever its grants. Listed so
 * the classification of every kb_ tool is explicit (and test-checked).
 */
export const MEMBER_NEVER_TOOLS: readonly string[] = Object.freeze(['kb_setup', 'kb_export']);

/**
 * Tools granted ONLY to channel-capable (interactive, claude/channel) member
 * sessions, on top of the base allowlist. Not part of MEMBER_ALLOWED_TOOLS.
 */
export const MEMBER_CHANNEL_TOOLS: readonly string[] = Object.freeze(['respond_to_message']);

/** Is this tool name in the base member allowlist? */
export function isMemberAllowedTool(name: string): boolean {
  return MEMBER_BASE_TOOLS.includes(name);
}

/** Is this tool served only to a kb_maintainer member session? */
export function isMemberMaintainerTool(name: string): boolean {
  return MEMBER_MAINTAINER_TOOLS.includes(name);
}

/** The base member allowlist: every registered tool in MEMBER_BASE_TOOLS. */
export const MEMBER_ALLOWED_TOOLS: readonly string[] = Object.freeze(
  REGISTERED_TOOL_NAMES.filter(isMemberAllowedTool),
);

/**
 * The complement of MEMBER_ALLOWED_TOOLS: every registered tool a member
 * session may NOT use. Providers that support client-side deny rules (claude,
 * agy) deny exactly these on the member's apra-fleet MCP entry. This includes
 * MEMBER_MAINTAINER_TOOLS: an agent session on a member never carries the
 * kb_maintainer grant (only the engine's own member calls do).
 */
export const MEMBER_DENIED_TOOLS: readonly string[] = Object.freeze(
  REGISTERED_TOOL_NAMES.filter(name => !MEMBER_ALLOWED_TOOLS.includes(name)),
);
