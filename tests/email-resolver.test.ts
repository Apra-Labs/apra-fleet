/**
 * Unit tests for the email provider resolver (src/providers/email/index.ts):
 * config loading from env/credential-store, and resolver picking the correct
 * adapter. Both concrete adapters (SendGridProvider/SmtpProvider) are mocked
 * so this file exercises resolver logic only, not network I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { loadEmailConfig, getEmailProvider } from '../src/providers/email/index.js';

const ENV_KEYS = [
  'EMAIL_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'EMAIL_FROM',
  'SENDGRID_API_KEY',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockCredentialResolve.mockReset();
  mockCredentialResolve.mockReturnValue(null);
  MockSendGridProvider.mockReset();
  MockSmtpProvider.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('loadEmailConfig', () => {
  it('defaults to sendgrid provider when EMAIL_PROVIDER is unset', () => {
    process.env.SENDGRID_API_KEY = 'key-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    const config = loadEmailConfig();

    expect(config.provider).toBe('sendgrid');
    expect(config.sendgrid).toEqual({ apiKey: 'key-123', from: 'noreply@example.com' });
  });

  it('throws a clear error when sendgrid is selected but not configured', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';

    expect(() => loadEmailConfig()).toThrow(/SendGrid transport is not configured/);
  });

  it('prefers a credential-store secret over the SENDGRID_API_KEY env var', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'env-key';
    process.env.EMAIL_FROM = 'noreply@example.com';
    mockCredentialResolve.mockReturnValue({ plaintext: 'store-key', meta: {} });

    const config = loadEmailConfig();

    expect(config.sendgrid?.apiKey).toBe('store-key');
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', '*');
  });

  it('builds smtp config from env vars, falling back to a default port', () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'pass-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    const config = loadEmailConfig();

    expect(config.provider).toBe('smtp');
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'pass-123' },
      from: 'noreply@example.com',
    });
  });

  it('throws a clear error when smtp is selected but missing required fields', () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';

    expect(() => loadEmailConfig()).toThrow(/SMTP transport is not configured/);
  });

  it('throws for an unknown provider value', () => {
    process.env.EMAIL_PROVIDER = 'carrier-pigeon';

    expect(() => loadEmailConfig()).toThrow(/Unknown EMAIL_PROVIDER/);
  });
});

describe('getEmailProvider', () => {
  it('picks the SendGridProvider adapter for provider="sendgrid"', () => {
    const config = { provider: 'sendgrid' as const, from: 'a@example.com', sendgrid: { apiKey: 'k', from: 'a@example.com' } };

    getEmailProvider(config);

    expect(MockSendGridProvider).toHaveBeenCalledWith(config.sendgrid);
    expect(MockSmtpProvider).not.toHaveBeenCalled();
  });

  it('picks the SmtpProvider adapter for provider="smtp"', () => {
    const config = {
      provider: 'smtp' as const,
      from: 'a@example.com',
      smtp: { host: 'h', port: 587, auth: { user: 'u', pass: 'p' }, from: 'a@example.com' },
    };

    getEmailProvider(config);

    expect(MockSmtpProvider).toHaveBeenCalledWith(config.smtp);
    expect(MockSendGridProvider).not.toHaveBeenCalled();
  });

  it('throws when sendgrid provider is selected but its config is missing', () => {
    const config = { provider: 'sendgrid' as const, from: 'a@example.com' };

    expect(() => getEmailProvider(config)).toThrow(/SendGrid transport selected but not configured/);
  });

  it('throws when smtp provider is selected but its config is missing', () => {
    const config = { provider: 'smtp' as const, from: 'a@example.com' };

    expect(() => getEmailProvider(config)).toThrow(/SMTP transport selected but not configured/);
  });

  it('throws for an unrecognized provider in a resolved config', () => {
    const config = { provider: 'carrier-pigeon' as unknown as 'sendgrid', from: 'a@example.com' };

    expect(() => getEmailProvider(config)).toThrow(/Unknown transport/);
  });

  it('loads config via loadEmailConfig when no config argument is passed', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'key-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    getEmailProvider();

    expect(MockSendGridProvider).toHaveBeenCalledWith({ apiKey: 'key-123', from: 'noreply@example.com' });
  });
});
