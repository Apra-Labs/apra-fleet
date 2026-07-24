import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { isRetryable, authErrorAdvice, workspaceNotTrustedAdvice, type PromptErrorCategory } from '../utils/prompt-errors.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { getModelOverride } from '../services/user-config.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { getStallDetector, resolveSessionLogPath } from '../services/stall/index.js';
import { provisionAgents, remoteAgentsDir } from '../services/agent-provisioner.js';
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import { resolveTilde } from './execute-command.js';
import { clearStoredPid } from '../utils/agent-helpers.js';
import { tryKillPid, isPidAlive } from '../utils/pid-helpers.js';
import { LogScope, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
import { getLogPreviewChars } from '../services/user-config.js';
import { validateSubstitutionKeys, applySubstitutions } from '../services/substitution-engine.js';
import { sessionRegistry } from '../services/session-registry.js';
import { getTokenIssuer } from '../services/token-issuer.js';
import { sendMessage } from './send-message.js';
import { registerPending } from '../services/pending-responses.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { ParsedResponse } from '../providers/provider.js';

export interface ExecutePromptStructured {
  isError?: boolean;
  reason?: 'busy' | 'reserved' | 'dispatch_failed' | 'nonzero_exit' | 'max_turns_exhausted' | 'empty_response' | 'workspace_not_trusted';
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  sessionId?: string;
  [key: string]: unknown;
}

export interface ExecutePromptResult {
  text: string;
  structuredContent?: ExecutePromptStructured;
}

export const executePromptSchema = z.object({
  ...memberIdentifier,
  prompt: z.string().describe('The prompt to send to the LLM on the remote member'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_s: z.number().default(300).describe('Inactivity timeout in seconds -- the command is killed after this many seconds without any stdout/stderr output (default: 300s / 5 minutes)'),
  max_total_s: z.number().optional().describe('Hard ceiling in seconds -- the command is killed after this total elapsed time regardless of activity. If omitted, there is no total time limit.'),
  max_turns: z.number().min(1).max(500).optional().describe('Max turns for claude -p (default: 50)'),
  model: z.string().optional().describe('Model tier ("cheap", "standard", "premium") or a specific model ID for power users. Prefer tier names -- the server resolves them to the correct model per provider. If omitted, defaults to the standard tier. Applies to both new and resumed sessions.'),
  substitutions: z.record(z.string(), z.string()).optional().describe(
    'Optional map of token name to replacement value. ' +
    'When provided, every occurrence of {{name}} in the prompt is replaced before the prompt is staged on the member. ' +
    'Keys must match [A-Za-z_][A-Za-z0-9_]*. Missing tokens cause the call to fail with no CLI invoked. ' +
    'Extra keys are silently ignored. Values are never logged.'
  ),
  agent: z.string().optional().describe(
    'Optional agent name to activate. ' +
    'For Claude: invokes claude --agent <name>. ' +
    'For Gemini: prepends @<name> to the prompt on every dispatch. ' +
    'For AGY: prepends @<name> to the prompt on every dispatch (same as Gemini). ' +
    'Substitution runs before the @<name> prepend. ' +
    'Agent file must exist at the provider-specific path on the member: ' +
    'Claude: <workFolder>/.claude/agents/<name>.md or ~/.claude/agents/<name>.md; ' +
    'Gemini: <workFolder>/.gemini/agents/<name>.md or ~/.gemini/agents/<name>.md; ' +
    'AGY: <workFolder>/.gemini/antigravity-cli/agents/<name>.md or ~/.gemini/antigravity-cli/agents/<name>.md -- ' +
    'the call is rejected with a clear error if neither is present.'
  ),
  sprint_id: z.string().optional().describe(
    'Opaque identity of the sprint issuing this dispatch (apra-fleet-eft.29.1). ' +
    'When provided, the server-side member-reservation check (see reservedBy below) ' +
    'compares this value directly against the reservation instead of falling back to ' +
    'this server process\'s APRA_FLEET_SPRINT_ID env var -- the same per-call value ' +
    'the caller passed to member_reservation reserve/release. Callers that never set a ' +
    'reservation, or that reserved and dispatch in the same process, should omit this; ' +
    'omitting it preserves the pre-existing env-var-based behavior exactly.'
  ),
}).strict();

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

function buildFailureMessage(agentName: string, result: SSHExecResult, provider: ProviderAdapter, parsed?: ParsedResponse): string {
  const output = result.stderr || result.stdout;
  // apra-fleet-p4f.2: prefer the already-parsed structured signal over the
  // stderr/stdout regex scan -- a max_turns-exhausted transcript can still
  // have auth-like noise in stderr (a stale warning, an unrelated retry
  // message, etc.) that would otherwise misclassify it as an auth failure.
  const category: PromptErrorCategory = parsed?.terminalReason === 'max_turns' ? 'max_turns' : provider.classifyError(output);
  if (category === 'max_turns') {
    return `❌ Prompt on "${agentName}" was stopped after exhausting its turn limit (max_turns), not a genuine failure -- the model ran out of turns before finishing:
${output}`;
  }
  return category === 'auth'
    ? authErrorAdvice(agentName)
    : `❌ Prompt failed on "${agentName}":
${output}`;
}

const SERVER_RETRY_DELAY_MS = 5000;

async function writePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string, content: string): Promise<void> {
  if (agent.agentType === 'local') {
    fs.writeFileSync(promptFilePath, content, 'utf-8');
    return;
  }
  const agentOs = getAgentOS(agent);
  const promptFileName = path.basename(promptFilePath);
  const remoteDir = path.dirname(promptFilePath);

  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(remoteDir);
    const psScript = `New-Item -Path '${escapedFolder}' -ItemType Directory -Force | Out-Null; Set-Location "${escapedFolder}"; Set-Content -Path "${promptFileName}" -Value '${content.replace(/'/g, "''")}' -NoNewline -Encoding UTF8`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`);
  } else {
    const b64 = Buffer.from(content).toString('base64');
    const escapedFolder = escapeDoubleQuoted(remoteDir);
    await strategy.execCommand(`mkdir -p "${escapedFolder}" && cd "${escapedFolder}" && echo '${b64}' | base64 -d > ${promptFileName}`);
  }
}

async function deletePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string): Promise<void> {
  if (agent.agentType === 'local') {
    try { fs.unlinkSync(promptFilePath); } catch { /* ignore */ }
    return;
  }
  const agentOs = getAgentOS(agent);
  const promptFileName = path.basename(promptFilePath);
  const remoteDir = path.dirname(promptFilePath);

  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(remoteDir);
    const psScript = `Set-Location "${escapedFolder}"; Remove-Item "${promptFileName}" -Force -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`).catch(() => { /* ignore */ });
  } else {
    const escapedFolder = escapeDoubleQuoted(remoteDir);
    await strategy.execCommand(`cd "${escapedFolder}" && rm -f ${promptFileName}`).catch(() => { /* ignore */ });
  }
}

export function resolveModelForTier(agent: Agent, tier: string, provider: ProviderAdapter): string {
  const memberTiers = agent.modelTiers;
  if (memberTiers) {
    const t = tier as keyof typeof memberTiers;
    return memberTiers[t] ?? memberTiers.standard ?? memberTiers.cheap ?? Object.values(memberTiers).filter(Boolean)[0] as string;
  }
  return provider.modelForTier(tier as 'cheap' | 'mid' | 'premium');
}

const SECURE_TOKEN_RE = /\{\{secure\.[a-zA-Z0-9_-]{1,64}\}\}/;

/**
 * The sprint id this server process dispatches on behalf of, or undefined when
 * run outside a sprint (e.g. a manual cli.mjs invocation). Sourced from
 * APRA_FLEET_SPRINT_ID, which the auto-sprint spawner stamps into the per-sprint
 * server's environment (apra-fleet-eft.10.3). Read on every dispatch so a
 * reservation set/cleared mid-run is observed without a restart.
 */
export function currentSprintId(): string | undefined {
  const raw = process.env.APRA_FLEET_SPRINT_ID;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const inFlightAgents = new Set<string>();

// Member ids whose remote agent files (planner.md, doer.md, _shared/, schemas/, ...)
// have already been probed/refreshed this server process uptime -- the #336
// provisioner is a real SSH round trip, so we pay that cost once per member per
// run rather than on every dispatch. Local members share the operator's home dir
// and never need this; providers with no remote agents dir (codex, copilot) are
// cheap to check and also skipped.
export const provisionedRemoteAgents = new Set<string>();

/**
 * Bring a remote member's agent files current before dispatch (the 0.3.4->0.3.5
 * upgrade path: #336 only provisions on register_member/update_member, so an
 * already-registered member stays stale until this runs). Never throws --
 * provisioning failures must not block the prompt dispatch.
 */
async function ensureAgentFilesProvisioned(agent: Agent): Promise<void> {
  if (agent.agentType === 'local') return;
  if (provisionedRemoteAgents.has(agent.id)) return;
  provisionedRemoteAgents.add(agent.id);

  if (remoteAgentsDir(agent.llmProvider ?? 'claude') === null) return;

  try {
    const result = await provisionAgents(agent);
    if (result.warning) {
      // Probe or upload failed -- do not trust the cache, retry on next dispatch.
      provisionedRemoteAgents.delete(agent.id);
    }
  } catch {
    // warn-and-continue, same as register_member/update_member's wire-in, but
    // a transient failure must not permanently poison the cache.
    provisionedRemoteAgents.delete(agent.id);
  }
}

// All exit paths from executePrompt clear busy state via the finally block (inFlightAgents.delete + writeStatusline):
// (a) normal success: result.code === 0 -> finally sets idle and removes agent from inFlight
// (b) non-zero exit from execCommand: result.code !== 0 -> finally sets idle and removes agent from inFlight
// (c) exception in try block (auth, network, crash) -> catch records error type; finally sets offline or idle
// (d) AbortSignal/MCP client cancellation -> abortHandler kills PID, execCommand resolves, finally clears
// (e) stale session retry -> retried without session ID; finally clears on success or failure
// (f) server overload retry -> retried after delay; finally clears on success or failure
// (g) early returns before inFlightAgents.add: busy state never entered

// apra-fleet-eft.28.1: how often the interactive wait re-checks that the
// target member's claude process is still alive. This is the dispatch-level
// liveness/no-progress bound -- the member's process can die AFTER the
// pre-dispatch liveness check above (e.g. mid-turn, right after send_message
// lands) with no further signal ever arriving, so the wait for
// respond_to_message must not be the sole backstop up to the full timeout_s
// (which can be 3600s). A short, fixed poll interval keeps the surfaced
// error well under the playbook's <10min budget regardless of how large
// timeout_s is.
const INTERACTIVE_LIVENESS_POLL_MS = 5000;

/** Raised by waitForInteractiveResponse when the member's claude process is
 *  confirmed dead while a response is still pending -- distinguished from a
 *  plain "nobody answered in time" timeout so the caller can surface a more
 *  actionable terminal error. */
class InteractiveSessionDiedError extends Error {}

/**
 * Waits for the member's respond_to_message reply, racing that wait against
 * a periodic PID-liveness poll of the same session. Resolves/rejects as soon
 * as either side settles -- a dead PID short-circuits the wait instead of
 * letting it run out the full timeoutMs.
 */
function waitForInteractiveResponse(
  agent: Agent,
  workspaceId: string,
  msgid: string,
  timeoutMs: number,
  scope: LogScope,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const poller = setInterval(() => {
      if (settled) return;
      const session = sessionRegistry.get(workspaceId, agent.id);
      // apra-fleet-eft.50.1: fall back to the durable launch-pid anchor when the
      // live session lost its pid on a reconnect, so this in-flight poll can
      // still detect a dead persistent process on a retry that reused the
      // reconnected session -- not only when the session still carries its pid.
      const pid = session?.pid ?? sessionRegistry.lastKnownPid(workspaceId, agent.id);
      if (pid !== undefined && !isPidAlive(pid)) {
        settled = true;
        clearInterval(poller);
        scope.info(`[interactive] member process pid=${pid} died while awaiting a response -- aborting wait`);
        sessionRegistry.unregister(workspaceId, agent.id);
        reject(new InteractiveSessionDiedError(`member claude process (pid ${pid}) died while waiting for a response`));
      }
    }, INTERACTIVE_LIVENESS_POLL_MS);

    registerPending(msgid, timeoutMs).then(
      (res) => {
        if (settled) return;
        settled = true;
        clearInterval(poller);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearInterval(poller);
        reject(err);
      },
    );
  });
}

/**
 * Interactive routing (apra-fleet-2xs.8): pushes the prompt to a connected
 * member's live session via send_message and waits for that member to call
 * respond_to_message with the matching reply_to. No subprocess, no SSH, no
 * prompt file, no stall detector on a log file -- the session is a
 * long-lived interactive process, not something this call spawns or owns.
 */
async function executePromptInteractive(
  agent: Agent,
  renderedPrompt: string,
  input: ExecutePromptInput,
  workspaceId: string,
  heuristicWarningSuffix: string,
): Promise<string> {
  const timeoutS = input.timeout_s ?? 300;
  const scope = new LogScope('execute_prompt', `[interactive] timeout=${timeoutS}s ${truncateForLog(maskSecrets(input.prompt))}`, agent);

  const sendResult = await sendMessage({ member_id: agent.id, content: renderedPrompt }, workspaceId);
  const parsed = JSON.parse(sendResult);
  if (parsed.error) {
    scope.abort(`send failed: ${parsed.error}`);
    return `❌ Failed to deliver prompt to "${agent.friendlyName}" (interactive session): ${parsed.error}`;
  }

  try {
    const response = await waitForInteractiveResponse(agent, workspaceId, parsed.msgid, timeoutS * 1000, scope);
    scope.ok('interactive response received');
    let output = `📋 Response from ${agent.friendlyName}:\n\n${response}`;
    if (heuristicWarningSuffix) output += heuristicWarningSuffix;
    return output;
  } catch (err: any) {
    if (err instanceof InteractiveSessionDiedError) {
      scope.abort(err.message);
      return `[ERROR] "${agent.friendlyName}"'s interactive claude process died while this dispatch was waiting for a response (${err.message}). The prompt was delivered but nothing will ever answer it -- re-launch the member (re-run register_member) before retrying.`;
    }
    scope.abort(`interactive timeout: ${err.message}`);
    // apra-fleet-eft.74.2: self-heal on interactive-route timeout. A session
    // with no verifiable live pid that just timed out is a phantom channel
    // (the eft.74 wedge): re-routing the NEXT execute_prompt to it would
    // silently re-burn the full timeout_s, forever (observed 5x 900s). Evict
    // it here so the next dispatch finds no interactive session and falls back
    // to the subprocess path. A session that DOES have a verifiably live pid is
    // left registered -- the member is alive, merely slow, so a later dispatch
    // may legitimately reach it interactively again.
    const timedOutSession = sessionRegistry.get(workspaceId, agent.id);
    const timedOutPid = timedOutSession?.pid ?? sessionRegistry.lastKnownPid(workspaceId, agent.id);
    const hasVerifiableLivePid = timedOutPid !== undefined && isPidAlive(timedOutPid);
    if (!hasVerifiableLivePid) {
      sessionRegistry.unregister(workspaceId, agent.id);
      scope.info(`[interactive] timed-out session for "${agent.friendlyName}" has no verifiable live pid (pid=${timedOutPid ?? 'none'}) -- evicting so the next dispatch falls back to subprocess`);
    }
    return `❌ Timed out waiting for "${agent.friendlyName}" to respond (interactive session, ${timeoutS}s). The prompt was delivered; the member may still respond late, but this call has given up waiting.`;
  }
}

export async function executePrompt(input: ExecutePromptInput, extra?: any): Promise<string | ExecutePromptResult> {
  if (SECURE_TOKEN_RE.test(input.prompt)) {
    return 'error: execute_prompt prompt contains {{secure.NAME}} token. Secrets must never be passed to LLM prompts. Use execute_command with {{secure.NAME}} instead.';
  }

  // Validate substitution keys before any I/O or member resolution.
  if (input.substitutions !== undefined) {
    const keyCheck = validateSubstitutionKeys('execute_prompt', input.substitutions);
    if (!keyCheck.ok) return keyCheck.error;
  }

  // Apply substitutions to the prompt string (or emit heuristic warning when omitted).
  let renderedPrompt = input.prompt;
  let heuristicWarningSuffix = '';

  if (input.substitutions !== undefined) {
    const result = applySubstitutions('execute_prompt', [{ label: 'prompt', content: input.prompt }], input.substitutions);
    if (!result.ok) return result.error;
    renderedPrompt = result.outputs[0];
  } else {
    const warnResult = applySubstitutions('execute_prompt', [{ label: 'prompt', content: input.prompt }], undefined);
    if (warnResult.ok && warnResult.warning) {
      heuristicWarningSuffix = `\n\n[WARN] ${warnResult.warning}`;
    }
  }

  const promptFileName = `.fleet-task.md`;

  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  // Server-side member reservation enforcement (apra-fleet-eft.10.3): a member
  // reserved by a DIFFERENT sprint may not be dispatched to. Mirrors the
  // inFlightAgents busy-rejection error path -- the error names the owning
  // sprint. A dispatch from the owning sprint (matching APRA_FLEET_SPRINT_ID)
  // or against an unreserved member proceeds unchanged, so behavior with no
  // reservations is identical to before. Checked before any busy state is
  // entered, closing the manual-CLI bypass the ledger alone could not.
  //
  // apra-fleet-eft.29.1: currentSprintId() alone (APRA_FLEET_SPRINT_ID on
  // THIS server process) is only correct when the launcher spawns a private
  // per-sprint server and stamps its env -- it is not for the eft.7.1
  // CLI/shared-fleet-server path, where cli.mjs attaches to an existing,
  // long-lived HTTP singleton it never spawns and so can never stamp. There,
  // APRA_FLEET_SPRINT_ID is unset (or stale from a different run), so a
  // member reserved by ITS OWN owning sprint was rejected as if from another
  // sprint. Prefer the per-call `sprint_id` -- the exact same opaque token
  // the caller already passed to member_reservation reserve/release (see
  // createMemberReservationClient / sprintMutexId in
  // packages/apra-fleet-se/auto-sprint/runner.js) -- and fall back to
  // currentSprintId() only when the caller omits it, so existing
  // env-var-based callers/tests are unaffected.
  const owningSprint = agent.reservedBy ?? null;
  const dispatchSprintId = input.sprint_id ?? currentSprintId();
  if (owningSprint && owningSprint !== dispatchSprintId) {
    return {
      text: `[-] Member "${agent.friendlyName}" is reserved by sprint "${owningSprint}" and cannot accept a dispatch from another sprint. Wait for that sprint to release it, or force-release the reservation to recover.`,
      structuredContent: { isError: true, reason: 'reserved' },
    };
  }

  if (inFlightAgents.has(agent.id)) {
    return {
      text: `❌ execute_prompt is already running for "${agent.friendlyName}". Wait for the current call to finish before sending another.`,
      structuredContent: { isError: true, reason: 'busy' },
    };
  }

  // No-LLM members (apra-fleet-us9.14) are plain command executors -- neither
  // execute_prompt mode applies (there is no LLM to prompt in either a
  // subprocess or an interactive session). Rejected here, before any busy
  // state is entered, rather than relying on NoneProvider's methods to throw
  // deeper in either dispatch path.
  if (agent.llmProvider === 'none') {
    return `❌ "${agent.friendlyName}" has no LLM provider (llm_provider: "none") -- it is a plain command executor. Use execute_command instead.`;
  }

  // Interactive routing (apra-fleet-2xs.8/us9.8, docs/cloud-fleet-architecture.md
  // section 6): if this member has a live MCP session connected right now,
  // route via send_message + wait-for-response instead of spawning a
  // subprocess. Decided tier-2-locally against THIS machine's session
  // registry only (never caller/hub-side state, per apra-fleet-2xs.8's own
  // scope note) -- so behavior is unaffected by whether execute_prompt is
  // invoked directly (Phase 1) or relayed through a future hub. Falls
  // through to the unchanged subprocess/SSH path below for every member
  // without a live session (the common case today, and always for members
  // that never opt into an interactive session).
  //
  // Gated to Claude only (apra-fleet-us9.9's survey,
  // docs/interactive-injection-provider-survey.md): mode (b) -- server-push
  // mid-session prompt injection -- is POC-proven on Claude alone via the
  // provider-branded `notifications/claude/channel` capability.
  // Gemini/Codex are confirmed [FAIL] (no equivalent push mechanism);
  // Copilot/AGY/OpenCode are [TBD], not confirmed. A non-Claude member CAN
  // still have a live sessionRegistry entry (registerMcpEndpoint gives it
  // basic MCP tool access, apra-fleet-fnz.1-3) without that meaning it can
  // receive or act on this push -- routing to it anyway would silently
  // spend the full timeout_s waiting for a response that can never arrive.
  const isClaudeMember = (agent.llmProvider ?? 'claude') === 'claude';
  const workspaceId = getTokenIssuer().workspaceId();
  const rawSession = isClaudeMember ? sessionRegistry.get(workspaceId, agent.id) : undefined;
  // apra-fleet-eft.74.1: interactive routing requires the EXPLICIT channel
  // opt-in handshake, not mere JWT registration. A plain subprocess
  // connect-back (a Doer that opened an MCP tool-access session with a member
  // JWT but never declared the `claude/channel` capability) registers a live
  // `server` here, yet can never receive the `notifications/claude/channel`
  // push -- routing to it would enqueue a message nothing reads and burn the
  // full timeout_s on every later dispatch (the eft.74 wedge). Only a
  // channel-capable session is an interactive-routing candidate; anything else
  // (including that Doer's live tool session, which must be left untouched)
  // falls through to the unchanged subprocess path below.
  let interactiveSession = rawSession?.channelCapable ? rawSession : undefined;
  // apra-fleet-eft.50.1: resolve the pid to test FRESH on every dispatch
  // (never cached from a prior attempt) and fall back to the durable
  // launch-pid anchor when this reused session lost its own pid on a
  // reconnect. This is what re-arms the dead-session guard on a retry attempt
  // 2+ exactly as on attempt 1: the specific eft.50 ordering (attempt 1 fails
  // clean, attempt 2 targets a now-dead reconnected session) used to slip
  // through here because the reconnected SessionState had pid=undefined, so the
  // check below was skipped and the caller hung on the dead channel.
  const interactivePid = interactiveSession?.pid
    ?? (isClaudeMember ? sessionRegistry.lastKnownPid(workspaceId, agent.id) : undefined);
  if (interactiveSession?.server && interactivePid !== undefined && !isPidAlive(interactivePid)) {
    // apra-fleet-eft.28.1/eft.28.5: never reuse a persistent interactive
    // session whose underlying member claude process has already died. Before
    // eft.28.1, a dead launch-time process (e.g. it crashed before ever
    // producing a plan) left a `server` entry in sessionRegistry that looked
    // reusable -- send_message would happily enqueue to it, but nothing would
    // ever call respond_to_message, so the caller silently burned the full
    // timeout_s (observed up to 3600s in apra-fleet-eft.28) with zero
    // fleet-server log output and no watchdog coverage.
    //
    // eft.28.5 changes what happens once the death is detected: instead of
    // surfacing a terminal dispatch_failed error that forces a manual
    // register_member, EVICT the dead session and FALL THROUGH to a fresh
    // non-interactive (subprocess) dispatch below -- i.e. re-dispatch fresh
    // instead of blocking on waitForInteractiveResponse. The bug in
    // apra-fleet-eft.28 was precisely that a dead session was reused "rather
    // than detecting its death and spawning a fresh dispatch"; this does the
    // spawning. If the fresh subprocess dispatch itself cannot start it
    // returns its own terminal error, so nothing ever hangs.
    //
    // The liveness check now fires for connect-back interactive sessions too:
    // http-transport carries the launch-time pid forward across re-registration
    // (eft.28.5), so `pid` is no longer undefined for a member that registered
    // via register_member and then connected back -- the exact real-fleet
    // repro that evaded eft.28.1.
    //
    // apra-fleet-eft.50.1: eft.28.5's carry-forward still lost the pid when a
    // reconnect happened AFTER the prior SessionState was already unregistered
    // (priorPid lookup found nothing), so a retry attempt 2+ reused a
    // pid=undefined session and hung. `interactivePid` above now back-stops
    // that with sessionRegistry.lastKnownPid, the durable per-member launch-pid
    // anchor, so this guard re-arms on EVERY dispatch attempt that reuses an
    // interactive session, not just the first. It stays undefined only for
    // sessions that never had a captured PID at all (e.g. tests, or a provider
    // that never went through register_member's local spawn path); those are
    // left to the pre-existing interactive behavior, unchanged.
    const deadScope = new LogScope('execute_prompt', `[interactive] session liveness check pid=${interactivePid}`, agent);
    sessionRegistry.unregister(workspaceId, agent.id);
    deadScope.info(`member claude process (pid ${interactivePid}) for "${agent.friendlyName}" is dead -- evicting the stale interactive session and re-dispatching fresh (non-interactive)`);
    interactiveSession = undefined;
  }
  if (interactiveSession?.server) {
    inFlightAgents.add(agent.id);
    writeStatusline(new Map([[agent.id, 'busy']]));
    try {
      return await executePromptInteractive(agent, renderedPrompt, input, workspaceId, heuristicWarningSuffix);
    } finally {
      inFlightAgents.delete(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
    }
  }

  inFlightAgents.add(agent.id);

  await ensureAgentFilesProvisioned(agent);
  const stallDetector = getStallDetector();
  let clearedByStall = false;
  stallDetector.add(agent.id, {
    sessionId: null,
    logFilePath: null,
    lastActivityAt: Date.now(),
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId: agent.id,
    memberName: agent.friendlyName,
    provisional: true,
    stallReported: false,
    onStall: () => {
      // Stall detector already wrote 'unknown' to the statusline before calling here.
      // Our job: clear in-process state so the member can accept new calls.
      // clearedByStall prevents the eventually-resolving finally block from clobbering
      // a new execute_prompt that may have already claimed the member.
      inFlightAgents.delete(agent.id);
      clearedByStall = true;
    },
  });

  const tmpDir = agent.agentType === 'local' ? os.tmpdir() : '/tmp';
  const resolvedWorkFolder = agent.agentType === 'local' ? resolveTilde(agent.workFolder) : agent.workFolder;
  const promptFilePath = agent.agentType === 'local'
    ? path.join(resolvedWorkFolder, promptFileName)
    : `${resolvedWorkFolder}/${promptFileName}`;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const provider = getProvider(agent.llmProvider);

  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));

  const tiers = provider.modelTiers();
  let resolvedModel = input.model || 'standard';
  let resolvedTier: 'cheap' | 'standard' | 'premium' | undefined;
  if (resolvedModel === 'cheap') {
    resolvedTier = 'cheap';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'cheap', provider)
      : agent.modelCheap || getModelOverride(provider.name, 'cheap') || tiers.cheap;
  } else if (resolvedModel === 'standard') {
    resolvedTier = 'standard';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'standard', provider)
      : agent.modelStandard || getModelOverride(provider.name, 'standard') || tiers.standard;
  } else if (resolvedModel === 'premium') {
    resolvedTier = 'premium';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'premium', provider)
      : agent.modelPremium || getModelOverride(provider.name, 'premium') || tiers.premium;
  } else {
    resolvedModel = tiers[resolvedModel as keyof typeof tiers] ?? resolvedModel;
  }

  const scope = new LogScope('execute_prompt', `[${resolvedModel}] resume=${input.resume} timeout=${input.timeout_s ?? 300}s ${truncateForLog(maskSecrets(input.prompt), getLogPreviewChars())}`, agent);

  // For AGY, resuming is allowed even without a known sessionId (falls back to --continue).
  // For other providers, resuming requires a known sessionId.
  const isAgyContinue = provider.name === 'agy' && input.resume && !agent.sessionId && provider.supportsResume();
  const resuming = isAgyContinue ? true : !!(input.resume && agent.sessionId && provider.supportsResume());

  const mintedId = (provider.name === 'claude' || provider.name === 'gemini')
    ? (resuming ? agent.sessionId! : uuid())
    : (provider.name === 'agy')
      ? (agent.sessionId ? agent.sessionId : (resuming ? undefined : uuid()))
      : (resuming ? agent.sessionId : undefined);

  const promptOpts = {
    folder: resolvedWorkFolder,
    promptFile: promptFileName,
    sessionId: mintedId,
    resuming,
    unattended: agent.unattended,
    model: resolvedModel,
    tier: resolvedTier,
    maxTurns: input.max_turns,
    inv: scope.getInv(),
    agentName: input.agent,
  };

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);

  const timeoutMs = (input.timeout_s ?? 300) * 1000;
  const maxTotalMs = input.max_total_s !== undefined ? input.max_total_s * 1000 : undefined;

  // Agent file validation -- verify named agent exists before any CLI invocation
  if (input.agent) {
    const provName = provider.name;
    // AGY uses ~/.gemini/antigravity-cli/ as its config root, not ~/.agy/
    const agentRelDir = provName === 'agy' ? '.gemini/antigravity-cli/agents' : `.${provName}/agents`;
    let agentFound = false;
    if (agent.agentType === 'local') {
      const projPath = path.join(resolvedWorkFolder, agentRelDir, `${input.agent}.md`);
      const userPath = path.join(os.homedir(), agentRelDir, `${input.agent}.md`);
      agentFound = fs.existsSync(projPath) || fs.existsSync(userPath);
      if (!agentFound) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found.\n\nExpected at:\n  ${projPath.replace(/\\/g, '/')}\n  ${userPath.replace(/\\/g, '/')}`;
      }
    } else {
      const ef = escapeDoubleQuoted;
      const projCheck = `${ef(resolvedWorkFolder)}/${agentRelDir}/${ef(input.agent)}.md`;
      const userCheck = `$HOME/${agentRelDir}/${ef(input.agent)}.md`;
      const checkResult = await strategy.execCommand(`test -f "${projCheck}" || test -f "${userCheck}"`, 10000);
      if (checkResult.code !== 0) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found on "${agent.friendlyName}".\n\nExpected at:\n  ${resolvedWorkFolder}/${agentRelDir}/${input.agent}.md\n  ~/${agentRelDir}/${input.agent}.md`;
      }
    }
  }

  // Kill any leftover session from a previous (possibly zombie) execute_prompt call
  await tryKillPid(agent, strategy, cmds);

  // Write the rendered prompt (with substitutions applied) to the prompt file before execution
  await writePromptFile(agent, strategy, promptFilePath, renderedPrompt);

  const onPidCaptured = (pid: number) => {
    scope.info(`pid=${pid}`);
    if (mintedId) {
      try {
        const logPath = resolveSessionLogPath(agent.llmProvider ?? 'claude', mintedId, agent.workFolder);
        stallDetector.update(agent.id, {
          sessionId: mintedId,
          logFilePath: logPath,
          provisional: false,
        });
      } catch { /* copilot/codex: no log path resolution */ }
    }
  };

  const abortHandler = () => {
    scope.abort('cancelled by MCP client');
    tryKillPid(agent, strategy, cmds).catch(() => {});
  };
  extra?.signal?.addEventListener('abort', abortHandler);


  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  let _epExitCode: number | 'error' = 'error';
  let _epError: string | undefined;
  let _epUsage: { input_tokens: number; output_tokens: number } | undefined;
  let _epOffline = false;
  try {
    let result;
    try {
      result = await strategy.execCommand(claudeCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
    } catch (dispatchErr: any) {
      // apra-fleet-02s.1: a genuine command-execution exception (e.g. an
      // inactivity timeout, or any other error strategy.execCommand throws)
      // used to be unconditionally unretried here -- it bypasses both retry
      // mechanisms below, since those only fire on a non-throwing nonzero
      // exit, never on a thrown exception. Retry once with a fresh session
      // before giving up, mirroring the stale-session/server-overloaded
      // retries' bounded, single-attempt shape. Skip the retry if the client
      // itself cancelled the request -- there is nothing to recover from a
      // deliberate cancellation.
      if (extra?.signal?.aborted) throw dispatchErr;
      scope.info(`[${resolvedModel}] retrying -- dispatch exception: ${dispatchErr.message}`);
      await tryKillPid(agent, strategy, cmds);
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
    }
    let parsed = provider.parseResponse(result);
    if (parsed.usage) _epUsage = parsed.usage;

    // apra-fleet-eft.40.3: workspace-not-trusted degrades composed permissions
    // (project-scoped allow entries silently dropped) without killing the CLI process --
    // from there, unattended -p cannot auto-approve or prompt, so tools get denied and
    // the turn eventually fails. Blindly falling through to the stale-session /
    // server-overloaded retries below just repeats the same degraded dispatch against a
    // workspace that is still untrusted, and can walk into eft.28's dead-session hang.
    // Classify and fail fast here, before either retry path, naming
    // ensureWorkspaceTrusted (apra-fleet-eft.40.1/40.2) as the remediation.
    if (result.code !== 0 && provider.classifyError(result.stderr || result.stdout) === 'workspace_not_trusted') {
      return {
        text: `❌ ${workspaceNotTrustedAdvice(agent.friendlyName)}\n${result.stderr || result.stdout}`,
        structuredContent: { isError: true, reason: 'workspace_not_trusted' },
      };
    }

    // Stale session retry -- fresh session ID, no resume
    if (result.code !== 0 && input.resume && agent.sessionId) {
      scope.info(`[${resolvedModel}] retrying -- stale session`);
      await tryKillPid(agent, strategy, cmds);
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    // Server/overloaded error retry -- single attempt after delay
    if (result.code !== 0 && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      scope.info(`[${resolvedModel}] retrying -- server overloaded`);
      await tryKillPid(agent, strategy, cmds);
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    _epExitCode = result.code;
    if (result.code !== 0) {
      return {
        text: buildFailureMessage(agent.friendlyName, result, provider, parsed),
        structuredContent: { isError: true, reason: parsed.terminalReason === 'max_turns' ? 'max_turns_exhausted' : 'nonzero_exit' },
      };
    }

    // Exit 0 but the provider parser extracted NOTHING (no result text)
    // -- observed live (apra-fleet-eft.14, 2026-07-19 stabilization loop):
    // the claude CLI can die silently mid-turn (member-side session
    // transcript stops at a tool_result with no final assistant message)
    // and still exit 0 with EMPTY stdout, so parseResponse falls through
    // to its plain-text fallback with result: ''. Returning that as a
    // success used to hand callers a display wrapper with nothing inside,
    // which schema-extraction layers then misreported as "LLM returned
    // invalid JSON". Classify it at the source as a typed dispatch error
    // instead, with stderr's tail attached for diagnosis.
    if (!parsed.result || parsed.result.trim() === '') {
      const stderrTail = (result.stderr || '').trim().slice(-500);
      return {
        text: `❌ execute_prompt on "${agent.friendlyName}" exited 0 but produced no parseable output (empty result -- the member CLI likely died mid-turn without printing its result envelope).${stderrTail ? `\n[stderr tail]\n${stderrTail}` : ''}`,
        structuredContent: { isError: true, reason: 'empty_response' },
      };
    }

    // Session-id assertion: returned id must match the one we minted/resumed
    if (mintedId && parsed.sessionId && parsed.sessionId !== mintedId) {
      scope.info(`session-id mismatch: expected=${mintedId} got=${parsed.sessionId} -- not persisting`);
      touchAgent(agent.id, undefined);
    } else {
      touchAgent(agent.id, mintedId ?? parsed.sessionId);
    }
    if (mintedId) {
      try {
        stallDetector.update(agent.id, {
          sessionId: mintedId,
          logFilePath: resolveSessionLogPath(agent.llmProvider ?? 'claude', mintedId, agent.workFolder),
          provisional: false,
        });
      } catch { /* copilot/codex: no log path resolution */ }
    }
    clearStoredPid(agent.id);

    if (parsed.usage) {
      const prev = agent.tokenUsage ?? { input: 0, output: 0 };
      updateAgent(agent.id, {
        tokenUsage: {
          input: prev.input + parsed.usage.input_tokens,
          output: prev.output + parsed.usage.output_tokens,
        },
      });
    }

    let output = `📋 Response from ${agent.friendlyName}:

${parsed.result}`;
    if (parsed.usage) output += `
Tokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}`;
    if (parsed.sessionId) output += `

---
session: ${parsed.sessionId}`;
    if (heuristicWarningSuffix) output += heuristicWarningSuffix;
    return {
      text: output,
      structuredContent: {
        ...(_epUsage ? { usage: { input_tokens: _epUsage.input_tokens, output_tokens: _epUsage.output_tokens, total_tokens: _epUsage.input_tokens + _epUsage.output_tokens } } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      },
    };
  } catch (err: any) {
    // Only mark offline for genuine SSH/network connection failures, not for cancellations
    _epOffline = !!(err.message && /ssh|network|econnrefused|ehostunreach|connection timed out/i.test(err.message));
    _epError = err.message;
    return {
      text: `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`,
      structuredContent: { isError: true, reason: 'dispatch_failed' },
    };
  } finally {
    extra?.signal?.removeEventListener('abort', abortHandler);
    const _epTok = _epUsage ? ` in=${_epUsage.input_tokens} out=${_epUsage.output_tokens}` : '';
    if (_epExitCode === 'error') scope.abort(`${_epError ?? 'exception'}${_epTok}`);
    else if (_epExitCode !== 0) scope.fail(`exit=${_epExitCode}${_epTok}`);
    else scope.ok(`exit=0${_epTok}`);
    // Skip if stall detector already cleared state -- a new execute_prompt may have
    // claimed inFlightAgents and set busy again; clobbering it here would be wrong.
    if (!clearedByStall) {
      writeStatusline(new Map([[agent.id, _epOffline ? 'offline' : 'idle']]));
      inFlightAgents.delete(agent.id);
    }
    stallDetector.remove(agent.id);
    await deletePromptFile(agent, strategy, promptFilePath);
  }
}
