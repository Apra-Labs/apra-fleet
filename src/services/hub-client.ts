/**
 * Spoke-side hub-client (apra-fleet-us9.6/3jg): the apra-fleet.exe half of
 * docs/hub-spoke-wire-protocol.md. Maintains one outbound SSE stream to
 * fleet.apralabs.com per machine, announces/heartbeats presence, and
 * dedupes at-least-once envelope redelivery by envelope_id. Deliberately
 * does NOT execute relayed commands itself (apra-fleet-cgg's job, once
 * this lands) -- `onEnvelope` is a caller-supplied hook.
 *
 * All I/O (fetch, timers, randomness, wall clock) is injected so the
 * reconnect/backoff/heartbeat state machine can be tested deterministically
 * without real timers or a real network -- same pattern as src/cli/join.ts's
 * JoinDeps.
 */
import crypto from 'node:crypto';

export interface MemberSnapshotEntry {
  memberId: string;
  status: string;
}

export interface InboundRelayEnvelope {
  envelope_id: string;
  kind: string;
  payload: unknown;
  correlation_id?: string | null;
  to?: { machine_id: string | null; member_id: string | null };
}

export interface HubClientDeps {
  fetch: typeof fetch;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  hubUrl: string;
  machineId: string;
  workspaceId: string;
  jwt: string;
  getMemberSnapshot(): MemberSnapshotEntry[];
  onEnvelope(envelope: InboundRelayEnvelope): void | Promise<void>;
  onLog?(message: string): void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60000;
const DEFAULT_HEARTBEAT_DUE_MS = 20000;
const SEEN_ENVELOPE_TTL_MS = 5 * 60 * 1000;

/** Exponential backoff with full jitter, base 1s / cap 60s
 *  (docs/hub-spoke-wire-protocol.md section 2). `attempt` is 0-indexed
 *  consecutive failed reconnect attempts since the last successfully
 *  processed heartbeat ack. */
export function computeBackoffMs(attempt: number, random: () => number, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Short-lived seen-envelope_id cache (wire-protocol.md section 5): tier 2
 * must no-op a duplicate at-least-once redelivery rather than re-executing
 * an already-completed request.
 */
export class SeenEnvelopeCache {
  private seen = new Map<string, number>();

  constructor(private ttlMs: number, private now: () => number) {}

  hasSeen(envelopeId: string): boolean {
    this.evict();
    return this.seen.has(envelopeId);
  }

  markSeen(envelopeId: string): void {
    this.seen.set(envelopeId, this.now());
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }
}

/**
 * Incremental SSE `data:`-frame parser. Frames are separated by a blank
 * line per the SSE spec; a frame with no `data:` line (e.g. a bare
 * keep-alive comment) yields nothing. Malformed JSON in a data frame is
 * skipped, not thrown -- a single corrupt frame must not kill the stream.
 */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const frames: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      try {
        frames.push(JSON.parse(dataLines.join('')));
      } catch {
        // Skip a malformed frame rather than dropping the whole stream.
      }
    }
    return frames;
  }
}

export interface HubClientHandle {
  stop(): void;
}

export function createHubClient(deps: HubClientDeps): HubClientHandle {
  let stopped = false;
  let attempt = 0;
  let heartbeatTimer: unknown = null;
  let nextHeartbeatDueMs = DEFAULT_HEARTBEAT_DUE_MS;
  const seen = new SeenEnvelopeCache(SEEN_ENVELOPE_TTL_MS, deps.now);

  async function postEnvelope(envelope: Record<string, unknown>): Promise<Response> {
    return deps.fetch(`${deps.hubUrl}/ws/${deps.workspaceId}/envelopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.jwt}` },
      body: JSON.stringify(envelope),
    });
  }

  async function announcePresence(): Promise<boolean> {
    const members = deps.getMemberSnapshot();
    const res = await postEnvelope({
      envelope_id: crypto.randomUUID(),
      workspace_id: deps.workspaceId,
      kind: 'presence.announce',
      from: { machine_id: deps.machineId, member_id: null },
      to: { machine_id: null, member_id: null },
      ts: new Date(deps.now()).toISOString(),
      payload: { members: members.map((m) => ({ member_id: m.memberId, status: m.status })) },
    });
    return res.ok;
  }

  async function sendHeartbeat(): Promise<void> {
    const res = await postEnvelope({
      envelope_id: crypto.randomUUID(),
      workspace_id: deps.workspaceId,
      kind: 'presence.heartbeat',
      from: { machine_id: deps.machineId, member_id: null },
      to: { machine_id: null, member_id: null },
      ts: new Date(deps.now()).toISOString(),
    });
    if (!res.ok) {
      deps.onLog?.(`hub-client: heartbeat rejected (${res.status})`);
      return;
    }
    // Backoff resets ONLY on a successfully-processed heartbeat ack -- a
    // bare TCP connect does not count (wire-protocol.md section 2).
    attempt = 0;
    const body = await res.json().catch(() => null) as { payload?: { next_heartbeat_due_ms?: number } } | null;
    if (typeof body?.payload?.next_heartbeat_due_ms === 'number') {
      nextHeartbeatDueMs = body.payload.next_heartbeat_due_ms;
    }
  }

  function scheduleHeartbeat(): void {
    if (stopped) return;
    heartbeatTimer = deps.setTimeout(() => {
      sendHeartbeat().finally(scheduleHeartbeat);
    }, nextHeartbeatDueMs);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      deps.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function ackEnvelope(envelopeId: string, memberId: string): Promise<void> {
    await deps.fetch(`${deps.hubUrl}/ws/${deps.workspaceId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.jwt}` },
      body: JSON.stringify({ envelope_id: envelopeId, member_id: memberId }),
    });
  }

  async function consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new SseFrameParser();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) return;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const frame of frames) {
          const envelope = frame as InboundRelayEnvelope;
          if (!envelope?.envelope_id) continue;
          if (seen.hasSeen(envelope.envelope_id)) continue;
          seen.markSeen(envelope.envelope_id);
          await deps.onEnvelope(envelope);
          if (envelope.to?.member_id) await ackEnvelope(envelope.envelope_id, envelope.to.member_id);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function connectOnce(): Promise<void> {
    const announced = await announcePresence();
    if (!announced) throw new Error('presence.announce failed');
    scheduleHeartbeat();

    try {
      const res = await deps.fetch(`${deps.hubUrl}/ws/${deps.workspaceId}/stream?machine_id=${encodeURIComponent(deps.machineId)}`, {
        headers: { Authorization: `Bearer ${deps.jwt}` },
      });
      if (!res.ok || !res.body) throw new Error(`stream connect failed (${res.status})`);
      await consumeStream(res.body as ReadableStream<Uint8Array>);
    } finally {
      stopHeartbeat();
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        deps.onLog?.(`hub-client: connection error: ${(err as Error).message}`);
      }
      if (stopped) return;
      const waitMs = computeBackoffMs(attempt, deps.random);
      attempt++;
      await new Promise<void>((resolve) => deps.setTimeout(resolve, waitMs));
    }
  }

  void loop();

  return {
    stop(): void {
      stopped = true;
      stopHeartbeat();
    },
  };
}
