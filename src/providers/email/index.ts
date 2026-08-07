import { credentialResolve } from '../../services/credential-store.js';
import { SendGridProvider } from './sendgrid.js';
import { SmtpProvider } from './smtp.js';
import type { EmailConfig, EmailProvider } from './provider.js';

export type { EmailAttachment, EmailMessage, EmailSendResult, EmailProvider, EmailConfig } from './provider.js';

/**
 * Resolve a secret by name from the credential-store first, falling back to
 * an environment variable so operators can configure email in either place.
 */
function resolveSecret(credentialName: string, envVar: string): string | undefined {
  const resolved = credentialResolve(credentialName, '*');
  if (resolved && 'plaintext' in resolved) return resolved.plaintext;
  return process.env[envVar];
}

/**
 * Reads email configuration from environment variables (with credential-store
 * fallback for secrets) and returns it. Throws a clear error if the selected
 * provider is not fully configured.
 */
export function loadEmailConfig(): EmailConfig {
  const provider = (process.env.EMAIL_PROVIDER ?? process.env.EMAIL_TRANSPORT ?? 'sendgrid').toLowerCase();

  if (provider === 'smtp') {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
    const user = process.env.SMTP_USER;
    const pass = resolveSecret('smtp_password', 'SMTP_PASS');
    const from = process.env.EMAIL_FROM;

    if (!host || !user || !pass || !from) {
      throw new Error(
        'SMTP transport is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (or credential "smtp_password"), and EMAIL_FROM.'
      );
    }

    return {
      provider: 'smtp',
      from,
      smtp: { host, port, secure: process.env.SMTP_SECURE === 'true', auth: { user, pass }, from },
    };
  }

  if (provider === 'sendgrid') {
    const apiKey = resolveSecret('sendgrid_api_key', 'SENDGRID_API_KEY');
    const from = process.env.EMAIL_FROM;

    if (!apiKey || !from) {
      throw new Error(
        'SendGrid transport is not configured. Set SENDGRID_API_KEY (or credential "sendgrid_api_key") and EMAIL_FROM.'
      );
    }

    return { provider: 'sendgrid', from, sendgrid: { apiKey, from } };
  }

  throw new Error(`Unknown EMAIL_PROVIDER "${provider}". Expected "sendgrid" or "smtp".`);
}

/**
 * Provider resolver: reads config and returns the matching adapter.
 */
export function getEmailProvider(config?: EmailConfig): EmailProvider {
  const cfg = config ?? loadEmailConfig();

  if (cfg.provider === 'sendgrid') {
    if (!cfg.sendgrid) throw new Error('SendGrid transport selected but not configured.');
    return new SendGridProvider(cfg.sendgrid);
  }

  if (cfg.provider === 'smtp') {
    if (!cfg.smtp) throw new Error('SMTP transport selected but not configured.');
    return new SmtpProvider(cfg.smtp);
  }

  throw new Error(`Unknown transport "${(cfg as EmailConfig).provider}".`);
}

/**
 * Alias for backward compatibility
 */
export const resolveEmailTransport = getEmailProvider;
