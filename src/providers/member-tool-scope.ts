/**
 * THE single definition of what a member's own apra-fleet MCP server may and may
 * not be asked to do, plus one renderer per provider rule syntax
 * (apra-fleet-b4g.23.1).
 *
 * Every member runs its OWN apra-fleet over local stdio (see
 * src/services/member-fleet-install.ts). That server registers the same tool
 * surface the orchestrator's does, which colocates harmless read-only KB and
 * code-intelligence tools with destructive fleet-admin ones (remove_member,
 * shutdown_server, credential_store_*, execute_prompt, ...). A member therefore
 * needs a per-TOOL allowlist, not a per-server one: enabling the server without
 * it would hand every member full fleet-admin authority.
 *
 * WHY THE LISTS LIVE HERE AND NOT IN agy.ts
 *
 * They were `AGY_MEMBER_ALLOWED_TOOLS` / `AGY_ORCHESTRATOR_DENIED_TOOLS` in
 * src/providers/agy.ts, which was the only provider that scoped MCP tools. Now
 * Claude needs the identical logical allowlist in its own syntax. Duplicating
 * the arrays would mean a newly registered tool could be added to one copy and
 * silently omitted from the other -- and the tripwire in
 * tests/unit/agy-provider-fixes.test.ts (every tool in src/services/tool-registry.ts
 * sits in exactly one of the two lists) would only police the copy it imports.
 * So the arrays live here once and agy.ts re-exports its historical names as
 * aliases of these, which keeps that tripwire pointed at the real definition.
 *
 * NOTE what is deliberately NOT allowed, because a `kb_*` glob would sweep them
 * in: `version`, and the ADMIN KB tools (kb_setup, kb_export, kb_import,
 * kb_harvest, kb_promote, kb_invalidate, kb_context, kb_freshness_sweep,
 * kb_resolve_contradiction, kb_reconcile_prefilter). Members read and contribute
 * to the KB; they do not administer it. Never express this scope as a glob.
 */
import type { FleetLaunchDescriptor } from '../services/member-fleet-install.js';

/**
 * Server name the member-local stdio entry is registered under. One name for
 * every provider so the rule strings, the config key and the prune target can
 * never disagree about which server is being talked about.
 */
export const MEMBER_MCP_SERVER_NAME = 'apra-fleet';

/**
 * Every server name a member's config has historically carried for fleet.
 * DENY rules are rendered for all of them, not just the current name: the
 * superseded central-server design registered `apra-fleet-member` (agy's
 * registerMcpEndpoint), and a member that still has that entry on disk must not
 * become a way around the allowlist.
 */
export const MEMBER_MCP_SERVER_ALIASES: readonly string[] = [MEMBER_MCP_SERVER_NAME, 'apra-fleet-member'];

/** Tools a member's own apra-fleet MCP may serve: code intelligence, and KB
 *  read plus member-authored contribution. Nothing else. */
export const MEMBER_ALLOWED_TOOLS: readonly string[] = [
  'code_graph', 'code_impact', 'code_query', 'code_context', 'code_map',
  'code_flow', 'code_tests', 'kb_session_prime', 'kb_query', 'kb_stats',
  'kb_capture', 'kb_feedback', 'kb_list',
];

/** Tools only the orchestrator may call. Denied on every member, in every
 *  provider's rule syntax. */
export const MEMBER_DENIED_TOOLS: readonly string[] = [
  'register_member', 'list_members', 'get_member_model_pricing', 'remove_member',
  'update_member', 'dolt_push_mutex', 'child_id_allocator', 'member_reservation',
  'send_files', 'receive_files', 'execute_prompt', 'execute_command',
  'provision_llm_auth', 'setup_ssh_key', 'setup_git_app', 'provision_vcs_auth',
  'revoke_vcs_auth', 'vcs_credential_exec', 'fleet_status', 'member_detail',
  'update_llm_cli', 'shutdown_server', 'version', 'compose_permissions',
  'cloud_control', 'monitor_task', 'stop_prompt', 'credential_store_set',
  'credential_store_list', 'credential_store_delete', 'credential_store_update',
  'send_email', 'send_message', 'report_status', 'respond_to_message',
  'kb_invalidate', 'kb_context', 'kb_harvest', 'kb_promote',
  'kb_freshness_sweep', 'kb_import', 'kb_resolve_contradiction',
  'kb_reconcile_prefilter', 'kb_setup', 'kb_export',
];

export interface MemberMcpRules {
  allow: string[];
  deny: string[];
}

/**
 * Claude's real MCP permission-string format: `mcp__<server>__<tool>`.
 * ALLOW is rendered for the current server name only -- we only ever enable that
 * one. DENY covers every alias (see MEMBER_MCP_SERVER_ALIASES).
 */
export function renderClaudeMemberMcpRules(): MemberMcpRules {
  return {
    allow: MEMBER_ALLOWED_TOOLS.map(tool => `mcp__${MEMBER_MCP_SERVER_NAME}__${tool}`),
    // Grouped per TOOL, aliases inner -- the order AGY_ORCHESTRATOR_DENY_RULES has
    // always emitted. Kept deliberately: the deny array is written verbatim into
    // member configs, so reordering it would produce a spurious diff on every
    // already-configured member and break byte-identical re-runs.
    deny: MEMBER_DENIED_TOOLS.flatMap(tool =>
      MEMBER_MCP_SERVER_ALIASES.map(server => `mcp__${server}__${tool}`),
    ),
  };
}

/**
 * AGY's equivalent granularity: `mcp(<server>/<tool>)`. Same logical scope as
 * renderClaudeMemberMcpRules, rendered in agy's own syntax -- never a bare
 * server-level `mcp(apra-fleet)`, which would widen the grant to every tool.
 */
export function renderAgyMemberMcpRules(): MemberMcpRules {
  return {
    allow: MEMBER_ALLOWED_TOOLS.map(tool => `mcp(${MEMBER_MCP_SERVER_NAME}/${tool})`),
    // Same per-tool/alias-inner order as before the promotion -- see the note in
    // renderClaudeMemberMcpRules.
    deny: MEMBER_DENIED_TOOLS.flatMap(tool =>
      MEMBER_MCP_SERVER_ALIASES.map(server => `mcp(${server}/${tool})`),
    ),
  };
}

/**
 * The MCP server entry for a member's own install, in the `{ command, args }`
 * stdio shape. Built ONLY from the descriptor the resolver verified on the
 * member -- this function performs no path construction of its own, so no
 * orchestrator-derived value and no shell-expansion token can enter here.
 *
 * `includeType` adds an explicit `type: 'stdio'`, which agy's config format
 * carries (its http entries are written with `type: 'http'`) and Claude's
 * .mcp.json does not require.
 */
export function memberMcpServerEntry(
  descriptor: FleetLaunchDescriptor,
  opts: { includeType?: boolean } = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: descriptor.command, args: [...descriptor.args] };
  if (opts.includeType) entry.type = 'stdio';
  return entry;
}
