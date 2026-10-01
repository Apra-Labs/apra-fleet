import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FULL_TOOL_SCOPE, isToolInScope, runWithSessionMember, scopeMemberId, type ToolScope } from './tool-scope.js';

export type { ToolScope } from './tool-scope.js';

/**
 * Wrap a session's McpServer so every server.tool(...) registration below goes
 * through the scope gate: an out-of-scope tool is simply never registered
 * (deny by omission -- absent from tools/list, unknown when called). Every
 * other property is forwarded to the real server unchanged.
 */
function scopeGatedServer(base: McpServer, scope: ToolScope): McpServer {
  if (scope.kind === 'full') return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'tool') {
        return (name: string, ...rest: unknown[]) => {
          if (!isToolInScope(name, scope)) return undefined;
          return (target.tool as (...args: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Register the fleet tool surface on ONE session's McpServer. `scope` is
 * derived from the session's identity by the HTTP transport; it defaults to
 * FULL (every tool), which is also what the stdio path uses.
 */
export async function registerAllTools(baseServer: McpServer, scope: ToolScope = FULL_TOOL_SCOPE): Promise<void> {
  const server = scopeGatedServer(baseServer, scope);
  const sessionMemberId = scopeMemberId(scope);
  // Load onboarding functions
  const { getFirstRunPreamble, isJsonResponse, isActiveTool, getOnboardingNudge, getWelcomeBackPreamble } = await import('./onboarding.js');

  // Tool schemas and handlers
  const { registerMemberSchema, registerMember } = await import('../tools/register-member.js');
  const { listMembersSchema, listMembers } = await import('../tools/list-members.js');
  const { getMemberModelPricingSchema, getMemberModelPricing } = await import('../tools/get-member-model-pricing.js');
  const { removeMemberSchema, removeMember } = await import('../tools/remove-member.js');
  const { updateMemberSchema, updateMember } = await import('../tools/update-member.js');
  const { memberReservationSchema, memberReservation } = await import('../tools/member-reservation.js');
  const { doltPushMutexSchema, doltPushMutex } = await import('../tools/dolt-push-mutex.js');
  const { childIdAllocatorSchema, childIdAllocator } = await import('../tools/child-id-allocator.js');
  const { sendFilesSchema, sendFiles } = await import('../tools/send-files.js');
  const { receiveFilesSchema, receiveFiles } = await import('../tools/receive-files.js');
  const { executePromptSchema, executePrompt } = await import('../tools/execute-prompt.js');
  const { executeCommandSchema, executeCommand } = await import('../tools/execute-command.js');
  const { provisionAuthSchema, provisionAuth } = await import('../tools/provision-auth.js');
  const { setupSSHKeySchema, setupSSHKey } = await import('../tools/setup-ssh-key.js');
  const { setupGitAppSchema, setupGitApp } = await import('../tools/setup-git-app.js');
  const { provisionVcsAuthSchema, provisionVcsAuth } = await import('../tools/provision-vcs-auth.js');
  const { revokeVcsAuthSchema, revokeVcsAuth } = await import('../tools/revoke-vcs-auth.js');
  const { vcsCredentialExecSchema, vcsCredentialExec } = await import('../tools/vcs-credential-exec.js');
  const { fleetStatusSchema, fleetStatus } = await import('../tools/check-status.js');
  const { memberDetailSchema, memberDetail } = await import('../tools/member-detail.js');
  const { updateAgentCliSchema, updateAgentCli } = await import('../tools/update-agent-cli.js');
  const { shutdownServerSchema, shutdownServer } = await import('../tools/shutdown-server.js');
  const { composePermissionsSchema, composePermissions } = await import('../tools/compose-permissions.js');
  const { cloudControlSchema, cloudControl } = await import('../tools/cloud-control.js');
  const { monitorTaskSchema, monitorTask } = await import('../tools/monitor-task.js');
  const { stopPromptSchema, stopPrompt } = await import('../tools/stop-prompt.js');
  const { versionSchema, version } = await import('../tools/version.js');
  const { credentialStoreSetSchema, credentialStoreSet } = await import('../tools/credential-store-set.js');
  const { credentialStoreListSchema, credentialStoreList } = await import('../tools/credential-store-list.js');
  const { credentialStoreDeleteSchema, credentialStoreDelete } = await import('../tools/credential-store-delete.js');
  const { credentialStoreUpdateSchema, credentialStoreUpdate } = await import('../tools/credential-store-update.js');
  const { sendMessageSchema, sendMessage } = await import('../tools/send-message.js');
  const { sendEmailSchema, sendEmail } = await import('../tools/send-email.js');
  const { reportStatusSchema, reportStatus } = await import('../tools/report-status.js');
  const { respondToMessageSchema, respondToMessage } = await import('../tools/respond-to-message.js');
  const { handleCodeGraph, handleCodeImpact, handleCodeQuery, handleCodeContext, handleCodeMap, handleCodeFlow, handleCodeTests, handleCodeReindex, handleCodeStatus, codeReindexSchema, codeStatusSchema, codeGraphSchema, codeImpactSchema, codeQuerySchema, codeContextSchema, codeMapSchema, codeFlowSchema, codeTestsSchema, resolveCodeSelf, CODE_SELF_NOTE } = await import('../tools/code-intelligence.js');
  const { enrichContextWithKb } = await import('../tools/code-intelligence-kb-enrich.js');
  const { recordUsage } = await import('../tools/code-intelligence-telemetry.js');
  const { kbCaptureSchema, kbCapture } = await import('../tools/kb-capture.js');
  const { kbInvalidateSchema, kbInvalidate } = await import('../tools/kb-invalidate.js');
  const { kbContextSchema, kbContext } = await import('../tools/kb-context.js');
  const { kbSessionPrimeSchema, kbSessionPrime } = await import('../tools/kb-session-prime.js');
  const { kbQuerySchema, kbQuery } = await import('../tools/kb-query.js');
  const { kbListSchema, kbList } = await import('../tools/kb-list.js');
  const { kbExportSchema, kbExport } = await import('../tools/kb-export.js');
  const { kbStatsSchema, kbStats } = await import('../tools/kb-stats.js');
  const { kbFeedbackSchema, kbFeedback } = await import('../tools/kb-feedback.js');
  const { kbHarvestSchema, kbHarvest } = await import('../tools/kb-harvest.js');
  const { kbPromoteSchema, kbPromote } = await import('../tools/kb-promote.js');
  const { kbFreshnessSweepSchema, kbFreshnessSweep } = await import('../tools/kb-freshness-sweep.js');
  const { kbImportSchema, kbImport } = await import('../tools/kb-import.js');
  const { kbResolveContradictionSchema, kbResolveContradiction } = await import('../tools/kb-resolve-contradiction.js');
  const { kbReconcilePrefilterSchema, kbReconcilePrefilter } = await import('../tools/kb-reconcile-prefilter.js');
  const { kbSetupSchema, kbSetup } = await import('../tools/kb-setup.js');
  const { KB_SELF_NOTE } = await import('./knowledge/kb-self.js');

  // Onboarding helpers
  async function sendOnboardingNotification(srv: typeof server, text: string): Promise<void> {
    try {
      await srv.server.sendLoggingMessage({
        level: 'info',
        logger: 'apra-fleet-onboarding',
        data: text,
      });
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e));
      if (!/logging|method not found|not supported/i.test(msg)) {
        process.stderr.write(`[apra-fleet] onboarding notification failed: ${msg}\n`);
      }
    }
  }

  function sanitizeToolResult(s: string): string {
    return s.replace(/<\/?apra-fleet-display[^>]*(?:>|$)/gi, '[tag-stripped]');
  }

  function getOnboardingPreamble(toolName: string, isJson: boolean): string | null {
    if (!isActiveTool(toolName)) return null;
    if (isJson) return null;
    const banner = getFirstRunPreamble();
    if (banner) return banner;
    return getWelcomeBackPreamble();
  }

  // Most tools return a plain display string. A few (execute_command) return
  // { text, structuredContent } to give programmatic callers (e.g.
  // FleetWorkflow.command()) a machine-readable channel alongside the
  // human/LLM-facing text -- see ExecuteCommandResult in tools/execute-command.ts.
  function wrapTool(toolName: string, handler: (input: any, extra?: any) => Promise<string | { text: string; structuredContent?: Record<string, unknown> }>) {
    return async (input: any, extra?: any) => {
      // Every handler can read the calling session's member id: on the extra
      // (extra.sessionMemberId) and, for code further down the call chain,
      // via getSessionMemberId() (src/services/tool-scope.ts). Undefined for a
      // FULL session.
      // (extra stays exactly as received for a FULL session called without one.)
      const scopedExtra = extra === undefined && sessionMemberId === undefined
        ? undefined
        : { ...(extra ?? {}), sessionMemberId };
      const raw = await runWithSessionMember(sessionMemberId, () => handler(input, scopedExtra));
      const result = typeof raw === 'string' ? raw : raw.text;
      const structuredContent = typeof raw === 'string' ? undefined : raw.structuredContent;
      const isJson = isJsonResponse(result);
      const preamble = getOnboardingPreamble(toolName, isJson);
      const suffix = isJson ? null : getOnboardingNudge(toolName, input, result);

      if (preamble) void sendOnboardingNotification(server, preamble);
      if (suffix)   void sendOnboardingNotification(server, suffix);

      const content: Array<{ type: 'text'; text: string; annotations?: { audience?: ('user' | 'assistant')[]; priority?: number } }> = [];
      if (preamble) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${preamble}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 1 } });
      }
      content.push({ type: 'text' as const, text: sanitizeToolResult(result) });
      if (suffix) {
        content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${suffix}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 0.8 } });
      }
      return structuredContent ? { content, structuredContent } : { content };
    };
  }

  // Core Member Management
  server.tool('register_member', 'Add a machine to the fleet. Use member_type "local" for this machine or "remote" for a machine reachable over SSH. Choose the AI provider the member will use for prompts. Optional: add tags for grouping and filtering members.', registerMemberSchema.shape, wrapTool('register_member', (input) => registerMember(input as any)));
  server.tool('list_members', 'List all fleet members and their current status. Use format="json" for structured data. Use tags=["gpu"] to filter to members that have ALL specified tags (AND semantics); omit tags to return all members.', listMembersSchema.shape, wrapTool('list_members', (input) => listMembers(input as any)));
  server.tool('get_member_model_pricing', "Returns a member's cheap/standard/premium tier resolved to a concrete model and its per-1M-token price (prompt/completion), for real per-dispatch cost tracking instead of a tier-band estimate. A tier is null when its resolved model has no known price.", getMemberModelPricingSchema.shape, wrapTool('get_member_model_pricing', (input) => getMemberModelPricing(input as any)));
  server.tool('remove_member', 'Remove a member from the fleet.', removeMemberSchema.shape, wrapTool('remove_member', (input) => removeMember(input as any)));
  server.tool('update_member', "Change a member's name, connection details, working directory, AI provider, tags, or other settings.", updateMemberSchema.shape, wrapTool('update_member', (input) => updateMember(input as any)));
  server.tool('dolt_push_mutex', 'Global cross-sprint dolt push mutex hosted on the fleet server, so sprints launched WITHOUT a supervisor still serialize their `bd dolt push` calls. "acquire" enqueues (FIFO) and returns {granted, ticket, token?}; "poll" re-checks a ticket without losing its queue position; "release"/"renew" are token-guarded; "cancel" drops a ticket; "status" snapshots holder + queue.', doltPushMutexSchema.shape, wrapTool('dolt_push_mutex', (input) => doltPushMutex(input as any)));
  server.tool('child_id_allocator', 'Global child-bead-id allocator hosted on the fleet server, so sprints launched WITHOUT a supervisor never mint the same child id under a shared parent. "allocate" reserves the next id under parent_id (lease + pid guarded); "confirm" commits it after a successful create; "release" returns an unused id to the free pool; "status" snapshots per-parent state.', childIdAllocatorSchema.shape, wrapTool('child_id_allocator', (input) => childIdAllocator(input as any)));
  server.tool('member_reservation', 'Reserve, release, or force-release exclusive ownership of a member for a sprint (server-side reservation; does not yet block dispatch). "reserve" claims the member for sprint_id; "release" clears it if sprint_id matches the current holder; "force_release" clears a wedged reservation regardless of owner.', memberReservationSchema.shape, wrapTool('member_reservation', (input) => memberReservation(input as any)));

  // File Operations
  server.tool('send_files', 'Transfer local files to a member. Always batch multiple files into a single call — never invoke repeatedly for individual files.', sendFilesSchema.shape, wrapTool('send_files', (input, extra) => sendFiles(input as any, extra)));
  server.tool('receive_files', 'Download files from a member to a local directory. Always batch multiple files into a single call — never invoke repeatedly for individual files.', receiveFilesSchema.shape, wrapTool('receive_files', (input, extra) => receiveFiles(input as any, extra)));

  // Prompt Execution
  server.tool('execute_prompt', 'Run an AI prompt on a member. Supports session resume for multi-turn conversations. On success, the reply text is returned in structuredContent.response (alongside usage and sessionId).', executePromptSchema.shape, wrapTool('execute_prompt', (input, extra) => executePrompt(input as any, extra)));
  server.tool('execute_command', 'Run a shell command on a member. Use for quick tasks like installing packages, checking versions, or running scripts.', executeCommandSchema.shape, wrapTool('execute_command', (input, extra) => executeCommand(input as any, extra)));

  // Authentication & SSH
  server.tool('provision_llm_auth', "Authenticate a fleet member so it can run prompts. Copies your current login session to the member, or deploys an API key if provided. Run this before execute_prompt if the member reports no authentication.", provisionAuthSchema.shape, wrapTool('provision_llm_auth', (input) => provisionAuth(input as any)));
  server.tool('setup_ssh_key', 'Generate an SSH key pair and migrate a member from password to key-based authentication.', setupSSHKeySchema.shape, wrapTool('setup_ssh_key', (input) => setupSSHKey(input as any)));
  server.tool('setup_git_app', "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created and installed, with the repository permissions each git_access level needs (see docs/github-app-setup.md; push+pr needs Metadata, Contents, Workflows, Pull requests, Actions) -- a mint requesting a permission the App lacks fails.", setupGitAppSchema.shape, wrapTool('setup_git_app', (input) => setupGitApp(input as any)));
  server.tool('provision_vcs_auth', 'Set up git access credentials on a member. Supports GitHub, Bitbucket, and Azure DevOps. Tests connectivity after setup.', provisionVcsAuthSchema.shape, wrapTool('provision_vcs_auth', (input) => provisionVcsAuth(input as any)));
  server.tool('revoke_vcs_auth', 'Remove VCS credentials from a member. Specify the provider (github, bitbucket, or azure-devops) to revoke.', revokeVcsAuthSchema.shape, wrapTool('revoke_vcs_auth', (input) => revokeVcsAuth(input as any)));
  server.tool('vcs_credential_exec', 'Run a credential-requiring git/VCS command on a member WITHOUT ever learning the credential. Put one of two literal placeholders where the token belongs: {{vcs_token}}, referenced BARE (never inside your own quotes) -- the server substitutes it already escaped AND quoted for that member\'s shell; or {{vcs_token_inline}}, referenced INSIDE your own single quotes (e.g. an Authorization header value) -- the server substitutes it escaped for the interior of a single-quoted string, with no quotes of its own. Using {{vcs_token}} inside your own quotes double-escapes it; use {{vcs_token_inline}} there instead. Both may appear in the same command. The server dispatches the command and redacts the value from the returned stdout/stderr. Use this instead of reading a token back out of a credential helper.', vcsCredentialExecSchema.shape, wrapTool('vcs_credential_exec', (input) => vcsCredentialExec(input as any)));

  // Status & Monitoring
  server.tool('fleet_status', 'Get status of all fleet members. Use json format for structured data.', fleetStatusSchema.shape, wrapTool('fleet_status', (input) => fleetStatus(input as any)));
  server.tool('member_detail', 'Get detailed status for one member: connectivity, AI version, authentication, active session, resources, and git branch.', memberDetailSchema.shape, wrapTool('member_detail', (input) => memberDetail(input as any)));

  // Maintenance
  server.tool('update_llm_cli', "Update or install the AI provider CLI on members. Omit member to update all online members at once. Use install_if_missing to install on members that don't have it yet.", updateAgentCliSchema.shape, wrapTool('update_llm_cli', (input) => updateAgentCli(input as any)));
  server.tool('shutdown_server', 'Gracefully shut down the MCP server. Run /mcp afterwards to start a fresh instance with the latest code.', shutdownServerSchema.shape, wrapTool('shutdown_server', () => shutdownServer()));
  server.tool('version', 'Returns the installed apra-fleet server version', versionSchema.shape, wrapTool('version', () => version()));

  // Permissions
  server.tool('compose_permissions', 'Set up and deliver the right permissions to a member for their role or tags. Automatically tailors permissions to the project type. Pass tags (e.g. ["doer","gpu"]) to layer custom tag profiles additively on top of the base role; a doer/reviewer tag sets the primary mode and wins over role. Use grant to add specific permissions mid-sprint without a full recompose.', composePermissionsSchema.shape, wrapTool('compose_permissions', (input) => composePermissions(input as any)));

  // Cloud Control
  server.tool('cloud_control', 'Manually start, stop, or check status of a cloud fleet member. Start waits until the member is ready; stop is immediate.', cloudControlSchema.shape, wrapTool('cloud_control', (input) => cloudControl(input as any)));
  server.tool('monitor_task', 'Check status of a long-running background task on a cloud member. Optionally stop the cloud instance automatically when the task completes.', monitorTaskSchema.shape, wrapTool('monitor_task', (input) => monitorTask(input as any)));

  // Agent Lifecycle
  server.tool('stop_prompt', 'Kill the active LLM process on a member. Always call TaskStop on the dispatching background agent after calling this.', stopPromptSchema.shape, wrapTool('stop_prompt', (input) => stopPrompt(input as any)));

  // Credential Store
  server.tool('credential_store_set', 'Collect a secret from the user out-of-band and store it. Returns a handle (sec://NAME) and scope. Use {{secret.NAME}} tokens in execute_command to inject the value.', credentialStoreSetSchema.shape, wrapTool('credential_store_set', (input) => credentialStoreSet(input as any)));
  server.tool('credential_store_list', 'List all stored credentials (names and metadata only — no values).', credentialStoreListSchema.shape, wrapTool('credential_store_list', () => credentialStoreList()));
  server.tool('credential_store_delete', 'Delete a named credential from the store (both session and persistent tiers).', credentialStoreDeleteSchema.shape, wrapTool('credential_store_delete', (input) => credentialStoreDelete(input as any)));
  server.tool('credential_store_update', 'Update metadata (members, TTL, network policy) on an existing credential without re-entering the secret.', credentialStoreUpdateSchema.shape, wrapTool('credential_store_update', (input) => credentialStoreUpdate(input as any)));

  // Email
  server.tool('send_email', 'Send an email. Pass provider config inline (provider, from, and for SMTP: host, port, user, secure). Secrets (API keys, passwords) are resolved from the credential store -- store them first with credential_store_set (names: "sendgrid_api_key" for SendGrid, "smtp_password" for SMTP). Returns JSON with messageId on success or error on failure.', sendEmailSchema.shape, wrapTool('send_email', (input, extra) => sendEmail(input as any, extra)));

  // Interactive Session Messaging
  server.tool('send_message', 'Send a task message to a connected interactive member session via SSE. Returns the message ID.', sendMessageSchema.shape, wrapTool('send_message', (input) => sendMessage(input as any)));
  server.tool('report_status', 'Called by a connected interactive member session (not the orchestrator) to report it is done responding to a send_message notification and available again ("online") or still connected but not actively engaged ("idle"). Closes the busy->online/idle status loop send_message opens.', reportStatusSchema.shape, wrapTool('report_status', (input, extra) => reportStatus(input as any, extra)));
  server.tool('respond_to_message', 'Called by a connected interactive member session to respond to a prompt delivered via execute_prompt or send_message. Pass reply_to as the msgid from the original notification\'s meta. If execute_prompt is waiting on this reply_to, its call resolves with this content; otherwise this is a no-op response with a clear "no pending call" result.', respondToMessageSchema.shape, wrapTool('respond_to_message', (input) => respondToMessage(input as any)));

  // --- Code Intelligence ---

  // Every code_* tool resolves (self) -- the calling session's own folder
  // (resolveCodeSelf, src/tools/code-intelligence.ts) -- before recording
  // usage, so telemetry, the provider call, and code_context's KB enrichment
  // all see the same resolved folder. A resolution failure throws a typed
  // E-SELF-* error, which the MCP server returns as an error result.
  //
  // Usage telemetry (P8, design D8) is recorded here in the shared handler
  // layer, not inside a provider, so providers stay pure proxies.
  // Fire-and-forget -- never blocks or fails the call.
  server.tool('code_graph', 'Trace the call graph for a symbol. Returns callers and callees across the codebase. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.' + CODE_SELF_NOTE, codeGraphSchema.shape, wrapTool('code_graph', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_graph', input.symbol, self.repo);
    return JSON.stringify(await handleCodeGraph(input, self));
  }));
  server.tool('code_impact', 'Find what is affected by changes to a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.' + CODE_SELF_NOTE, codeImpactSchema.shape, wrapTool('code_impact', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_impact', input.target, self.repo);
    return JSON.stringify(await handleCodeImpact(input, self));
  }));
  server.tool('code_query', 'Search the codebase for symbols, patterns, or concepts using natural language or code patterns. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.' + CODE_SELF_NOTE, codeQuerySchema.shape, wrapTool('code_query', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_query', input.query, self.repo);
    return JSON.stringify(await handleCodeQuery(input, self));
  }));
  server.tool('code_context', 'Get callers, callees, and execution flows for a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.' + CODE_SELF_NOTE, codeContextSchema.shape, wrapTool('code_context', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_context', input.name, self.repo);
    const result = await handleCodeContext(input, self);
    // P4a (design D4): KB enrichment lives one layer up from the provider --
    // the gitnexus provider file must not import the KB service. Only this
    // handler calls the helper, then merges. The KB is the one of the same
    // (self) folder the code call was answered from.
    const enriched = await enrichContextWithKb(input.name, result, self.repo, self.remoteUrl);
    return JSON.stringify(enriched);
  }));
  server.tool('code_map', 'Get the architectural map of a repository: module communities with their key symbols and files, ranked by size. Prefer this over directory listings or file reads when orienting in an unfamiliar codebase -- the answer is pre-indexed.' + CODE_SELF_NOTE, codeMapSchema.shape, wrapTool('code_map', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_map', '', self.repo);
    return JSON.stringify(await handleCodeMap(input, self));
  }));
  server.tool('code_flow', 'Find process flows (entry -> steps -> exit) matching a name or endpoints. Prefer this over manually tracing call chains across files -- the flows are pre-indexed.' + CODE_SELF_NOTE, codeFlowSchema.shape, wrapTool('code_flow', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_flow', input.name ?? input.from ?? input.to ?? '', self.repo);
    return JSON.stringify(await handleCodeFlow(input, self));
  }));
  server.tool('code_tests', 'Find the test files and test functions that exercise a symbol (transitive callers, depth 2). Use this to run targeted tests for the code you changed instead of the full suite. Prefer this over Grep for test discovery -- the call graph is pre-indexed.' + CODE_SELF_NOTE, codeTestsSchema.shape, wrapTool('code_tests', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_tests', input.symbol, self.repo);
    return JSON.stringify(await handleCodeTests(input, self));
  }));
  server.tool('code_reindex', 'Rebuild the code index of the calling session\'s own repo (runs gitnexus analyze detached; its output is captured to <data>/code-index/<slug>/analyze.log). Returns after the first tick -- outcome "started" (lock held, process alive, output seen), "up-to-date", "starting" (running, no tick yet), "already-running", or "not-started" with a typed reason (npx-not-found, gitnexus-not-found, analyze-failed, spawn-failed, remote-member). Poll code_status for completion.' + CODE_SELF_NOTE, codeReindexSchema.shape, wrapTool('code_reindex', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_reindex', '', self.repo);
    return JSON.stringify(await handleCodeReindex(input, self));
  }));
  server.tool('code_status', 'Report the code index state of the calling session\'s own repo: the last analyze run (phase, result indexed|up-to-date|incomplete|failed, last log line, log path), live readiness (ready|building|missing) and the indexed commit.' + CODE_SELF_NOTE, codeStatusSchema.shape, wrapTool('code_status', async (input) => {
    const self = resolveCodeSelf();
    recordUsage('code_status', '', self.repo);
    return JSON.stringify(await handleCodeStatus(input, self));
  }));

  // --- Knowledge Bank ---
  server.tool('kb_capture', 'Capture a learning, fact, or file summary into the knowledge bank. Confidence is capped at INFERRED: any CONFIRMED passed here is downgraded to INFERRED, and a user-directive is stored UNVERIFIED as a pending proposal until a human approves it; confidence_clamped:true whenever the stored confidence differs from the requested one (default INFERRED). CONFIRMED is minted ONLY via kb_promote. Returns {id, audn_decision, confidence_clamped}. audn_decision: add=new entry, none=duplicate skipped, update=same-topic predecessor linked (refines; both entries stay live), flagged=contradiction flagged for review. Pass supersedes:<id> to retire that entry instead (only takes effect if AUDN independently matched it).' + KB_SELF_NOTE, kbCaptureSchema.shape, wrapTool('kb_capture', (input) => kbCapture(input as any)));
  server.tool('kb_invalidate', 'Mark context-cache entries stale for the given file paths. Call after modifying files to ensure the KB reflects the current state.' + KB_SELF_NOTE, kbInvalidateSchema.shape, wrapTool('kb_invalidate', (input) => kbInvalidate(input as any)));
  server.tool('kb_context', 'Check freshness of files against the knowledge bank. Returns {fresh, stale, missing} -- fresh files can be skipped, stale/missing files must be re-read.' + KB_SELF_NOTE, kbContextSchema.shape, wrapTool('kb_context', (input) => kbContext(input as any)));
  server.tool('kb_session_prime', 'Prime a session with KB context. Returns session_warm status, stale files needing re-read, top KB entries, and recommended GitNexus calls.' + KB_SELF_NOTE, kbSessionPrimeSchema.shape, wrapTool('kb_session_prime', (input) => kbSessionPrime(input as any)));
  server.tool('kb_query', 'Two-level knowledge bank search. L1: FTS5 on title+summary (up to 20 results). L2: full content for top 5 hits (max 800 tokens each). Excludes stale/superseded by default. Optional tag filter (exact match) ANDs alongside other filters without touching FTS/OR-join logic, and may be used alone (no query) to list all entries carrying the tag. Pass flagged_only: true to list all contradiction-flagged entry pairs for resolution. Pass expand_related: true to also receive related_claims -- entries joined to the top hits by a refines or contradiction_of edge. Those record the KB own judgements about its contents (there is a newer framing of this; something disputes this) and cannot be reached by a text match. shares_file/shares_symbol edges are deliberately not traversed, since FTS over those same fields already surfaces them. Default false, in which case related_claims is absent and the result shape is unchanged. With no confidence filter the default is confidence ["CONFIRMED"] plus exclude_disputed: true, so only CONFIRMED entries outside any unresolved contradiction are returned (related_claims included). Pass an explicit confidence list (e.g. ["CONFIRMED","INFERRED","UNVERIFIED"]) to opt into other tiers; exclude_disputed then defaults off unless set true. flagged_only is exempt.' + KB_SELF_NOTE, kbQuerySchema.shape, wrapTool('kb_query', (input) => kbQuery(input as any)));
  server.tool('kb_list', 'List KB entries by confidence/type/module/symbol/tag -- audit the KB. With no confidence filter, returns only CONFIRMED, undisputed entries; pass an explicit confidence list (e.g. ["INFERRED","UNVERIFIED"]) to see other tiers without touching FTS ranking or use_count telemetry. Excludes superseded/stale entries. Returns {results, total} with each entry as {id, type, confidence, title, summary, symbols, source_files}.' + KB_SELF_NOTE, kbListSchema.shape, wrapTool('kb_list', (input) => kbList(input as any)));
  server.tool('kb_harvest', 'Scan a session transcript for learnings and capture them into the KB. Returns {entries_captured, entries_updated, entries_skipped}. Extracted entries are UNVERIFIED and author=harvest, source=harvest.' + KB_SELF_NOTE, kbHarvestSchema.shape, wrapTool('kb_harvest', (input) => kbHarvest(input as any)));
  server.tool('kb_promote', 'Upgrade KB entry confidence: UNVERIFIED -> INFERRED -> CONFIRMED. Appends promotion note to content as evidence trail. CONFIRMED entries are no-op.' + KB_SELF_NOTE, kbPromoteSchema.shape, wrapTool('kb_promote', (input) => kbPromote(input as any)));
  server.tool('kb_freshness_sweep', 'Bounded full-KB bidirectional freshness sweep: re-hash every entry that has a stored per-file basis against the CURRENT worktree, mark mismatches stale, and revive stale entries whose full basis matches again (superseded, feedback-downvoted, and invalidated entries stay retired). This is the branch-switch revival surface kb_session_prime cannot be (prime excludes stale entries). Returns {checked, staled, unstaled}.' + KB_SELF_NOTE, kbFreshnessSweepSchema.shape, wrapTool('kb_freshness_sweep', (input) => kbFreshnessSweep(input as any)));
  server.tool('kb_import', 'Import a merged bible (.fleet/kb-canonical.json) into the warm local KB -- the post-merge write path (the prime-time cold-seed is output-only). Reads the repo-resolved bible, or an explicit --path file. Each entry routes through the AUDN choke point (duplicate -> skipped, refinement -> linked, contradiction -> flagged); non-directive entries KEEP their bible confidence (the bible is a git-reviewed, human-merged artifact), stamped source="import"; type="user-directive" entries are FORCED to pending proposals (never active -- a bible cannot smuggle an active directive). Idempotent (re-import of the same bible adds nothing). Runs a freshness sweep after import so entries whose basis does not match this worktree are staled. Accepts BOTH bible shapes: a legacy bare JSON array and the v2 {version, provenance:{commit, branch, entry_count}, entries} envelope. Entries with no source_files, or citing files absent from this worktree, are REJECTED (an entry with no checkable basis can never be staled, so nothing could falsify it) -- re-importing a legacy bible deliberately drops those. Returns {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}. Pass skip_sweep: true to skip the post-import freshness sweep -- the sweep re-judges EVERY entry against the given worktree, which is right for a deliberate audit but wrong for a routine warm-the-KB import (it mass-stales entries merely because unrelated files moved on, which in turn empties the promotion candidates kb_list returns). `path` names only the bible file to read, never which KB is written. TRUST BOUNDARY: importing the repo-resolved bible is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust, equivalent in power to kb_promote. Directives are quarantined either way; activation stays CLI-only.' + KB_SELF_NOTE, kbImportSchema.shape, wrapTool('kb_import', (input) => kbImport(input as any)));
  server.tool('kb_resolve_contradiction', 'Resolve a KB contradiction pair: {winnerId, loserId, evidence}. The SINGLE write path for reconcile resolutions (used by kb_reconcile_prefilter and the reconciler agent alike). Winner ends confidence=CONFIRMED with the evidence note appended and both flag fields cleared (flagged_for_review + contradiction_of); stale is cleared ONLY if the D2 un-stale predicate holds on the post-flag-clear row (so a downvoted or invalidated winner still stays retired -- it wins the contradiction, not its reputation). Loser ends superseded_at=now + stale=1 + flag cleared, never deleted. REFUSES (throws, writes nothing) when either id is missing, either entry is already superseded, the ids do not form a genuinely linked contradiction pair, or the pair involves an ACTIVE user-directive.' + KB_SELF_NOTE, kbResolveContradictionSchema.shape, wrapTool('kb_resolve_contradiction', (input) => kbResolveContradiction(input as any)));
  server.tool('kb_reconcile_prefilter', 'Mechanical hash-basis prefilter over all flagged contradiction pairs (including stale members -- see flaggedPairs liveness contract). Re-hashes both sides of each pair against the CURRENT worktree: exactly one side fully matching wins mechanically via kb_resolve_contradiction (evidence "hash-basis match on merged worktree"); both match, both mismatch, or an empty/missing basis on either side leaves the pair for the reconciler agent. Pairs involving an ACTIVE user-directive are never touched. Returns {pairs, resolved, left_for_agent, skipped_directive}. Run after kb_import + kb_freshness_sweep, before dispatching the reconciler agent.' + KB_SELF_NOTE, kbReconcilePrefilterSchema.shape, wrapTool('kb_reconcile_prefilter', (input) => kbReconcilePrefilter(input as any)));
  server.tool('kb_setup', 'Set up KB: install git post-commit hook, write provider config, store remote credentials encrypted. Run once per repo.' + KB_SELF_NOTE, kbSetupSchema.shape, wrapTool('kb_setup', (input) => kbSetup(input as any)));
  server.tool('kb_export', 'Export all CONFIRMED, non-superseded, non-stale KB entries to a canonical bible file (stable field set, deterministic id order, ASCII-safe). scope="project" (default): reads the project KB, writes <repo>/.fleet/kb-canonical.json. scope="global": reads the GLOBAL KB, writes <repo>/.fleet/kb-canonical-global.json (in practice the apra-fleet platform repo, committed there so the installer can distribute it to every project on the machine -- D8/F9). Run after kb_promote so the canonical set stays current. F6a: the tool itself auto-commits the bible file (pathspec-only, identity pm-kb) when the repo is a git repo and the content changed -- this is code, not agent discretion, so no manual git step is needed, and this applies to the global file too. Non-fatal on any git failure; push is not automatic. Writes the v2 format: {version:2, provenance:{commit, branch, entry_count}, entries:[...]}, recording the commit the entries were verified against (a commit, not a timestamp, so re-exports stay diff-free when nothing changed). An export whose entry set is unchanged rewrites nothing. Auto-commit defaults to ON (USER DIRECTIVE 2026-08-11 -- an export left uncommitted is knowledge nobody else ever sees): set FLEET_DIR/knowledge/config.json { bible: { autoCommit: false } } to opt out. A malformed config disables it.' + KB_SELF_NOTE, kbExportSchema.shape, wrapTool('kb_export', (input) => kbExport(input as any)));
  server.tool('kb_stats', 'Read-only KB health aggregation: totals by confidence/type, stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, canonical-bible presence/drift, and optional per-symbol coverage. Never bumps use_count/last_accessed (kb_list pattern). Bible drift is visibility for the machine that owns the KB -- CI cannot see the local kb.sqlite, so there is no CI gate on it.' + KB_SELF_NOTE, kbStatsSchema.shape, wrapTool('kb_stats', (input) => kbStats(input as any)));
  server.tool('kb_feedback', 'Downvote a KB entry that proved wrong in practice: { id, reason, role? }. Marks the entry stale=1 + flagged_for_review=1 and appends an ASCII feedback note "[feedback <ISO>] <validated-role>: <reason>" (CONTENT_CAP respected). NEVER deletes and NEVER touches confidence -- a downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged; the human resolves it in kb-review, this tool only flags it for that review. Exception: an ACTIVE user-directive is flagged for review but NOT staled (directives outrank agent experience -- the human decides); a pending directive proposal stales normally.' + KB_SELF_NOTE, kbFeedbackSchema.shape, wrapTool('kb_feedback', (input) => kbFeedback(input as any)));
}
