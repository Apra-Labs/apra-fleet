import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEmailProvider = vi.fn();

vi.mock('../src/providers/email/index.js', () => ({
  getEmailProvider: (...args: unknown[]) => getEmailProvider(...args),
}));

import { sendEmail } from '../src/tools/send-email.js';

beforeEach(() => {
  getEmailProvider.mockReset();
});

describe('sendEmail', () => {
  it('rejects a malformed "to" address without calling the provider', async () => {
    const result = await sendEmail({ to: 'not-an-email', subject: 'hi', body: 'hello' });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid 'to' address/);
    expect(getEmailProvider).not.toHaveBeenCalled();
  });

  it('rejects a malformed "cc" address', async () => {
    const result = await sendEmail({
      to: 'valid@example.com',
      subject: 'hi',
      body: 'hello',
      cc: ['bad-address'],
    });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid 'cc' address/);
  });

  it('rejects a malformed "bcc" address', async () => {
    const result = await sendEmail({
      to: 'valid@example.com',
      subject: 'hi',
      body: 'hello',
      bcc: ['also-bad'],
    });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid 'bcc' address/);
  });

  it('sends via the resolved provider and returns ok with a messageId on success', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'msg-123' });
    getEmailProvider.mockReturnValue({ name: 'sendgrid', send });

    const result = await sendEmail({
      to: 'valid@example.com',
      subject: 'Subject',
      body: 'Body text',
    });
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ ok: true, messageId: 'msg-123' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'valid@example.com', subject: 'Subject', body: 'Body text' }),
    );
  });

  it('accepts a list of "to" addresses when all are valid', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'msg-456' });
    getEmailProvider.mockReturnValue({ name: 'smtp', send });

    const result = await sendEmail({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Subject',
      body: 'Body',
    });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false with the error message when the provider throws', async () => {
    getEmailProvider.mockReturnValue({
      name: 'sendgrid',
      send: vi.fn().mockRejectedValue(new Error('network down')),
    });

    const result = await sendEmail({ to: 'valid@example.com', subject: 'hi', body: 'hello' });
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ ok: false, error: 'network down' });
  });

  it('returns ok:false when provider resolution itself throws (e.g. not configured)', async () => {
    getEmailProvider.mockImplementation(() => {
      throw new Error('SMTP transport is not configured.');
    });

    const result = await sendEmail({ to: 'valid@example.com', subject: 'hi', body: 'hello' });
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ ok: false, error: 'SMTP transport is not configured.' });
  });
});
