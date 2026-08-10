import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCredentialResolve, MockSendGridProvider, MockSmtpProvider } = vi.hoisted(() => ({
  mockCredentialResolve: vi.fn(),
  MockSendGridProvider: vi.fn(),
  MockSmtpProvider: vi.fn(),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: mockCredentialResolve,
}));

vi.mock('../src/providers/email/sendgrid.js', () => ({
  SendGridProvider: MockSendGridProvider,
}));

vi.mock('../src/providers/email/smtp.js', () => ({
  SmtpProvider: MockSmtpProvider,
}));

import { sendEmail } from '../src/tools/send-email.js';

beforeEach(() => {
  mockCredentialResolve.mockReset();
  mockCredentialResolve.mockReturnValue(null);
  MockSendGridProvider.mockReset();
  MockSmtpProvider.mockReset();
});

describe('sendEmail provider resolution', () => {
  it('builds SendGridProvider when credential store has the API key', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'sendgrid_api_key') return { plaintext: 'sg-key-123', meta: {} };
      return null;
    });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    MockSendGridProvider.mockImplementation(function (this: any) { this.name = 'sendgrid'; this.send = mockSend; });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('msg-1');
    expect(MockSendGridProvider).toHaveBeenCalledWith({ apiKey: 'sg-key-123', from: 'noreply@example.com' });
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', '*');
  });

  it('returns error with credential_store_set message when SendGrid API key is missing', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credential_store_set/);
    expect(result.error).toMatch(/sendgrid_api_key/);
  });

  it('builds SmtpProvider when credential store has the password', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'secret-pass', meta: {} };
      return null;
    });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'smtp-1' });
    MockSmtpProvider.mockImplementation(function (this: any) { this.name = 'smtp'; this.send = mockSend; });

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      port: 587,
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('smtp-1');
    expect(MockSmtpProvider).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'me@example.com', pass: 'secret-pass' },
      from: 'noreply@example.com',
    });
  });

  it('returns error with credential_store_set message when SMTP password is missing', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credential_store_set/);
    expect(result.error).toMatch(/smtp_password/);
  });

  it('returns error when SMTP is selected but host is missing', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'pass', meta: {} };
      return null;
    });

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      user: 'me@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/host/);
  });

  it('returns error when SMTP is selected but user is missing', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: 'pass', meta: {} };
      return null;
    });

    const result = JSON.parse(await sendEmail({
      provider: 'smtp',
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/user/);
  });
});

describe('sendEmail address validation', () => {
  it('rejects an invalid to address before reaching the provider', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'not-an-email',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid.*to.*address/);
  });

  it('rejects an invalid cc address', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'valid@example.com',
      cc: ['bad-email'],
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid.*cc.*address/);
  });
});
