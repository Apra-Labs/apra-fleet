/**
 * Unit tests for the email transport resolver (src/services/email/index.ts):
 * config loading from env/credential-store, and resolver picking the correct
 * adapter. Both concrete adapters (SendgridTransport/SmtpTransport) are mocked
 * so this file exercises resolver logic only, not network I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCredentialResolve, MockSendgridTransport, MockSmtpTransport } = vi.hoisted(() => ({
  mockCredentialResolve: vi.fn(),
  MockSendgridTransport: vi.fn(),
  MockSmtpTransport: vi.fn(),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: mockCredentialResolve,
}));

vi.mock('../src/services/email/sendgrid.js', () => ({
  SendgridTransport: MockSendgridTransport,
}));

vi.mock('../src/services/email/smtp.js', () => ({
  SmtpTransport: MockSmtpTransport,
}));

import { loadEmailConfig, resolveEmailTransport } from '../src/services/email/index.js';

const ENV_KEYS = [
  'EMAIL_TRANSPORT',
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
  MockSendgridTransport.mockReset();
  MockSmtpTransport.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('loadEmailConfig', () => {
  it('defaults to sendgrid transport when EMAIL_TRANSPORT is unset', () => {
    process.env.SENDGRID_API_KEY = 'key-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    const config = loadEmailConfig();

    expect(config.transport).toBe('sendgrid');
    expect(config.sendgrid).toEqual({ apiKey: 'key-123', from: 'noreply@example.com' });
  });

  it('throws a clear error when sendgrid is selected but not configured', () => {
    process.env.EMAIL_TRANSPORT = 'sendgrid';

    expect(() => loadEmailConfig()).toThrow(/SendGrid transport is not configured/);
  });

  it('prefers a credential-store secret over the SENDGRID_API_KEY env var', () => {
    process.env.EMAIL_TRANSPORT = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'env-key';
    process.env.EMAIL_FROM = 'noreply@example.com';
    mockCredentialResolve.mockReturnValue({ plaintext: 'store-key', meta: {} });

    const config = loadEmailConfig();

    expect(config.sendgrid?.apiKey).toBe('store-key');
    expect(mockCredentialResolve).toHaveBeenCalledWith('sendgrid_api_key', '*');
  });

  it('builds smtp config from env vars, falling back to a default port', () => {
    process.env.EMAIL_TRANSPORT = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'pass-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    const config = loadEmailConfig();

    expect(config.transport).toBe('smtp');
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'pass-123' },
      from: 'noreply@example.com',
    });
  });

  it('throws a clear error when smtp is selected but missing required fields', () => {
    process.env.EMAIL_TRANSPORT = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';

    expect(() => loadEmailConfig()).toThrow(/SMTP transport is not configured/);
  });

  it('throws for an unknown transport value', () => {
    process.env.EMAIL_TRANSPORT = 'carrier-pigeon';

    expect(() => loadEmailConfig()).toThrow(/Unknown EMAIL_TRANSPORT/);
  });
});

describe('resolveEmailTransport', () => {
  it('picks the SendgridTransport adapter for transport="sendgrid"', () => {
    const config = { transport: 'sendgrid' as const, from: 'a@example.com', sendgrid: { apiKey: 'k', from: 'a@example.com' } };

    resolveEmailTransport(config);

    expect(MockSendgridTransport).toHaveBeenCalledWith(config.sendgrid);
    expect(MockSmtpTransport).not.toHaveBeenCalled();
  });

  it('picks the SmtpTransport adapter for transport="smtp"', () => {
    const config = {
      transport: 'smtp' as const,
      from: 'a@example.com',
      smtp: { host: 'h', port: 587, auth: { user: 'u', pass: 'p' }, from: 'a@example.com' },
    };

    resolveEmailTransport(config);

    expect(MockSmtpTransport).toHaveBeenCalledWith(config.smtp);
    expect(MockSendgridTransport).not.toHaveBeenCalled();
  });

  it('throws when sendgrid transport is selected but its config is missing', () => {
    const config = { transport: 'sendgrid' as const, from: 'a@example.com' };

    expect(() => resolveEmailTransport(config)).toThrow(/SendGrid transport selected but not configured/);
  });

  it('throws when smtp transport is selected but its config is missing', () => {
    const config = { transport: 'smtp' as const, from: 'a@example.com' };

    expect(() => resolveEmailTransport(config)).toThrow(/SMTP transport selected but not configured/);
  });

  it('throws for an unrecognized transport in a resolved config', () => {
    const config = { transport: 'carrier-pigeon' as unknown as 'sendgrid', from: 'a@example.com' };

    expect(() => resolveEmailTransport(config)).toThrow(/Unknown transport/);
  });

  it('loads config via loadEmailConfig when no config argument is passed', () => {
    process.env.EMAIL_TRANSPORT = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'key-123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    resolveEmailTransport();

    expect(MockSendgridTransport).toHaveBeenCalledWith({ apiKey: 'key-123', from: 'noreply@example.com' });
  });
});
