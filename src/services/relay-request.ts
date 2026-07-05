/**
 * Orchestrator-side relay request/response correlation (apra-fleet-us9.7):
 * the missing half of relay-executor.ts. That module lets a spoke FULFILL
 * an execute_command.request addressed to one of its own members; this
 * module lets a spoke ORIGINATE one addressed to a member hosted on a
 * DIFFERENT machine, then await the correlated result envelope that comes
 * back over the SAME spoke's SSE stream (docs/hub-spoke-wire-protocol.md
 * section 3's `correlation_id` field exists precisely for this).
 *
 * Deliberately narrow, matching this session's established pattern: this
 * is the transport-and-correlation primitive only. It does NOT decide how
 * an Agent gets classified as relay-addressed (that's a registry/CLI
 * design question -- Agent.agentType is currently 'local' | 'remote' with
 * no 'relay' value, and introducing one has a wide blast radius across
 * registry validation and CLI flows not touched this session) and does
 * NOT wire itself into strategy.ts's getStrategy() dispatch. See
 * apra-fleet-us9.7's follow-on notes for that remaining integration work.
 */
import crypto from 'node:crypto';

export interface RelayRequestDeps {
  /** Submits an envelope to the hub (POST /ws/:id/envelopes) -- same shape
   *  hub-client.ts uses internally. */
  submitEnvelope(envelope: Record<string, unknown>): Promise<{ ok: boolean; status: number }>;
  workspaceId: string;
  /** This machine's own member_id (the request's `from`/origin) -- results
   *  are addressed back here by the fulfilling spoke (relay-executor.ts). */
  originMemberId: string;
  now(): number;
}

export interface RelayTimeoutError extends Error {
  code: 'relay_timeout';
}

function makeTimeoutError(envelopeId: string): RelayTimeoutError {
  const err = new Error(`Relay request ${envelopeId} timed out waiting for a result`) as RelayTimeoutError;
  err.code = 'relay_timeout';
  return err;
}

interface PendingEntry {
  resolve(payload: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks in-flight relay requests keyed by the envelope_id of the ORIGINAL
 * request (which becomes every response envelope's `correlation_id`).
 * `resolveFromEnvelope` is what a hub-client's `onEnvelope` dispatcher
 * calls for every inbound envelope -- it's a no-op (returns false) for
 * anything that isn't a currently-pending correlation_id, so it composes
 * safely alongside relay-executor.ts's request-fulfillment handling in the
 * same dispatcher.
 */
export class PendingRelayRequests {
  private pending = new Map<string, PendingEntry>();

  register(envelopeId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelopeId);
        reject(makeTimeoutError(envelopeId));
      }, timeoutMs);
      this.pending.set(envelopeId, { resolve, reject, timer });
    });
  }

  /** Returns true if this envelope was consumed as a pending request's
   *  result (the caller should NOT also treat it as an unhandled envelope). */
  resolveFromEnvelope(envelope: { correlation_id?: string | null; payload?: unknown }): boolean {
    const correlationId = envelope.correlation_id;
    if (!correlationId) return false;
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    this.pending.delete(correlationId);
    clearTimeout(entry.timer);
    entry.resolve(envelope.payload);
    return true;
  }

  /** Rejects a specific pending request directly (e.g. submission itself
   *  failed, so there's no point waiting for a result that will never
   *  arrive). No-op if the id isn't (or is no longer) pending. */
  rejectPending(envelopeId: string, err: Error): void {
    const entry = this.pending.get(envelopeId);
    if (!entry) return;
    this.pending.delete(envelopeId);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  /** Cancels every pending request (e.g. on shutdown/reconnect-reset). */
  cancelAll(reason: string): void {
    for (const [envelopeId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Relay request ${envelopeId} cancelled: ${reason}`));
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Submits a request-kind envelope addressed to `targetMemberId` and
 * resolves with the correlated result payload once it arrives via
 * `registry.resolveFromEnvelope` (wired into the local hub-client's
 * dispatch), or rejects on timeout/submission failure. Mirrors
 * relay-executor.ts's envelope shaping so both sides of a relay round
 * trip use the same conventions.
 */
export async function submitAndAwaitResult(
  deps: RelayRequestDeps,
  registry: PendingRelayRequests,
  kind: string,
  targetMemberId: string,
  payload: unknown,
  ttlMs: number,
  timeoutMs: number,
): Promise<unknown> {
  const envelopeId = crypto.randomUUID();
  const envelope = {
    envelope_id: envelopeId,
    workspace_id: deps.workspaceId,
    kind,
    from: { machine_id: null, member_id: deps.originMemberId },
    to: { machine_id: null, member_id: targetMemberId },
    ts: new Date(deps.now()).toISOString(),
    ttl_ms: ttlMs,
    correlation_id: null,
    payload,
  };

  const resultPromise = registry.register(envelopeId, timeoutMs);
  const submitted = await deps.submitEnvelope(envelope);
  if (!submitted.ok) {
    const err = new Error(`Failed to submit relay request (status ${submitted.status})`);
    registry.rejectPending(envelopeId, err);
    resultPromise.catch(() => {}); // already rejected above; avoid an unhandled-rejection warning since we throw our own err below
    throw err;
  }
  return resultPromise;
}

/**
 * Composes this registry's result-consuming behavior with a fallback
 * handler (typically relay-executor.ts's createRelayExecutor() output) into
 * a single `onEnvelope` callback for hub-client.ts's HubClientDeps -- a
 * spoke is simultaneously a request FULFILLER (relay-executor) and a
 * request ORIGINATOR (this module), and both must see every inbound
 * envelope: a correlation_id match is consumed here first (it's a result
 * this spoke is waiting on), otherwise it falls through to the fulfiller.
 */
export function composeEnvelopeHandler<T extends { correlation_id?: string | null; payload?: unknown }>(
  registry: PendingRelayRequests,
  fallback: (envelope: T) => void | Promise<void>,
): (envelope: T) => void | Promise<void> {
  return async (envelope) => {
    if (registry.resolveFromEnvelope(envelope)) return;
    await fallback(envelope);
  };
}
