import { describe, it, expect, afterEach } from 'vitest';
import { registerPending, resolvePending, __clearAllPending } from '../src/services/pending-responses.js';

afterEach(() => {
  __clearAllPending();
});

describe('pending-responses (apra-fleet-2xs.8)', () => {
  it('resolves the pending promise when a matching reply arrives', async () => {
    const pending = registerPending('msg-1', 5000);
    const delivered = resolvePending('msg-1', 'the response');
    expect(delivered).toBe(true);
    await expect(pending).resolves.toBe('the response');
  });

  it('resolvePending returns false for an id with no pending wait', () => {
    expect(resolvePending('no-such-id', 'whatever')).toBe(false);
  });

  it('resolvePending is one-shot -- a second call for the same id (already resolved) returns false', () => {
    registerPending('msg-2', 5000);
    expect(resolvePending('msg-2', 'first')).toBe(true);
    expect(resolvePending('msg-2', 'second (late/duplicate)')).toBe(false);
  });

  it('rejects with a timeout error if no reply arrives within timeoutMs', async () => {
    const pending = registerPending('msg-timeout', 50);
    await expect(pending).rejects.toThrow(/Timed out waiting for response/);
  });

  it('a reply after the timeout has already fired does not resolve (already deleted from pending)', async () => {
    const pending = registerPending('msg-late', 30);
    await expect(pending).rejects.toThrow();
    expect(resolvePending('msg-late', 'too late')).toBe(false);
  });

  it('two different msgids are tracked independently', async () => {
    const p1 = registerPending('msg-a', 5000);
    const p2 = registerPending('msg-b', 5000);

    resolvePending('msg-b', 'b response');
    await expect(p2).resolves.toBe('b response');

    resolvePending('msg-a', 'a response');
    await expect(p1).resolves.toBe('a response');
  });
});
