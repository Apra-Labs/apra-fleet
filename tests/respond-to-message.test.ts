import { describe, it, expect, afterEach } from 'vitest';
import { respondToMessage } from '../src/tools/respond-to-message.js';
import { registerPending, __clearAllPending } from '../src/services/pending-responses.js';

afterEach(() => {
  __clearAllPending();
});

describe('respondToMessage (apra-fleet-2xs.8)', () => {
  it('delivers content to a pending execute_prompt call and returns ok', async () => {
    const pending = registerPending('msg-1', 5000);

    const result = await respondToMessage({ reply_to: 'msg-1', content: 'here is my answer' });
    expect(JSON.parse(result)).toEqual({ ok: true });
    await expect(pending).resolves.toBe('here is my answer');
  });

  it('returns a clear "no pending call" error for an unrecognized reply_to', async () => {
    const result = await respondToMessage({ reply_to: 'no-such-id', content: 'anything' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('no pending execute_prompt call');
  });

  it('returns the same "no pending call" error for a reply_to that was already answered', async () => {
    registerPending('msg-2', 5000);
    await respondToMessage({ reply_to: 'msg-2', content: 'first answer' });

    const second = await respondToMessage({ reply_to: 'msg-2', content: 'duplicate answer' });
    expect(JSON.parse(second).error).toBeDefined();
  });
});
