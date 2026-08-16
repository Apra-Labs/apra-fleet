import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCredentialResolve, MockSendGridProvider, MockSmtpProvider, mockFindBySessionId, mockGetAgentOrFail } = vi.hoisted(() => ({
  mockCredentialResolve: vi.fn(),
  MockSendGridProvider: vi.fn(),
  MockSmtpProvider: vi.fn(),
  mockFindBySessionId: vi.fn(),
  mockGetAgentOrFail: vi.fn(),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: mockCredentialResolve,
}));

vi.mock('../src/services/session-registry.js', () => ({
  sessionRegistry: { findBySessionId: mockFindBySessionId },
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOrFail: mockGetAgentOrFail,
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
  mockFindBySessionId.mockReset();
  mockGetAgentOrFail.mockReset();
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
    // Cheap field checks run before the credential-store round trip.
    expect(mockCredentialResolve).not.toHaveBeenCalled();
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
    expect(mockCredentialResolve).not.toHaveBeenCalled();
  });
});

describe('sendEmail credential scoping', () => {
  it('resolves with the member friendly name when called from a member session', async () => {
    mockFindBySessionId.mockReturnValue({ member_id: 'uuid-1' });
    mockGetAgentOrFail.mockReturnValue({ friendlyName: 'worker-1' });
    mockCredentialResolve.mockReturnValue({ plaintext: 'sg-key', meta: {} });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'msg-2' });
    MockSendGridProvider.mockImplementation(function (this: any) { this.name = 'sendgrid'; this.send = mockSend; });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }, { sessionId: 'sess-1' }));

    expect(result.ok).toBe(true);
    expect(mockFindBySessionId).toHaveBeenCalledWith('sess-1');
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', 'worker-1');
  });

  it('surfaces a scoping denial instead of a misleading not-found error', async () => {
    mockFindBySessionId.mockReturnValue({ member_id: 'uuid-1' });
    mockGetAgentOrFail.mockReturnValue({ friendlyName: 'worker-1' });
    mockCredentialResolve.mockReturnValue({ denied: "Credential 'sendgrid_api_key' is not accessible to member 'worker-1'. Allowed: ops-bot" });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }, { sessionId: 'sess-1' }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not accessible to member 'worker-1'/);
    expect(result.error).not.toMatch(/credential_store_set/);
  });

  it('fails closed for an unresolvable session id: scoped credentials deny instead of operator bypass', async () => {
    mockFindBySessionId.mockReturnValue(undefined); // session not in registry
    mockCredentialResolve.mockReturnValue({ denied: "Credential 'sendgrid_api_key' is not accessible to member 'session:sess-x'. Allowed: ops-bot" });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }, { sessionId: 'sess-x' }));

    expect(result.ok).toBe(false);
    // The synthetic non-member identity is passed through -- NOT the '*' bypass.
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', 'session:sess-x');
    expect(result.error).toMatch(/not accessible/);
  });

  it('uses a synthetic session identity when the session exists but the agent is gone', async () => {
    mockFindBySessionId.mockReturnValue({ member_id: 'uuid-gone' });
    mockGetAgentOrFail.mockReturnValue('Member "uuid-gone" not found.');
    mockCredentialResolve.mockReturnValue({
      denied: "Credential 'sendgrid_api_key' is not accessible to member 'session:sess-stale'. Allowed: ops-bot",
    });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }, { sessionId: 'sess-stale' }));

    expect(result.ok).toBe(false);
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', 'session:sess-stale');
    expect(mockCredentialResolve).not.toHaveBeenCalledWith('sendgrid_api_key', 'uuid-gone');
    expect(result.error).toMatch(/not accessible/);
  });

  it('falls back to operator scope when there is no session id (stdio orchestrator)', async () => {
    mockCredentialResolve.mockReturnValue({ plaintext: 'sg-key', meta: {} });
    const mockSend = vi.fn().mockResolvedValue({ messageId: 'msg-3' });
    MockSendGridProvider.mockImplementation(function (this: any) { this.name = 'sendgrid'; this.send = mockSend; });

    await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    });

    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', '*');
    expect(mockFindBySessionId).not.toHaveBeenCalled();
  });
});

describe('sendEmail address validation', () => {
  it('reports an empty stored SMTP password as empty, not not-found', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'smtp_password') return { plaintext: '', meta: {} };
      return null;
    });

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
    expect(result.error).toMatch(/empty/);
    expect(result.error).not.toMatch(/not found/);
  });

  it('reports an empty stored SendGrid API key as empty, not not-found', async () => {
    mockCredentialResolve.mockImplementation((name: string) => {
      if (name === 'sendgrid_api_key') return { plaintext: '', meta: {} };
      return null;
    });

    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/);
    expect(result.error).not.toMatch(/not found/);
  });

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

  it('rejects an invalid from address', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'not-an-email',
      to: 'valid@example.com',
      subject: 'Test',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid.*from.*address/);
    expect(mockCredentialResolve).not.toHaveBeenCalled();
  });

  it('rejects a subject containing CR/LF (header injection)', async () => {
    const result = JSON.parse(await sendEmail({
      provider: 'sendgrid',
      from: 'noreply@example.com',
      to: 'valid@example.com',
      subject: 'Hi\r\nBcc: evil@example.com',
      body: 'Hello',
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subject.*CR\/LF/);
    expect(mockCredentialResolve).not.toHaveBeenCalled();
  });
});
