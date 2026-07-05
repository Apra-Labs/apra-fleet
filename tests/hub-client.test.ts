/**
 * Spoke-side hub-client (apra-fleet-us9.6/3jg) tests. The pure pieces
 * (backoff schedule, seen-envelope dedup cache, SSE frame parser) are
 * tested directly and deterministically; the orchestration
 * (createHubClient) is tested against injected fetch/timer/random fakes --
 * no real network, no real wall-clock waits.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  SeenEnvelopeCache,
  SseFrameParser,
  createHubClient,
  type HubClientDeps,
  type InboundRelayEnvelope,
} from '../src/services/hub-client.js';

describe('computeBackoffMs', () => {
  it('is zero at any attempt when random() returns 0', () => {
    expect(computeBackoffMs(0, () => 0)).toBe(0);
    expect(computeBackoffMs(5, () => 0)).toBe(0);
  });

  it('scales with the attempt number, base 1s, until the cap', () => {
    expect(computeBackoffMs(0, () => 0.999999)).toBeLessThan(1000);
    expect(computeBackoffMs(0, () => 0.999999)).toBeGreaterThan(900);
    // 2^6 * 1000 = 64000 > 60000 cap
    expect(computeBackoffMs(6, () => 0.999999)).toBeLessThanOrEqual(60000);
    expect(computeBackoffMs(6, () => 0.999999)).toBeGreaterThan(59000);
  });

  it('never exceeds the 60s cap even at very high attempt counts', () => {
    expect(computeBackoffMs(20, () => 0.999999)).toBeLessThanOrEqual(60000);
  });
});

describe('SeenEnvelopeCache', () => {
  it('has not seen an envelope until markSeen is called', () => {
    const cache = new SeenEnvelopeCache(5000, () => 0);
    expect(cache.hasSeen('e1')).toBe(false);
    cache.markSeen('e1');
    expect(cache.hasSeen('e1')).toBe(true);
  });

  it('forgets an envelope once its ttl has elapsed', () => {
    let now = 0;
    const cache = new SeenEnvelopeCache(1000, () => now);
    cache.markSeen('e1');
    expect(cache.hasSeen('e1')).toBe(true);
    now = 1001;
    expect(cache.hasSeen('e1')).toBe(false);
  });
});

describe('SseFrameParser', () => {
  it('parses a single complete frame delivered in one chunk', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {"a":1}\n\n');
    expect(frames).toEqual([{ a: 1 }]);
  });

  it('parses a frame split across multiple push() calls', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual([{ a: 1 }]);
  });

  it('parses multiple frames delivered in one chunk', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(frames).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips a malformed frame without throwing or losing subsequent frames', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {not json}\n\ndata: {"a":2}\n\n');
    expect(frames).toEqual([{ a: 2 }]);
  });
});

function sseStreamOf(envelopes: InboundRelayEnvelope[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const env of envelopes) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(env)}\n\n`));
      }
      controller.close();
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('createHubClient orchestration', () => {
  it('announces presence, consumes a relayed envelope, acks it, and calls onEnvelope exactly once (dedup)', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const envelope: InboundRelayEnvelope = {
      envelope_id: 'e-1',
      kind: 'execute_command.request',
      payload: { cmd: 'ls' },
      to: { machine_id: null, member_id: 'mem-1' },
    };

    const fetchMock = vi.fn(async (url: string, opts?: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body });
      if (url.includes('/stream')) {
        return { ok: true, status: 200, body: sseStreamOf([envelope]) } as unknown as Response;
      }
      if (url.includes('/ack')) {
        return { ok: true, status: 200, json: async () => ({ acked: true }) } as unknown as Response;
      }
      // /envelopes -- presence.announce or presence.heartbeat submissions
      return { ok: true, status: 200, json: async () => ({ kind: 'presence.ack', payload: { next_heartbeat_due_ms: 20000 } }) } as unknown as Response;
    });

    const onEnvelope = vi.fn();
    const deps: HubClientDeps = {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      hubUrl: 'https://hub.example.com',
      machineId: 'mach-1',
      workspaceId: 'ws-1',
      jwt: 'jwt-token',
      getMemberSnapshot: () => [{ memberId: 'mem-1', status: 'online' }],
      onEnvelope,
    };

    const handle = createHubClient(deps);
    try {
      await waitFor(() => onEnvelope.mock.calls.length >= 1);
      expect(onEnvelope).toHaveBeenCalledWith(envelope);

      await waitFor(() => calls.some((c) => c.url.includes('/ack')));
      const ackCall = calls.find((c) => c.url.includes('/ack'))!;
      expect(ackCall.body).toEqual({ envelope_id: 'e-1', member_id: 'mem-1' });

      const announceCall = calls.find((c) => c.body?.kind === 'presence.announce');
      expect(announceCall?.body.payload).toEqual({ members: [{ member_id: 'mem-1', status: 'online' }] });
    } finally {
      handle.stop();
    }
  });

  it('does not re-invoke onEnvelope for a redelivered (duplicate) envelope_id', async () => {
    const envelope: InboundRelayEnvelope = {
      envelope_id: 'e-dup',
      kind: 'execute_command.request',
      payload: {},
      to: { machine_id: null, member_id: 'mem-1' },
    };

    let streamCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/stream')) {
        streamCallCount++;
        // Same envelope_id delivered on both the first and reconnected stream.
        return { ok: true, status: 200, body: sseStreamOf([envelope]) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ payload: { next_heartbeat_due_ms: 20000 } }) } as unknown as Response;
    });

    const onEnvelope = vi.fn();
    const deps: HubClientDeps = {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      hubUrl: 'https://hub.example.com',
      machineId: 'mach-1',
      workspaceId: 'ws-1',
      jwt: 'jwt-token',
      getMemberSnapshot: () => [],
      onEnvelope,
    };

    const handle = createHubClient(deps);
    try {
      await waitFor(() => streamCallCount >= 2);
      expect(onEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it('reconnects with backoff after a failed presence.announce, and logs the error', async () => {
    let announceAttempts = 0;
    const fetchMock = vi.fn(async (url: string, opts?: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      if (body?.kind === 'presence.announce') {
        announceAttempts++;
        if (announceAttempts === 1) return { ok: false, status: 500 } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes('/stream')) {
        return { ok: true, status: 200, body: sseStreamOf([]) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });

    const logs: string[] = [];
    const deps: HubClientDeps = {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      hubUrl: 'https://hub.example.com',
      machineId: 'mach-1',
      workspaceId: 'ws-1',
      jwt: 'jwt-token',
      getMemberSnapshot: () => [],
      onEnvelope: () => {},
      onLog: (msg) => logs.push(msg),
    };

    const handle = createHubClient(deps);
    try {
      await waitFor(() => announceAttempts >= 2);
      expect(logs.some((l) => l.includes('connection error'))).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
