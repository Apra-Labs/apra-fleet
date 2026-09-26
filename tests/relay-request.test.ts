/**
 * Orchestrator-side relay request/response correlation (apra-fleet-us9.7):
 * proves submitAndAwaitResult() correctly correlates a submitted request to
 * its eventual result envelope (delivered asynchronously, exactly as it
 * would arrive over a real SSE stream), times out cleanly when no result
 * ever arrives, and rejects immediately (no dangling timer/unhandled
 * rejection) when submission itself fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { PendingRelayRequests, submitAndAwaitResult, composeEnvelopeHandler, type RelayRequestDeps } from '../src/services/relay-request.js';

describe('PendingRelayRequests', () => {
  it('resolves a registered request when a matching correlation_id arrives', async () => {
    const registry = new PendingRelayRequests();
    const promise = registry.register('env-1', 5000);

    const consumed = registry.resolveFromEnvelope({ correlation_id: 'env-1', payload: { status: 'ok' } });
    expect(consumed).toBe(true);
    await expect(promise).resolves.toEqual({ status: 'ok' });
  });

  it('returns false (does not consume) for an envelope whose correlation_id is not pending', () => {
    const registry = new PendingRelayRequests();
    registry.register('env-1', 5000);
    const consumed = registry.resolveFromEnvelope({ correlation_id: 'some-other-id', payload: {} });
    expect(consumed).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('returns false for an envelope with no correlation_id at all', () => {
    const registry = new PendingRelayRequests();
    const consumed = registry.resolveFromEnvelope({ payload: {} });
    expect(consumed).toBe(false);
  });

  it('rejects with a relay_timeout error if no result arrives before the timeout', async () => {
    const registry = new PendingRelayRequests();
    const promise = registry.register('env-1', 10);
    await expect(promise).rejects.toMatchObject({ code: 'relay_timeout' });
    expect(registry.size).toBe(0);
  });

  it('resolving twice for the same correlation_id only consumes it once', () => {
    const registry = new PendingRelayRequests();
    registry.register('env-1', 5000);
    expect(registry.resolveFromEnvelope({ correlation_id: 'env-1', payload: {} })).toBe(true);
    expect(registry.resolveFromEnvelope({ correlation_id: 'env-1', payload: {} })).toBe(false);
  });

  it('cancelAll rejects every pending request with the given reason', async () => {
    const registry = new PendingRelayRequests();
    const p1 = registry.register('env-1', 5000);
    const p2 = registry.register('env-2', 5000);
    registry.cancelAll('spoke disconnected');
    await expect(p1).rejects.toThrow(/spoke disconnected/);
    await expect(p2).rejects.toThrow(/spoke disconnected/);
    expect(registry.size).toBe(0);
  });
});

describe('submitAndAwaitResult', () => {
  function baseDeps(overrides: Partial<RelayRequestDeps> = {}): RelayRequestDeps {
    return {
      submitEnvelope: async () => ({ ok: true, status: 202 }),
      workspaceId: 'ws-1',
      originMemberId: 'origin-member',
      now: () => Date.now(),
      ...overrides,
    };
  }

  it('submits a correctly-shaped envelope and resolves once the correlated result arrives', async () => {
    const registry = new PendingRelayRequests();
    let submittedEnvelope: any;
    const deps = baseDeps({
      submitEnvelope: async (env) => { submittedEnvelope = env; return { ok: true, status: 202 }; },
    });

    const resultPromise = submitAndAwaitResult(deps, registry, 'execute_command.request', 'target-member', { cmd: 'ls' }, 30000, 5000);

    // Simulate the result arriving asynchronously over the hub-client's SSE stream.
    await vi.waitFor(() => expect(submittedEnvelope).toBeDefined());
    const consumed = registry.resolveFromEnvelope({ correlation_id: submittedEnvelope.envelope_id, payload: { status: 'ok', stdout: 'hi' } });
    expect(consumed).toBe(true);

    await expect(resultPromise).resolves.toEqual({ status: 'ok', stdout: 'hi' });
    expect(submittedEnvelope).toMatchObject({
      workspace_id: 'ws-1',
      kind: 'execute_command.request',
      from: { machine_id: null, member_id: 'origin-member' },
      to: { machine_id: null, member_id: 'target-member' },
      ttl_ms: 30000,
      payload: { cmd: 'ls' },
    });
  });

  it('rejects immediately when submission itself fails, without waiting for the timeout', async () => {
    const registry = new PendingRelayRequests();
    const deps = baseDeps({ submitEnvelope: async () => ({ ok: false, status: 500 }) });

    await expect(submitAndAwaitResult(deps, registry, 'execute_command.request', 'target-member', {}, 30000, 5000))
      .rejects.toThrow(/Failed to submit relay request/);
    expect(registry.size).toBe(0);
  });

  it('rejects with a timeout if the request is submitted successfully but no result ever arrives', async () => {
    const registry = new PendingRelayRequests();
    const deps = baseDeps();

    await expect(submitAndAwaitResult(deps, registry, 'execute_command.request', 'target-member', {}, 30000, 10))
      .rejects.toMatchObject({ code: 'relay_timeout' });
  });
});

describe('composeEnvelopeHandler', () => {
  it('consumes a correlated result itself and does not invoke the fallback', async () => {
    const registry = new PendingRelayRequests();
    const promise = registry.register('env-1', 5000);
    const fallback = vi.fn();
    const dispatch = composeEnvelopeHandler(registry, fallback);

    await dispatch({ correlation_id: 'env-1', payload: { status: 'ok' } });

    await expect(promise).resolves.toEqual({ status: 'ok' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls through to the fallback (relay-executor) for an envelope with no matching pending request', async () => {
    const registry = new PendingRelayRequests();
    const fallback = vi.fn();
    const dispatch = composeEnvelopeHandler(registry, fallback);

    const envelope = { kind: 'execute_command.request', payload: { memberId: 'm', command: 'ls' } };
    await dispatch(envelope);

    expect(fallback).toHaveBeenCalledWith(envelope);
  });
});
