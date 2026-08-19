import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { knownRepoRemoteUrl } from '../services/member-remote-url.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, touchAgent, getStoredPid } from '../utils/agent-helpers.js';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { isRetryable, authErrorAdvice, workspaceNotTrustedAdvice, type PromptErrorCategory } from '../utils/prompt-errors.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { getModelOverride } from '../services/user-config.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { getStallDetector, resolveSessionLogPath } from '../services/stall/index.js';
import { getCachedMemberPathContext } from '../services/member-home.js';
import { provisionAgents, remoteAgentsDir, loadCanonicalAgentSet } from '../services/agent-provisioner.js';
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import { resolveTilde } from './execute-command.js';
import { clearStoredPid } from '../utils/agent-helpers.js';
import { tryKillPid, isPidAlive } from '../utils/pid-helpers.js';
import { recoverOrphanedDispatch, isRemoteProcessAlive } from '../services/orphan-recovery.js';
import { seedWorkspaceTrust } from '../utils/workspace-trust.js';
import { durableOutputPath } from '../os/linux.js';
import { LogScope, logLine, logWarn, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
import { getLogPreviewChars } from '../services/user-config.js';
import { validateSubstitutionKeys, applySubstitutions } from '../services/substitution-engine.js';
import { sessionRegistry } from '../services/session-registry.js';
import { getTokenIssuer } from '../services/token-issuer.js';
import { resolveExpectedDemand, checkContextAdmission, recordSessionUsage } from '../services/context-admission.js';
import { recordKnownSession, isKnownSession } from '../services/known-sessions.js';
import { resolveBudgetScope, evaluateBudget, recordAndEvaluate, type BudgetUsageBlock } from '../services/budget-awareness.js';
import { sendMessage } from './send-message.js';
import { registerPending } from '../services/pending-responses.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { ParsedResponse } from '../providers/provider.js';
import { isMaxTurnsResponse } from '../providers/provider.js';
import { preflightCheck } from '../services/preflight-check.js';

export interface ExecutePromptStructured {
  isError?: boolean;
  reason?: 'busy' | 'reserved' | 'dispatch_failed' | 'nonzero_exit' | 'max_turns_exhausted' | 'empty_response' | 'orphan_recovery_timeout' | 'workspace_not_trusted' | 'auth' | 'server' | 'overloaded' | 'insufficient_context_headroom' | 'budget_exhausted' | 'session_not_found' | 'stalled' | 'preflight_offline' | 'preflight_auth_missing' | 'preflight_auth_expired';
  // The LLM's actual reply text on success. Callers that dispatch execute_prompt
  // via an MCP client only ever see structuredContent (the content array is
  // dropped when structuredContent is also present) -- this field exists so the
  // reply reaches them at all, rather than being stranded in the display text.
  response?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  sessionId?: string;
  /** Present on an 'insufficient_context_headroom' rejection (apra-fleet-eft.81.1). */
  detail?: { demand: number; headroom: number; window: number };
  /** Present on a successful dispatch that fits but lands inside the session's
   *  safety margin (apra-fleet-eft.81.1) -- a non-fatal heads-up, not an error. */
  contextWarning?: { message: string; detail: { demand: number; headroom: number; window: number } };
  /** Usage/budget block (apra-fleet-eft.80.2) attached to every result once
   *  the configured budget crosses its warning band, and to a
   *  budget_exhausted rejection. Named `budgetUsage` (not `usage`) to avoid
   *  colliding with the token-count `usage` field above. Carries source:
   *  'provider' (from a provider-native getUsage()) vs 'estimated' (fleet-side
   *  token-count fallback). */
  budgetUsage?: BudgetUsageBlock;
  [key: string]: unknown;
}

export interface ExecutePromptResult {
  text: string;
  structuredContent?: ExecutePromptStructured;
}

export const executePromptSchema = z.object({
  ...memberIdentifier,
  prompt: z.string().describe('The prompt to send to the LLM on the remote member'),
  session_id: z.string().optional().describe('Shorthand for explicit session resume. Equivalent to resume: "<session_id>". If provided, takes precedence over resume.'),
  resume: z.union([z.boolean(), z.string()]).default(true).describe(
    'Session-resume control (default: true). ' +
    'true = best-effort resume of the member\'s stored last session (a stale/unknown stored session transparently falls back to a fresh session). ' +
    'false = always start a fresh session. ' +
    'A session-id STRING = EXPLICIT resume of exactly that session, preferred over the member\'s stored session -- the caller asserts this prompt depends on that session\'s prior context, so an unknown/expired id is a TERMINAL error ' +
    '(structured {isError, reason: "session_not_found"}, NO LLM call, and NO fresh-session fallback) rather than a silent wrong-context dispatch.'
  ),
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
    'AGY: <workFolder>/.gemini/antigravity-cli/agents/<name>.md or ~/.gemini/antigravity-cli/agents/<name>.md; ' +
    'OpenCode: <workFolder>/.opencode/agents/<name>.md or ~/.config/opencode/agents/<name>.md -- ' +
    'the call is rejected with a clear error if neither is present.'
  ),
  sprint_id: z.string().optional().describe(
    'Opaque identity of the sprint issuing this dispatch. ' +
    'When provided, the server-side member-reservation check (see reservedBy below) ' +
    'compares this value directly against the reservation instead of falling back to ' +
    'this server process\'s APRA_FLEET_SPRINT_ID env var -- the same per-call value ' +
    'the caller passed to member_reservation reserve/release. Callers that never set a ' +
    'reservation, or that reserved and dispatch in the same process, should omit this; ' +
    'omitting it preserves the pre-existing env-var-based behavior exactly.'
  ),
  expected_context_tokens: z.number().positive().optional().describe(
    'Optional estimate of how many tokens this dispatch will add ' +
    'to the target session\'s context. When set (or context_size is set), the server ' +
    'compares it against the session\'s remaining context-window headroom BEFORE ' +
    'invoking the LLM: too little headroom rejects the call with ' +
    '{reason: "insufficient_context_headroom", detail: {demand, headroom, window}} and no ' +
    'spawn; a fit that lands inside the safety margin still proceeds but attaches a ' +
    'structured contextWarning. Wins over context_size when both are set. Omitting both ' +
    'fields disables the check entirely -- pre-existing behavior is unchanged.'
  ),
  context_size: z.enum(['S', 'M', 'L']).optional().describe(
    'Optional size-bucket shorthand for expected_context_tokens: ' +
    'S/M/L map to configured token estimates (fleet defaults, overridable via ' +
    'config.json\'s contextAdmission.sizeBucketTokens). Ignored when expected_context_tokens ' +
    'is also set. The auto-sprint engine supplies this from the dispatched task\'s size ' +
    'metadata.'
  ),
}).strict();

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

function buildFailureMessage(agentName: string, result: SSHExecResult, provider: ProviderAdapter, parsed?: ParsedResponse): string {
  const output = result.stderr || result.stdout;
  // apra-fleet-p4f.2: prefer the already-parsed structured signal over the
  // stderr/stdout regex scan -- a max_turns-exhausted transcript can still
  // have auth-like noise in stderr (a stale warning, an unrelated retry
  // message, etc.) that would otherwise misclassify it as an auth failure.
  const category: PromptErrorCategory = isMaxTurnsResponse(parsed) ? 'max_turns' : provider.classifyError(output);
  if (category === 'max_turns') {
    return `[FAIL] Prompt on "${agentName}" was stopped after exhausting its turn limit (max_turns), not a genuine failure -- the model ran out of turns before finishing:
${output}`;
  }
  return category === 'auth'
    ? authErrorAdvice(agentName)
    : `[FAIL] Prompt failed on "${agentName}":
${output}`;
}

const SERVER_RETRY_DELAY_MS = 5000;

// A prompt written whole into a single remote exec command line can exceed
// the SSH exec channel's / Windows CreateProcess's command-line ceiling once
// the Windows path's UTF-16LE + base64 -EncodedCommand encoding (~2.67x
// inflation) is applied -- observed live (2026-07-30, fleet-win-dev1): a
// Review dispatch embedding full `bd show --json` output (description +
// acceptance criteria) for 5 beads produced a garbled "Unable to exec ..."
// response instead of real review output, because the encoded command line
// was too long for the remote shell to exec at all. Doer dispatches (small,
// just branch + bead ids) never hit this; only the larger Review-phase
// prompts do -- and only on Windows, where the encoding overhead is worst.
// Chunking keeps every single exec command line bounded regardless of total
// prompt size, on both OS paths (POSIX has a much higher real-world ceiling
// but shares the same underlying single-exec-command-line hazard).
const REMOTE_PROMPT_CHUNK_CHARS = 4000;

function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += REMOTE_PROMPT_CHUNK_CHARS) {
    chunks.push(content.slice(i, i + REMOTE_PROMPT_CHUNK_CHARS));
  }
  return chunks.length > 0 ? chunks : [''];
}

async function writePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string, content: string): Promise<void> {
  if (agent.agentType === 'local') {
    fs.writeFileSync(promptFilePath, content, 'utf-8');
    return;
  }
  const agentOs = getAgentOS(agent);
  const promptFileName = path.basename(promptFilePath);
  const remoteDir = path.dirname(promptFilePath);
  const chunks = chunkContent(content);

  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(remoteDir);
    for (let i = 0; i < chunks.length; i++) {
      const setup = i === 0 ? `New-Item -Path '${escapedFolder}' -ItemType Directory -Force | Out-Null; ` : '';
      const cmdlet = i === 0 ? 'Set-Content' : 'Add-Content';
      const psScript = `${setup}Set-Location "${escapedFolder}"; ${cmdlet} -Path "${promptFileName}" -Value '${chunks[i].replace(/'/g, "''")}' -NoNewline -Encoding UTF8`;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      // eslint-disable-next-line no-await-in-loop -- each chunk must land before the next appends
      await strategy.execCommand(`powershell -EncodedCommand ${encoded}`);
    }
  } else {
    const escapedFolder = escapeDoubleQuoted(remoteDir);
    for (let i = 0; i < chunks.length; i++) {
      const b64 = Buffer.from(chunks[i]).toString('base64');
      const redirect = i === 0 ? '>' : '>>';
      const mkdirPrefix = i === 0 ? `mkdir -p "${escapedFolder}" && ` : '';
      // eslint-disable-next-line no-await-in-loop -- each chunk must land before the next appends
      await strategy.execCommand(`${mkdirPrefix}cd "${escapedFolder}" && echo '${b64}' | base64 -d ${redirect} ${promptFileName}`);
    }
  }
}

async function deletePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string, extraPaths: string[] = []): Promise<void> {
  if (agent.agentType === 'local') {
    try { fs.unlinkSync(promptFilePath); } catch { /* ignore */ }
    for (const p of extraPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
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
    // apra-fleet-6z8.1: the durable stdout mirror is cleaned up in the SAME
    // round trip as the prompt file -- no extra exec per dispatch.
    const extras = extraPaths.map(p => ` "${escapeDoubleQuoted(p)}"`).join('');
    await strategy.execCommand(`cd "${escapedFolder}" && rm -f ${promptFileName}${extras}`).catch(() => { /* ignore */ });
  }
}

export function resolveModelForTier(agent: Agent, tier: string, provider: ProviderAdapter): string {
  const memberTiers = agent.modelTiers;
  if (memberTiers) {
    const t = tier as keyof typeof memberTiers;
    return memberTiers[t] ?? memberTiers.standard ?? memberTiers.cheap ?? Object.values(memberTiers).filter(Boolean)[0] as string;
  }
  return provider.modelForTier(tier as 'cheap' | 'standard' | 'premium');
}

/**
 * apra-fleet-b4g.6: the auto-harvest dispatch (below) is a server-internal
 * kb_harvest call, not an LLM-supplied repo_remote_url like the other kb_*
 * tools' hot paths (apra-fleet-b4g.1). Re-exported from
 * services/member-remote-url.ts, which documents the no-guessing rule and is
 * shared with member_detail (the fleet-sprint engine's only source for it).
 */
export { knownRepoRemoteUrl };

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
// (g) early returns before inFlightAgents.add (busy-rejection, reservation
//     conflict, no-LLM member): busy state never entered
// (h) preflight: the lock is claimed just before the preflight await (moved
//     here from the interactive/subprocess split further below, to close the
//     busy-check-to-lock-claim race window -- that split no longer calls
//     .add() itself, it relies on the claim made here). Both the {ok: false}
//     result path and preflightCheck() itself throwing release the lock
//     explicitly inline, since both return/rethrow before reaching any
//     finally block below

/**
 * apra-fleet-idb: liveness probe for a busy-locked member's backing process.
 * An inFlightAgents entry can outlive the process it was guarding -- a child
 * reaped without its 'close'/'error' handler ever firing (e.g. a hung SSH
 * channel that never signals exit, so clearStoredPid never runs), or an
 * interactive member's underlying claude process dying/disconnecting after
 * its session was registered -- permanently wedging the member: every future
 * dispatch would keep returning busy even though fleet_status's own
 * independent live-process check (src/tools/check-status.ts's
 * fleetProcessCheck) would report idle. Returns the confirmed-dead pid (used
 * only for the release warning) when the lock should self-heal, or undefined
 * when the member is genuinely busy.
 *
 * Conservative on ambiguity, deliberately: NO captured pid at all (neither an
 * interactive session pid nor a subprocess pid) is treated as still busy, not
 * as evidence of staleness -- a dispatch that has not reached its pid-capture
 * step yet must never be raced by a concurrent "self-heal" attempt. Only a
 * DEFINITIVE dead-pid reading releases the lock.
 */
async function findDeadLockPid(agent: Agent, workspaceId: string): Promise<number | undefined> {
  // Interactive sessions are always local (register_member's interactive
  // bootstrap is gated to isLocal members) -- the same local
  // process.kill(pid, 0) probe the eft.28.1 dead-session guard uses further
  // below applies directly here. Falls back to the durable lastKnownPid
  // anchor exactly like that guard does, so a disconnected-then-reconnected
  // session (pid lost on the live SessionState) is still checkable.
  const session = sessionRegistry.get(workspaceId, agent.id);
  const interactivePid = session?.pid ?? sessionRegistry.lastKnownPid(workspaceId, agent.id);
  if (interactivePid !== undefined && !isPidAlive(interactivePid)) {
    return interactivePid;
  }

  // Subprocess dispatch pid (local strategy or remote-over-SSH/relay). A
  // remote pid lives in a DIFFERENT machine's pid namespace -- process.kill()
  // -based isPidAlive is meaningless there (it would almost always read back
  // ESRCH for a pid that simply does not exist on THIS machine, wrongly
  // declaring a genuinely-alive remote session dead and racing a duplicate
  // dispatch onto it). Probe it the same way orphan-recovery's lease-of-life
  // gate does instead: a fresh, independent SSH round trip, never the
  // (possibly wedged) channel that produced the stale lock.
  const subprocessPid = getStoredPid(agent.id);
  if (subprocessPid !== undefined) {
    const alive = agent.agentType === 'local'
      ? isPidAlive(subprocessPid)
      : await isRemoteProcessAlive(getStrategy(agent), subprocessPid, getAgentOS(agent));
    if (!alive) return subprocessPid;
  }

  return undefined;
}

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
    return `[FAIL] Failed to deliver prompt to "${agent.friendlyName}" (interactive session): ${parsed.error}`;
  }

  try {
    const response = await waitForInteractiveResponse(agent, workspaceId, parsed.msgid, timeoutS * 1000, scope);
    scope.ok('interactive response received');
    let output = `[RESULT] Response from ${agent.friendlyName}:\n\n${response}`;
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
    return `[FAIL] Timed out waiting for "${agent.friendlyName}" to respond (interactive session, ${timeoutS}s). The prompt was delivered; the member may still respond late, but this call has given up waiting.`;
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
    return `[FAIL] Failed to execute prompt on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
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
  // packages/apra-fleet-se/fleet-sprint/runner.js) -- and fall back to
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
    // apra-fleet-idb: before honoring the busy rejection, verify the locked
    // session actually still has a live backing process -- see
    // findDeadLockPid's docstring for the full rationale. This is what keeps
    // fleet_status (which decides busy/idle from its own independent live
    // process check) and this dispatch gate from ever disagreeing: a stale
    // lock self-heals here instead of permanently wedging the member.
    const staleLockPid = await findDeadLockPid(agent, getTokenIssuer().workspaceId());
    if (staleLockPid !== undefined) {
      logWarn('busy_lock', `orphaned busy-lock for "${agent.friendlyName}" -- locked pid=${staleLockPid} is confirmed dead; releasing the stale lock and proceeding with this dispatch instead of rejecting it as busy`, agent);
      inFlightAgents.delete(agent.id);
      getStallDetector().remove(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
    } else {
      return {
        text: `[FAIL] execute_prompt is already running for "${agent.friendlyName}". Wait for the current call to finish before sending another.`,
        structuredContent: { isError: true, reason: 'busy' },
      };
    }
  }

  // No-LLM members (apra-fleet-us9.14) are plain command executors -- neither
  // execute_prompt mode applies (there is no LLM to prompt in either a
  // subprocess or an interactive session). Rejected here, before any busy
  // state is entered, rather than relying on NoneProvider's methods to throw
  // deeper in either dispatch path.
  if (agent.llmProvider === 'none') {
    return `[FAIL] "${agent.friendlyName}" has no LLM provider (llm_provider: "none") -- it is a plain command executor. Use execute_command instead.`;
  }

  // Claim the busy lock BEFORE the preflight await, not after (as it
  // originally was further below at the interactive/subprocess split).
  // preflightCheck can take up to ~30s on a cache miss; leaving the busy-check
  // (line ~546) and the lock claim ~150 lines apart left a window where two
  // near-simultaneous dispatches to the same member could both pass the busy
  // check (neither had claimed the lock yet), both await preflight, and both
  // proceed to double-dispatch. Every return path from here to the
  // interactive/subprocess split below (currently only the preflight-failure
  // return immediately following) must release this lock explicitly, since
  // it now returns AFTER the lock is claimed instead of before.
  inFlightAgents.add(agent.id);

  // Peek at session state early so the preflight check can skip interactive
  // members whose dispatch routes through a live MCP push channel, not SSH.
  const earlyWorkspaceId = getTokenIssuer().workspaceId();
  const earlySession = sessionRegistry.get(earlyWorkspaceId, agent.id);
  const isChannelCapable = !!earlySession?.channelCapable;

  // Pre-dispatch readiness check (apra-fleet preflight-check): verify
  // connectivity and LLM auth BEFORE the expensive prompt dispatch
  // (writePromptFile + CLI invocation). Catches expired OAuth, missing
  // credentials, and offline members in <1s instead of burning a full
  // round trip. Local members and interactive sessions are excluded
  // (local shares this machine's credentials; interactive sessions have
  // their own liveness probes). The check is cached for 60s so
  // back-to-back dispatches do not add latency.
  if (agent.agentType !== 'local' && !isChannelCapable) {
    let preflight: Awaited<ReturnType<typeof preflightCheck>>;
    try {
      preflight = await preflightCheck(agent);
    } catch (err) {
      // preflightCheck's own synchronous prologue (getStrategy/getProvider)
      // and its internal exec calls are not fully guarded -- if it throws
      // instead of resolving {ok: false}, the lock claimed above would
      // otherwise leak forever (no pid captured yet for findDeadLockPid's
      // stale-lock self-heal to recognize). Release and propagate unchanged
      // -- this preserves the exact same exception the caller would have
      // seen before the lock was claimed this early.
      inFlightAgents.delete(agent.id);
      throw err;
    }
    if (!preflight.ok) {
      // R2-F5: use preflight-specific reason codes so fleet-sprint can
      // distinguish pre-dispatch failures from in-dispatch ones and avoid
      // inappropriate self-heal loops (e.g. re-provisioning auth when the
      // member is simply offline).
      const preflightReason: ExecutePromptStructured['reason'] =
        preflight.code === 'offline' ? 'preflight_offline'
        : preflight.code === 'auth_expired' ? 'preflight_auth_expired'
        : preflight.code === 'auth_missing' ? 'preflight_auth_missing'
        : 'dispatch_failed';
      // Release the lock claimed above -- this return happens before the
      // interactive/subprocess split's own add+finally cleanup ever runs.
      inFlightAgents.delete(agent.id);
      return {
        text: `[FAIL] Pre-dispatch check failed for "${agent.friendlyName}": ${preflight.reason}`,
        structuredContent: {
          isError: true,
          reason: preflightReason,
        },
      };
    }
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
  // Gated by capability, not provider name (apra-fleet-cqa, eft.74 follow-up):
  // mode (b) -- server-push mid-session prompt injection -- was POC-proven on
  // Claude via the provider-branded `notifications/claude/channel` capability
  // (apra-fleet-us9.9's survey, docs/interactive-injection-provider-survey.md),
  // but the routing decision itself must be provider-agnostic: whatever the
  // provider, a session is only an interactive-routing candidate if it
  // actually declared that capability at MCP initialize time (recorded as
  // SessionState.channelCapable below). Gemini/Codex are confirmed [FAIL]
  // today (no equivalent push mechanism) and so never end up channelCapable in
  // practice, but that is a fact about what each provider adapter currently
  // advertises, not a name-based pre-filter here -- any provider that
  // implements the same MCP channel capability is picked up automatically. A
  // member CAN still have a live sessionRegistry entry (registerMcpEndpoint
  // gives it basic MCP tool access, apra-fleet-fnz.1-3) without that meaning
  // it can receive or act on this push -- routing to it anyway would silently
  // spend the full timeout_s waiting for a response that can never arrive.
  // R2-F3: re-query session registry after the preflight await (10-20s) so
  // interactive routing sees sessions that became channelCapable during that
  // window, rather than using the stale pre-preflight snapshot.
  const workspaceId = getTokenIssuer().workspaceId();
  const rawSession = sessionRegistry.get(workspaceId, agent.id);
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
    ?? sessionRegistry.lastKnownPid(workspaceId, agent.id);
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
    // Lock already claimed above, before the preflight await -- do not
    // re-add here (Set.add would be a harmless no-op, but keeping a second
    // add site invites the lock and its release to drift out of sync).
    writeStatusline(new Map([[agent.id, 'busy']]));
    try {
      return await executePromptInteractive(agent, renderedPrompt, input, workspaceId, heuristicWarningSuffix);
    } finally {
      inFlightAgents.delete(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
    }
  }

  // Lock already claimed above, before the preflight await.

  await ensureAgentFilesProvisioned(agent);
  const stallDetector = getStallDetector();
  let clearedByStall = false;
  // apra-fleet-3c9.1: a CONFIRMED stall must not only kill the remote pid but
  // also cancel the in-flight strategy.execCommand() promise. Before this, the
  // client kept waiting out its full deriveTimeoutMs deadline after the
  // server-side work had already died (the 60.5-min hung dispatch in
  // apra-fleet-3c9). onStall aborts this controller; its signal is merged into
  // the signal handed to every execCommand below (see dispatchSignal), so a
  // confirmed stall settles the pending dispatch immediately and surfaces a
  // typed 'stalled' error instead of hanging.
  const stallAbortController = new AbortController();
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
      // apra-fleet-6z8.2: a CONFIRMED stall means the remote turn made no
      // progress of any kind for the whole threshold. Clearing bookkeeping
      // alone left that wedged process running indefinitely on the member --
      // burning its LLM session, holding its work folder, and colliding with
      // whatever dispatch takes the member next. Kill the tracked pid too.
      // Best-effort and never awaited: onStall is a fire-and-forget callback
      // from the poll loop, and tryKillPid already swallows its own errors.
      void tryKillPid(agent, strategy, cmds).catch(() => {});
      // apra-fleet-3c9.1: killing the remote pid alone left the pending
      // execCommand promise still awaiting its full deadline. Abort it now so
      // the dispatch settles promptly and returns a typed 'stalled' error.
      try { stallAbortController.abort(); } catch { /* best-effort */ }
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

  // Resume semantics (apra-fleet-eft.78.1). `resume` is boolean | string:
  //  - true   -> best-effort resume of the member's stored last session; a
  //              stale/unknown stored session transparently retries fresh.
  //  - false  -> always a fresh session.
  //  - string -> EXPLICIT session-id resume: resume exactly this id, preferring
  //              it over agent.sessionId. The caller asserts the prompt depends
  //              on that session's context, so an unknown/expired id is a
  //              TERMINAL session_not_found (handled just below) and NO
  //              fresh-session fallback is ever applied (see the retry paths).
  const explicitResumeId = (typeof input.session_id === 'string' && input.session_id.trim().length > 0)
    ? input.session_id.trim()
    : (typeof input.resume === 'string' && input.resume.length > 0 ? input.resume : undefined);
  const resumeRequested = input.resume === true || explicitResumeId !== undefined;
  const resumeTargetId = explicitResumeId ?? agent.sessionId;
  // An explicit-id resume must never silently degrade to a fresh session: that
  // is exactly the wrong-context dispatch this feature forbids. resume=true and
  // resume=false keep their pre-existing transparent recovery.
  const allowFreshSessionFallback = explicitResumeId === undefined;
  const resuming = !!(resumeRequested && resumeTargetId && provider.supportsResume());
  const isCallerMinted = provider.sessionIdStrategy().type === 'caller-minted';
  const mintedId = isCallerMinted
    ? (resuming ? resumeTargetId! : uuid())
    : (resuming ? resumeTargetId : undefined);

  // Terminal session-not-found gate for explicit-id resumes (apra-fleet-eft.78.1).
  // Checked BEFORE any spawn (writePromptFile / the LLM invocation): if the
  // caller named a session the server has never issued for this member -- and it
  // is not the member's currently-stored session -- there is no context to
  // resume. Reject with a structured session_not_found and make NO LLM call,
  // so an orchestrator can rebuild a self-contained prompt and re-dispatch fresh
  // deliberately, rather than getting a silent blank-session response.
  if (explicitResumeId !== undefined) {
    const resumable = provider.supportsResume()
      && (isKnownSession(agent.id, explicitResumeId) || explicitResumeId === agent.sessionId);
    if (!resumable) {
      scope.abort(`explicit resume rejected -- session "${explicitResumeId}" is unknown/expired (no LLM call)`);
      inFlightAgents.delete(agent.id);
      stallDetector.remove(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
      return {
        text: `[FAIL] execute_prompt on "${agent.friendlyName}" rejected -- session "${explicitResumeId}" cannot be resumed (unknown or expired). No LLM call was made. Rebuild the context and re-dispatch with a full, self-contained prompt (resume=false), or resume=true for best-effort recovery.`,
        structuredContent: { isError: true, reason: 'session_not_found', sessionId: explicitResumeId },
      };
    }
  }

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

  // apra-fleet issue #390: session log paths live on the MEMBER's machine, under
  // the MEMBER's home directory, joined with the MEMBER's OS convention. Before
  // this, every remote member got a HUB-home path (os.homedir()) joined with the
  // HUB's path convention -- a path that can never exist on the member, which
  // silently disabled stall detection for Claude/Gemini and manufactured
  // false-positive stall kills for AGY/OpenCode.
  //
  // This resolution is deliberately SYNCHRONOUS (cached probe result, else the
  // member's known login username's default home): the dispatch path must not
  // add a remote round trip, and a wrong guess here can only cost detection
  // fidelity, never cause a kill. The kill-capable directory poll in
  // stall-poller.ts uses the probe-backed async resolver instead.
  const memberPathCtx = getCachedMemberPathContext(agent);

  const activePreSpawnSid = resuming ? resumeTargetId : (isCallerMinted ? mintedId : undefined);
  let resolvedLogPath: string | null = null;
  if (activePreSpawnSid) {
    try {
      resolvedLogPath = resolveSessionLogPath(agent.llmProvider ?? 'claude', activePreSpawnSid, resolvedWorkFolder, memberPathCtx.homeDir, memberPathCtx.targetOs);
    } catch {
      resolvedLogPath = null;
    }
  }
  stallDetector.update(agent.id, {
    sessionId: activePreSpawnSid,
    logFilePath: resolvedLogPath,
    provisional: !resolvedLogPath,
  });

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);

  // apra-fleet-6z8.1: the per-invocation durable stdout mirror the unix prompt
  // wrapper tees to (see durableOutputPath / buildAgentPromptCommand). Windows
  // members have no such companion tee, so recovery is skipped for them.
  const durablePath = getAgentOS(agent) === 'windows' ? undefined : durableOutputPath(scope.getInv());
  const dispatchStartedAt = Date.now();

  const timeoutMs = (input.timeout_s ?? 300) * 1000;
  const maxTotalMs = input.max_total_s !== undefined ? input.max_total_s * 1000 : undefined;

  // apra-fleet-y8q.1: every retry below (dispatch-exception, stale-session,
  // server-overloaded) re-dispatches with a FRESH session but used to reuse the
  // SAME full timeoutMs/maxTotalMs as the original attempt -- so a single
  // dispatch could burn up to ~2x max_total_s server-side (original attempt +
  // one full-budget retry), well past what the client's deriveTimeoutMs()
  // (packages/apra-fleet-client/src/client/api.mjs) budgets for the whole
  // tools/call (max_total_s*1000 + a fixed grace margin). That let the
  // client's hard timeout fire before the server's own retry-and-report path
  // ever got a chance, hiding a clean typed server error behind a raw client
  // transport timeout. Share ONE deadline budget across the original attempt
  // and any single retry: cap a retry's maxTotalMs (and its inactivity
  // timeoutMs, so it can't independently outlast the shared ceiling) to
  // whatever remains of max_total_s since dispatchStartedAt, and skip the
  // retry entirely once that budget is exhausted -- so total wall-clock time
  // for this call never exceeds max_total_s, which is exactly what the client
  // is prepared to wait for. When max_total_s is absent there is no hard
  // ceiling to share, so retries keep their full timeout_s (unchanged,
  // pre-existing behavior).
  function retryBudget(): { timeoutMs: number; maxTotalMs: number | undefined; exhausted: boolean } {
    if (maxTotalMs === undefined) return { timeoutMs, maxTotalMs: undefined, exhausted: false };
    const remaining = Math.max(0, maxTotalMs - (Date.now() - dispatchStartedAt));
    return { timeoutMs: Math.min(timeoutMs, remaining), maxTotalMs: remaining, exhausted: remaining <= 0 };
  }

  // Agent file validation -- verify named agent exists before any CLI invocation
  if (input.agent) {
    const dirs = provider.agentDirectories(input.agent);
    let agentFound = false;
    if (agent.agentType === 'local') {
      const projPath = path.join(resolvedWorkFolder, dirs.project);
      const userPath = path.join(os.homedir(), dirs.home);
      agentFound = fs.existsSync(projPath) || fs.existsSync(userPath);
      if (!agentFound) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found.\n\nExpected at:\n  ${projPath.replace(/\\/g, '/')}\n  ${userPath.replace(/\\/g, '/')}`;
      }
    } else {
      // Canonical PM role agents (planner/doer/reviewer/plan-reviewer/...) are
      // already guaranteed present in ~/dirs.home by
      // ensureAgentFilesProvisioned() above (ln ~576, which ran provisionAgents()
      // for this exact member earlier in this same call) -- trust that instead
      // of re-probing the remote here. This also SIDESTEPS the bug this check
      // used to have: the old code hand-rolled a POSIX-only
      // `test -f ... || test -f ...` command run via strategy.execCommand(),
      // which throws a PowerShell parser error (not a POSIX shell) on every
      // Windows remote -- a nonzero exit that this check misread as "agent not
      // found" even when the file genuinely existed (apra-fleet P0 bug, fleet-
      // sprint via a Windows remote member always failed plan-review with
      // "agent 'plan-reviewer' not found").
      const canonicalRelPath = `${input.agent}.md`;
      agentFound = remoteAgentsDir(provider.name) !== null
        && loadCanonicalAgentSet(provider.name).some((f) => f.relPath === canonicalRelPath);

      if (!agentFound) {
        // Not part of the canonical PM set (e.g. a project-local custom
        // agent) -- fall back to a REAL existence probe, built platform-aware
        // via this repo's own getOsCommands() abstraction (src/os/*.ts,
        // already used the same way by list-members.ts/member-detail.ts for
        // credential-file checks) instead of a single hardcoded shell dialect.
        const cmds = getOsCommands(getAgentOS(agent));
        const projPath = `${resolvedWorkFolder}/${dirs.project}`;
        const userPath = `~/${dirs.home}`;
        const [projResult, userResult] = await Promise.all([
          strategy.execCommand(cmds.credentialFileCheck(projPath), 10000),
          strategy.execCommand(cmds.credentialFileCheck(userPath), 10000),
        ]);
        agentFound = projResult.stdout.includes('found') || userResult.stdout.includes('found');
      }

      if (!agentFound) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found on "${agent.friendlyName}".\n\nExpected at:\n  ${resolvedWorkFolder}/${dirs.project}\n  ~/${dirs.home}`;
      }
    }
  }

  // Context-headroom admission control (apra-fleet-eft.81.1): a declared
  // demand is checked against this session's remaining headroom BEFORE any
  // CLI is spawned. No declared demand (both fields omitted) means this
  // block is skipped entirely -- pre-existing behavior is unchanged.
  const contextDemand = resolveExpectedDemand(input.expected_context_tokens, input.context_size);
  let contextWarning: ExecutePromptStructured['contextWarning'];
  if (contextDemand !== undefined) {
    const admission = checkContextAdmission({
      provider: provider.name,
      resolvedModel,
      sessionId: mintedId,
      demand: contextDemand,
    });
    if (!admission.allowed) {
      scope.abort(`insufficient context headroom: demand=${admission.detail.demand} headroom=${admission.detail.headroom} window=${admission.detail.window}`);
      inFlightAgents.delete(agent.id);
      stallDetector.remove(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
      return {
        text: `[FAIL] execute_prompt on "${agent.friendlyName}" rejected -- insufficient context headroom (demand=${admission.detail.demand}, headroom=${admission.detail.headroom}, window=${admission.detail.window}). Start a fresh session, shrink the task, or split it.`,
        structuredContent: { isError: true, reason: 'insufficient_context_headroom', detail: admission.detail },
      };
    }
    if (admission.warning) {
      contextWarning = { message: admission.warning, detail: admission.detail };
    }
  }

  // Usage/budget admission (apra-fleet-eft.80.2): when a budget is configured
  // for this member (or its workspace), a hard-threshold crossing rejects the
  // NEW dispatch BEFORE any LLM is spawned -- never killing an in-flight call.
  // No configured budget (the common case) means resolveBudgetScope returns
  // undefined and this block is skipped entirely -- behavior is unchanged.
  const budgetScope = resolveBudgetScope([agent.id, workspaceId]);
  if (budgetScope) {
    const preBudget = await evaluateBudget({ scope: budgetScope, agent, provider });
    if (preBudget?.exhausted) {
      scope.abort(`budget exhausted: scope=${budgetScope} spent=${preBudget.block.spent} budget=${preBudget.block.budget} source=${preBudget.block.source}`);
      inFlightAgents.delete(agent.id);
      stallDetector.remove(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
      return {
        text: `[FAIL] execute_prompt on "${agent.friendlyName}" rejected -- budget exhausted (scope=${budgetScope}, spent=${preBudget.block.spent}, budget=${preBudget.block.budget} ${preBudget.block.unit}, source=${preBudget.block.source}). No LLM call was made; raise or reset the budget to resume.`,
        structuredContent: { isError: true, reason: 'budget_exhausted', budgetUsage: preBudget.block },
      };
    }
  }

  // Kill any leftover session from a previous (possibly zombie) execute_prompt call
  await tryKillPid(agent, strategy, cmds);

  // Write the rendered prompt (with substitutions applied) to the prompt file before execution
  await writePromptFile(agent, strategy, promptFilePath, renderedPrompt);

  // apra-fleet-6z8.1: remembered for the lease-of-life gate below -- the pid
  // outlives the SSH channel that reported it, and is the only way to tell a
  // fabricated "exit 0 / empty" close apart from a real one.
  let capturedPid: number | undefined;
  const onPidCaptured = (pid: number) => {
    capturedPid = pid;
    scope.info(`pid=${pid}`);
    if (mintedId) {
      let logPath: string | null = null;
      try {
        logPath = resolveSessionLogPath(agent.llmProvider ?? 'claude', mintedId, resolvedWorkFolder, memberPathCtx.homeDir, memberPathCtx.targetOs);
      } catch {
        logPath = null;
      }
      stallDetector.update(agent.id, {
        sessionId: mintedId,
        logFilePath: logPath,
        provisional: !logPath,
      });
    }
  };

  const abortHandler = () => {
    scope.abort('cancelled by MCP client');
    tryKillPid(agent, strategy, cmds).catch(() => {});
  };
  extra?.signal?.addEventListener('abort', abortHandler);

  // apra-fleet-3c9.1: the signal handed to execCommand fires on EITHER the MCP
  // client's cancellation OR a confirmed stall (stallAbortController). Merging
  // them means a stall aborts the pending dispatch exactly as a client cancel
  // would, while a live (non-stalled) dispatch -- whose controller is never
  // aborted -- is left completely untouched.
  const dispatchSignal = extra?.signal
    ? AbortSignal.any([extra.signal, stallAbortController.signal])
    : stallAbortController.signal;

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  let _epExitCode: number | 'error' = 'error';
  let _epError: string | undefined;
  let _epUsage: { input_tokens: number; output_tokens: number } | undefined;
  let _epOffline = false;
  // apra-fleet-6a7.1: gates the exit-0/empty-stdout workspace_not_trusted
  // self-heal-and-retry below to exactly one attempt per call, mirroring
  // runGitStep's authHealAttempted shape (fleet-sprint/runner.js:616) -- a
  // repeat trust failure after the heal is terminal, never looped.
  let trustHealAttempted = false;
  try {
    let result;
    try {
      result = await strategy.execCommand(claudeCmd, timeoutMs, maxTotalMs, onPidCaptured, dispatchSignal);
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
      // apra-fleet-3c9.1: a stall-triggered abort is terminal. onStall already
      // killed the remote process and its session is gone, so retrying in a
      // fresh session would just re-dispatch onto a member we just tore down.
      // Let the exception surface to the outer catch, which classifies it as a
      // typed 'stalled' error instead of retrying or hanging.
      if (stallAbortController.signal.aborted) throw dispatchErr;
      // apra-fleet-eft.78.1: an explicit-id resume must NOT retry in a fresh
      // session (that would run a context-dependent delta prompt with no
      // context). Let the exception surface as dispatch_failed instead.
      if (!allowFreshSessionFallback) throw dispatchErr;
      // apra-fleet-y8q.1: no budget left to share with a retry (the original
      // attempt already consumed the whole max_total_s) -- retrying here would
      // just re-burn a fresh full budget past what the client is waiting for.
      // Let the original exception surface instead of retrying blind.
      const budget = retryBudget();
      if (budget.exhausted) throw dispatchErr;
      scope.info(`[${resolvedModel}] retrying -- dispatch exception: ${dispatchErr.message}`);
      await tryKillPid(agent, strategy, cmds);
      const freshOpts = { ...promptOpts, sessionId: isCallerMinted ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, budget.timeoutMs, budget.maxTotalMs, onPidCaptured, dispatchSignal);
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
        text: `[FAIL] ${workspaceNotTrustedAdvice(agent.friendlyName)}\n${result.stderr || result.stdout}`,
        structuredContent: { isError: true, reason: 'workspace_not_trusted' },
      };
    }

    // Stale session retry -- fresh session ID, no resume. apra-fleet-eft.78.1:
    // ONLY the best-effort resume=true mode gets this transparent retry-fresh
    // recovery. An explicit session-id resume (string) deliberately does NOT --
    // its caller asserted context dependence, so a not-found id is terminal.
    if (result.code !== 0 && input.resume === true && agent.sessionId) {
      // apra-fleet-y8q.1: share the remaining max_total_s budget with this
      // retry too -- skip it outright once exhausted (see retryBudget above).
      const staleBudget = retryBudget();
      if (!staleBudget.exhausted) {
        scope.info(`[${resolvedModel}] retrying -- stale session`);
        await tryKillPid(agent, strategy, cmds);
        const freshOpts = { ...promptOpts, sessionId: isCallerMinted ? uuid() : undefined, resuming: false };
        const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
        result = await strategy.execCommand(retryCmd, staleBudget.timeoutMs, staleBudget.maxTotalMs, onPidCaptured, dispatchSignal);
        parsed = provider.parseResponse(result);
        if (parsed.usage) _epUsage = parsed.usage;
      }
    }

    // Server/overloaded error retry -- single attempt after delay. Skipped for
    // an explicit-id resume (apra-fleet-eft.78.1): the retry starts a fresh
    // session, which would discard the exact context the caller asked to resume.
    if (result.code !== 0 && allowFreshSessionFallback && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      // apra-fleet-y8q.1: share the remaining max_total_s budget with this
      // retry too -- skip it outright once exhausted (see retryBudget above).
      const overloadBudget = retryBudget();
      if (!overloadBudget.exhausted) {
        scope.info(`[${resolvedModel}] retrying -- server overloaded`);
        await tryKillPid(agent, strategy, cmds);
        await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
        const freshOpts = { ...promptOpts, sessionId: isCallerMinted ? uuid() : undefined, resuming: false };
        const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
        result = await strategy.execCommand(retryCmd, overloadBudget.timeoutMs, overloadBudget.maxTotalMs, onPidCaptured, dispatchSignal);
        parsed = provider.parseResponse(result);
        if (parsed.usage) _epUsage = parsed.usage;
      }
    }

    _epExitCode = result.code;
    if (result.code !== 0) {
      // apra-fleet-391: surface an auth failure as a STRUCTURED reason (not
      // just prose in `text`) so callers -- notably fleet-sprint's
      // isAuthDispatchError -- can key off it directly instead of regexing
      // the message string. Overloading 'nonzero_exit' for this case was
      // what made auth self-heal impossible to wire reliably upstream.
      const failureCategory: PromptErrorCategory = isMaxTurnsResponse(parsed)
        ? 'max_turns'
        : provider.classifyError(result.stderr || result.stdout);
      return {
        text: buildFailureMessage(agent.friendlyName, result, provider, parsed),
        structuredContent: {
          isError: true,
          reason: failureCategory === 'max_turns'
            ? 'max_turns_exhausted'
            : failureCategory === 'auth'
              ? 'auth'
              : failureCategory === 'server'
                ? 'server'
                : failureCategory === 'overloaded'
                  ? 'overloaded'
                  : failureCategory === 'workspace_not_trusted'
                    ? 'workspace_not_trusted'
                    : 'nonzero_exit',
          // apra-fleet-63x.1: a nonzero exit -- most commonly max_turns_exhausted,
          // where the CLI ran real turns and burned real tokens before hitting its
          // ceiling -- still has a REAL parsed usage figure sitting in _epUsage
          // (captured just above from `parsed.usage` regardless of exit code).
          // This branch used to return no `usage` field at all on any failure,
          // so FleetWorkflow.agent() (packages/apra-fleet-workflow/src/workflow/
          // index.mjs, apra-fleet-202.3) saw hasRealUsage=false and never priced
          // it, silently under-counting a sprint's tracked spend (observed: a
          // 10-hour run with dozens of max_turns exhaustions reporting
          // stats.totalCost of $0). Attach it here whenever it's available so
          // the caller can record the real partial cost instead of nothing.
          ...(_epUsage ? { usage: { input_tokens: _epUsage.input_tokens, output_tokens: _epUsage.output_tokens, total_tokens: _epUsage.input_tokens + _epUsage.output_tokens } } : {}),
        },
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
    //
    // apra-fleet-6z8.1 (lease-of-life gate): before declaring that, cross-check
    // whether the captured pid is STILL ALIVE via a fresh short exec. ssh.ts
    // substitutes code 0 when the channel closes without ever receiving an
    // 'exit' event, so "exit 0 + empty" is ALSO exactly what a torn-down
    // channel over a perfectly healthy, still-running turn looks like (live
    // evidence: pid 89858 running 2+ minutes past the close). Declaring
    // empty_response there orphans the CLI and invites a duplicate concurrent
    // dispatch of the same scope. A confirmed-dead pid keeps today's behavior
    // verbatim.
    if (!parsed.result || parsed.result.trim() === '') {
      const recovery = await recoverOrphanedDispatch({
        strategy,
        cmds,
        pid: capturedPid,
        durablePath,
        unsupported: getAgentOS(agent) === 'windows',
        os: getAgentOS(agent),
        maxWaitMs: maxTotalMs !== undefined ? Math.max(maxTotalMs - (Date.now() - dispatchStartedAt), 0) : undefined,
        scope,
      });

      if (recovery.status === 'timeout') {
        scope.info(`orphan recovery timed out after ${Math.round((recovery.waitedMs ?? 0) / 1000)}s -- pid killed`);
        return {
          text: `[FAIL] execute_prompt on "${agent.friendlyName}" lost its SSH channel while the member CLI (pid ${capturedPid}) was still running, and that process was still alive after the recovery window (${Math.round((recovery.waitedMs ?? 0) / 1000)}s). The process has been killed; no result was recovered. This is NOT an empty response -- do not treat it as a failed turn without checking the member's session transcript first.`,
          structuredContent: { isError: true, reason: 'orphan_recovery_timeout' },
        };
      }

      if (recovery.status === 'recovered' && recovery.stdout) {
        // Feed the durable output through the normal provider parse path,
        // exactly as if it had arrived on the original channel.
        const recoveredParsed = provider.parseResponse({ stdout: recovery.stdout, stderr: result.stderr ?? '', code: 0 });
        if (recoveredParsed.result && recoveredParsed.result.trim() !== '') {
          scope.info(`recovered the real result from the durable output file after a false-alarm empty_response (waited ${Math.round((recovery.waitedMs ?? 0) / 1000)}s)`);
          parsed = recoveredParsed;
          if (parsed.usage) _epUsage = parsed.usage;
        }
      }

      // apra-fleet-6a7.1: the code!==0 workspace_not_trusted classification
      // above (~line 1048) never sees this branch -- exit 0 + empty stdout is
      // a SEPARATE path, but live evidence (apra-fleet-2g2, fleet-win-dev1,
      // 2026-08-02) showed it can be caused by the exact same trust-gate
      // failure: exited 0, empty stdout, and the stderr tail contained the
      // exact matched phrase, so the code!==0 classifier never ran. Classify
      // it here too and -- unlike that path, which only advises a manual fix
      // -- self-heal via the same seedWorkspaceTrust/ensureWorkspaceTrusted
      // path compose_permissions already uses, then retry the dispatch
      // exactly once (gated by trustHealAttempted, mirroring runGitStep's
      // onAuthFailure shape: a repeat failure after the heal is terminal, not
      // looped).
      if ((!parsed.result || parsed.result.trim() === '')
        && allowFreshSessionFallback
        && provider.classifyError(result.stderr || result.stdout) === 'workspace_not_trusted'
        && !trustHealAttempted) {
        trustHealAttempted = true;
        scope.info(`[${resolvedModel}] exit-0/empty-stdout classified as workspace_not_trusted -- self-healing (seedWorkspaceTrust) once, then retrying the dispatch`);
        await seedWorkspaceTrust(agent, strategy, 'execute_prompt');
        const healBudget = retryBudget();
        if (!healBudget.exhausted) {
          await tryKillPid(agent, strategy, cmds);
          const freshOpts = { ...promptOpts, sessionId: isCallerMinted ? uuid() : undefined, resuming: false };
          const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
          result = await strategy.execCommand(retryCmd, healBudget.timeoutMs, healBudget.maxTotalMs, onPidCaptured, dispatchSignal);
          parsed = provider.parseResponse(result);
          if (parsed.usage) _epUsage = parsed.usage;
        }
      }

      if (!parsed.result || parsed.result.trim() === '') {
        const stderrTail = (result.stderr || '').trim().slice(-500);
        const trustClassified = provider.classifyError(result.stderr || result.stdout) === 'workspace_not_trusted';
        return {
          text: trustClassified
            ? `[FAIL] ${workspaceNotTrustedAdvice(agent.friendlyName)}\n${stderrTail}`
            : `[FAIL] execute_prompt on "${agent.friendlyName}" exited 0 but produced no parseable output (empty result -- the member CLI likely died mid-turn without printing its result envelope).${stderrTail ? `\n[stderr tail]\n${stderrTail}` : ''}`,
          structuredContent: { isError: true, reason: trustClassified ? 'workspace_not_trusted' : 'empty_response' },
        };
      }
    }

    // Session-id assertion: returned id must match the one we minted/resumed
    const expectedSid = resuming ? resumeTargetId : (isCallerMinted ? mintedId : undefined);
    const isMismatch = expectedSid && parsed.sessionId && parsed.sessionId !== expectedSid;
    if (isMismatch) {
      scope.info(`session-id mismatch: expected=${expectedSid} got=${parsed.sessionId} -- not persisting`);
      if (!allowFreshSessionFallback && explicitResumeId !== undefined) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        clearStoredPid(agent.id);
        if (parsed.sessionId) {
          recordKnownSession(agent.id, parsed.sessionId);
        }
        if (parsed.usage) {
          const prev = agent.tokenUsage ?? { input: 0, output: 0 };
          updateAgent(agent.id, {
            tokenUsage: {
              input: prev.input + parsed.usage.input_tokens,
              output: prev.output + parsed.usage.output_tokens,
            },
          });
          recordSessionUsage(parsed.sessionId ?? expectedSid, parsed.usage);
          if (budgetScope) {
            await recordAndEvaluate({ scope: budgetScope, agent, provider, tier: resolvedTier, usage: parsed.usage });
          }
        }
        return {
          text: `[FAIL] execute_prompt on "${agent.friendlyName}" failed -- resumed session mismatch. Expected session "${expectedSid}", but provider returned "${parsed.sessionId}".`,
          structuredContent: {
            isError: true,
            reason: 'session_not_found',
            sessionId: expectedSid,
            returnedSessionId: parsed.sessionId,
            ...(parsed.usage ? { usage: { ...parsed.usage, total_tokens: parsed.usage.input_tokens + parsed.usage.output_tokens } } : {}),
          },
        };
      }
      touchAgent(agent.id, undefined);
    } else {
      touchAgent(agent.id, parsed.sessionId ?? expectedSid);
    }
    // apra-fleet-eft.78.1: mark the session this dispatch actually landed on as
    // known/resumable for this member, so a later explicit-id resume of it
    // passes the terminal session_not_found gate above instead of being
    // rejected as unknown.
    const finalSid = parsed.sessionId ?? expectedSid;
    if (finalSid) {
      recordKnownSession(agent.id, finalSid);
      let postLogPath: string | null = null;
      try {
        postLogPath = resolveSessionLogPath(agent.llmProvider ?? 'claude', finalSid, resolvedWorkFolder, memberPathCtx.homeDir, memberPathCtx.targetOs);
      } catch {
        postLogPath = null;
      }
      stallDetector.update(agent.id, {
        sessionId: finalSid,
        logFilePath: postLogPath,
        provisional: !postLogPath,
      });
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
      // Per-session cumulative tracking for context-headroom admission
      // (apra-fleet-eft.81.1) -- separate from the per-member lifetime total
      // just above. Keyed by whichever session id this dispatch actually
      // landed on (the returned id, falling back to the minted/resumed one),
      // so the NEXT admission check on this same session sees this dispatch's
      // usage already accounted for.
      recordSessionUsage(parsed.sessionId ?? mintedId, parsed.usage);
    }

    // Usage/budget accounting (apra-fleet-eft.80.2): account this dispatch's
    // token usage against the scope's budget (self-metered only when the
    // provider has no native getUsage()), then attach the usage block to the
    // result when the warning band is crossed. Nothing is attached below the
    // band, and nothing happens at all when no budget is configured.
    let budgetUsage: BudgetUsageBlock | undefined;
    if (budgetScope && parsed.usage) {
      const postBudget = await recordAndEvaluate({ scope: budgetScope, agent, provider, tier: resolvedTier, usage: parsed.usage });
      if (postBudget?.warned) budgetUsage = postBudget.block;
    }

    let output = `[RESULT] Response from ${agent.friendlyName}:

${parsed.result}`;
    if (parsed.sessionId) output += `

---
session: ${parsed.sessionId}`;
    // Auto-harvest learnings from session output (fire-and-forget)
    if (parsed.result) {
      // apra-fleet-tm7.2: always pass resolvedWorkFolder, local or remote.
      // getKbProviders(undefined) falls back to slugFor(process.cwd()) --
      // the FLEET SERVER's own cwd, not any generic 'default' -- so omitting
      // repo_path for remote members would silently route their harvested
      // learnings into the server's own repo KB (the exact defect apra-fleet-tm7
      // describes).
      //
      // apra-fleet-b4g.6: repo_remote_url (apra-fleet-b4g.1) is how a REMOTE
      // member's call reaches the SAME shared project KB a local clone would --
      // without it, resolvedWorkFolder is a path on the remote host that will
      // almost never exist on this (fleet server) machine, resolveProjectSlug's
      // git calls on it fail with ENOENT, and it falls through to the literal
      // 'default' slug, pooling every such member's harvest into one shared,
      // useless bucket (no cross-repo contamination, but no real routing
      // either). knownRepoRemoteUrl() forwards it whenever the member's own
      // registration record already carries a genuine URL. It deliberately does
      // NOT construct one from agent.gitRepos' bare "owner/repo" access-list
      // entries (see src/services/vcs/github.ts's own
      // https://github.com/${repo}.git construction for a DIFFERENT, narrower
      // purpose -- connectivity testing) or shell out to the member host to
      // discover it: guessing a URL that turns out wrong would route the
      // harvest into a KB slug that does not match the repo's real local-clone
      // slug, which is worse than today's honest 'default' degradation. When no
      // genuine URL is known, behaviour is unchanged from before this fix.
      // KB-TRUST PHASE 1 (apra-fleet-4wz.8): report the harvest counters. This is
      // the highest-volume KB writer and its result was previously discarded
      // entirely, so entries_rejected -- the fail-closed signal -- was invisible
      // on the one path that produces most of it. Rejections are EXPECTED to
      // dominate here: harvest's regex extraction frequently yields no file
      // paths at all, and an entry with no basis is refused by design. A high
      // rejected count is the invariant working, not a regression to tune away.
      void import('./kb-harvest.js')
        .then(({ kbHarvest }) =>
          kbHarvest({
            repo_path: resolvedWorkFolder,
            repo_remote_url: knownRepoRemoteUrl(agent),
            session_transcript: parsed.result,
            session_id: parsed.sessionId,
          })
        )
        .then((raw: string) => {
          try {
            const r = JSON.parse(raw) as { entries_captured: number; entries_updated: number; entries_skipped: number; entries_rejected: number };
            if (r.entries_captured || r.entries_updated || r.entries_skipped || r.entries_rejected) {
              logLine('kb_harvest', `auto-harvest: captured=${r.entries_captured} updated=${r.entries_updated} skipped=${r.entries_skipped} rejected=${r.entries_rejected}`);
            }
          } catch {
            // A non-JSON payload is not worth failing a fire-and-forget harvest over.
          }
        })
        .catch((err: Error) => logWarn('kb_harvest', `auto-harvest failed: ${err.message}`));
    }

    if (heuristicWarningSuffix) output += heuristicWarningSuffix;
    return {
      text: output,
      structuredContent: {
        response: parsed.result,
        ...(_epUsage ? { usage: { input_tokens: _epUsage.input_tokens, output_tokens: _epUsage.output_tokens, total_tokens: _epUsage.input_tokens + _epUsage.output_tokens } } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        ...(contextWarning ? { contextWarning } : {}),
        ...(budgetUsage ? { budgetUsage } : {}),
      },
    };
  } catch (err: any) {
    // apra-fleet-3c9.1: a confirmed stall aborted the in-flight execCommand (and
    // NOT the MCP client). Surface it as a typed 'stalled' error so the dispatch
    // settles here -- well under the client hard timeout -- instead of being
    // mislabeled dispatch_failed or waiting out the full deadline.
    if (stallAbortController.signal.aborted && !extra?.signal?.aborted) {
      _epError = 'dispatch aborted by confirmed stall';
      return {
        text: `[FAIL] execute_prompt on "${agent.friendlyName}" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.`,
        structuredContent: { isError: true, reason: 'stalled' },
      };
    }
    // Only mark offline for genuine SSH/network connection failures, not for cancellations
    _epOffline = !!(err.message && /ssh|network|econnrefused|ehostunreach|connection timed out/i.test(err.message));
    _epError = err.message;
    return {
      text: `[FAIL] Failed to execute prompt on "${agent.friendlyName}": ${err.message}`,
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
    await deletePromptFile(agent, strategy, promptFilePath, durablePath ? [durablePath] : []);
  }
}
