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
// The allowlist is DERIVED from REGISTERED_TOOL_NAMES by rule, not hand-listed:
//   - every tool whose name starts with a MEMBER_TOOL_PREFIXES entry (kb_*,
//     code_*) -- so a newly registered kb_/code_ tool (code_reindex,
//     code_status, ...) is member-allowed as soon as it is added to
//     REGISTERED_TOOL_NAMES;
//   - every name in MEMBER_EXPLICIT_TOOLS that is actually registered.
//     session_stats is listed there ahead of time: it becomes member-allowed
//     the moment it is registered (and added to REGISTERED_TOOL_NAMES), and is
//     simply absent until then -- no fake registration.

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
  'update_llm_cli', 'shutdown_server', 'version', 'compose_permissions',
  'cloud_control', 'monitor_task', 'stop_prompt', 'credential_store_set',
  'credential_store_list', 'credential_store_delete', 'credential_store_update',
  'send_email', 'send_message', 'report_status', 'respond_to_message',
  'code_graph', 'code_impact', 'code_query', 'code_context', 'code_map',
  'code_flow', 'code_tests',
  'kb_capture', 'kb_invalidate', 'kb_context', 'kb_session_prime', 'kb_query',
  'kb_list', 'kb_harvest', 'kb_promote', 'kb_freshness_sweep', 'kb_import',
  'kb_resolve_contradiction', 'kb_reconcile_prefilter', 'kb_setup', 'kb_export',
  'kb_stats', 'kb_feedback',
]);

/** Name prefixes whose every registered tool is member-allowed. */
export const MEMBER_TOOL_PREFIXES: readonly string[] = Object.freeze(['kb_', 'code_']);

/**
 * Individually member-allowed tool names (beyond the prefix rule). A name here
 * that is not registered is ignored by the derivation.
 */
export const MEMBER_EXPLICIT_TOOLS: readonly string[] = Object.freeze(['version', 'report_status', 'session_stats']);

/**
 * Tools granted ONLY to channel-capable (interactive, claude/channel) member
 * sessions, on top of the base allowlist. Not part of MEMBER_ALLOWED_TOOLS.
 */
export const MEMBER_CHANNEL_TOOLS: readonly string[] = Object.freeze(['respond_to_message']);

/** Rule check: is this tool name member-allowed (base allowlist rule)? */
export function isMemberAllowedTool(name: string): boolean {
  if (MEMBER_CHANNEL_TOOLS.includes(name)) return false;
  if (MEMBER_EXPLICIT_TOOLS.includes(name)) return true;
  return MEMBER_TOOL_PREFIXES.some(p => name.startsWith(p));
}

/** The base member allowlist: every registered tool the rule allows. */
export const MEMBER_ALLOWED_TOOLS: readonly string[] = Object.freeze(
  REGISTERED_TOOL_NAMES.filter(isMemberAllowedTool),
);

/**
 * The complement of MEMBER_ALLOWED_TOOLS: every registered tool a member
 * session may NOT use. Providers that support client-side deny rules (claude,
 * agy) deny exactly these on the member's apra-fleet MCP entry.
 */
export const MEMBER_DENIED_TOOLS: readonly string[] = Object.freeze(
  REGISTERED_TOOL_NAMES.filter(name => !MEMBER_ALLOWED_TOOLS.includes(name)),
);
