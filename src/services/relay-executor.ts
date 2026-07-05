/**
 * Relayed execute_command fulfillment (apra-fleet-us9.6/cgg): wires an
 * `execute_command.request` envelope received over the hub-client
 * (src/services/hub-client.ts) into the existing LocalStrategy execution
 * engine (src/services/strategy.ts), then posts the result back as an
 * `execute_command.result` envelope, matching
 * docs/hub-spoke-wire-protocol.md sections 3.1 and 5.
 *
 * Deliberately narrow: only handles `execute_command.request`. Other relay
 * kinds (send_message.deliver, execute_prompt.request, event.broadcast) are
 * separate features with their own acceptance criteria, not silently
 * absorbed here -- an unhandled kind is a documented no-op, not a crash.
 *
 * Does NOT invent a member_id -> local Agent mapping: `getAgentForMember`
 * is caller-supplied and may legitimately return null (a request for a
 * member this machine no longer hosts), which yields an honest
 * `member_not_found` result rather than fabricating one.
 */
import type { Agent, SSHExecResult } from '../types.js';
import { getStrategy as realGetStrategy } from './strategy.js';
import type { InboundRelayEnvelope } from './hub-client.js';

export interface RelayExecStrategy {
  execCommand(command: string, timeoutMs?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void): Promise<SSHExecResult>;
}

export interface OutboundRelayEnvelope {
  envelope_id: string;
  workspace_id: string;
  kind: string;
  from: { machine_id: string; member_id: string | null };
  to: { machine_id: string | null; member_id: string | null };
  ts: string;
  correlation_id: string | null;
  payload: unknown;
}

export interface ExecuteCommandRequestPayload {
  memberId: string;
  command: string;
  timeoutMs?: number;
  maxTotalMs?: number;
}

export interface RelayExecutorDeps {
  workspaceId: string;
  machineId: string;
  /** Resolves the hub member_id addressed by the request to the local
   *  Agent it should run against. Returns null if this machine no longer
   *  hosts that member -- never fabricated. */
  getAgentForMember(memberId: string): Agent | null;
  /** Posts an envelope back to the hub (POST /ws/:id/envelopes). */
  submitEnvelope(envelope: OutboundRelayEnvelope): Promise<void>;
  now(): number;
  generateEnvelopeId(): string;
  /** Defaults to the real LocalStrategy/RemoteStrategy factory
   *  (strategy.ts) -- overridable for tests that want to exercise the
   *  relay/dedup/envelope-shaping logic without spawning a real process. */
  getStrategy?(agent: Agent): RelayExecStrategy;
}

function baseEnvelope(deps: RelayExecutorDeps, kind: string, correlationId: string, memberId: string | null): OutboundRelayEnvelope {
  return {
    envelope_id: deps.generateEnvelopeId(),
    workspace_id: deps.workspaceId,
    kind,
    from: { machine_id: deps.machineId, member_id: memberId },
    to: { machine_id: null, member_id: null },
    ts: new Date(deps.now()).toISOString(),
    correlation_id: correlationId,
    payload: {},
  };
}

/**
 * Returns a hub-client `onEnvelope` handler that fulfills
 * `execute_command.request` envelopes via LocalStrategy. Other kinds are a
 * documented no-op.
 */
export function createRelayExecutor(deps: RelayExecutorDeps) {
  return async function onEnvelope(envelope: InboundRelayEnvelope): Promise<void> {
    if (envelope.kind !== 'execute_command.request') return;

    const payload = envelope.payload as Partial<ExecuteCommandRequestPayload> | undefined;
    if (!payload?.memberId || typeof payload.command !== 'string') {
      const result = baseEnvelope(deps, 'execute_command.result', envelope.envelope_id, null);
      result.payload = { status: 'invalid_request', error: 'memberId and command are required' };
      await deps.submitEnvelope(result);
      return;
    }

    const agent = deps.getAgentForMember(payload.memberId);
    if (!agent) {
      const result = baseEnvelope(deps, 'execute_command.result', envelope.envelope_id, payload.memberId);
      result.payload = { status: 'member_not_found' };
      await deps.submitEnvelope(result);
      return;
    }

    const strategy = (deps.getStrategy ?? realGetStrategy)(agent);
    const memberId = payload.memberId;
    try {
      let pidReported = false;
      const execResult = await strategy.execCommand(
        payload.command,
        payload.timeoutMs,
        payload.maxTotalMs,
        (pid) => {
          if (pidReported) return;
          pidReported = true;
          const update = baseEnvelope(deps, 'execute_command.long_running_update', envelope.envelope_id, memberId);
          update.payload = { status: 'started', pid };
          void deps.submitEnvelope(update);
        },
      );
      const result = baseEnvelope(deps, 'execute_command.result', envelope.envelope_id, memberId);
      result.payload = { status: 'ok', stdout: execResult.stdout, stderr: execResult.stderr, code: execResult.code };
      await deps.submitEnvelope(result);
    } catch (err) {
      const result = baseEnvelope(deps, 'execute_command.result', envelope.envelope_id, memberId);
      result.payload = { status: 'error', error: (err as Error).message };
      await deps.submitEnvelope(result);
    }
  };
}
