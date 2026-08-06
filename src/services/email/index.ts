import { credentialResolve } from '../credential-store.js';
import { SendgridTransport } from './sendgrid.js';
import { SmtpTransport } from './smtp.js';
import type { EmailConfig, EmailTransport } from './types.js';

export type { EmailAttachment, EmailMessage, EmailSendResult, EmailTransport, EmailConfig } from './types.js';

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
 * transport is not fully configured.
 */
export function loadEmailConfig(): EmailConfig {
  const transport = (process.env.EMAIL_TRANSPORT ?? 'sendgrid').toLowerCase();

  if (transport === 'smtp') {
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
      transport: 'smtp',
      smtp: { host, port, secure: process.env.SMTP_SECURE === 'true', auth: { user, pass }, from },
    };
  }

  if (transport === 'sendgrid') {
    const apiKey = resolveSecret('sendgrid_api_key', 'SENDGRID_API_KEY');
    const from = process.env.EMAIL_FROM;

    if (!apiKey || !from) {
      throw new Error(
        'SendGrid transport is not configured. Set SENDGRID_API_KEY (or credential "sendgrid_api_key") and EMAIL_FROM.'
      );
    }

    return { transport: 'sendgrid', sendgrid: { apiKey, from } };
  }

  throw new Error(`Unknown EMAIL_TRANSPORT "${transport}". Expected "sendgrid" or "smtp".`);
}

/**
 * Transport resolver: reads config and returns the matching adapter.
 */
export function resolveEmailTransport(config?: EmailConfig): EmailTransport {
  const cfg = config ?? loadEmailConfig();

  if (cfg.transport === 'sendgrid') {
    if (!cfg.sendgrid) throw new Error('SendGrid transport selected but not configured.');
    return new SendgridTransport(cfg.sendgrid);
  }

  if (cfg.transport === 'smtp') {
    if (!cfg.smtp) throw new Error('SMTP transport selected but not configured.');
    return new SmtpTransport(cfg.smtp);
  }

  throw new Error(`Unknown transport "${(cfg as EmailConfig).transport}".`);
}
