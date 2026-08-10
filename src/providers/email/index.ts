import { credentialResolve } from '../../services/credential-store.js';
import { SendGridProvider } from './sendgrid.js';
import { SmtpProvider } from './smtp.js';
import type { EmailConfig, EmailProvider } from './provider.js';

export type { EmailAttachment, EmailMessage, EmailSendResult, EmailProvider, EmailConfig } from './provider.js';

export function resolveSecret(credentialName: string): string | undefined {
  const resolved = credentialResolve(credentialName, '*');
  if (resolved && 'plaintext' in resolved) return resolved.plaintext;
  return undefined;
}

export function getEmailProvider(config: EmailConfig): EmailProvider {
  if (config.provider === 'sendgrid') {
    if (!config.sendgrid) throw new Error('SendGrid transport selected but not configured.');
    return new SendGridProvider(config.sendgrid);
  }

  if (config.provider === 'smtp') {
    if (!config.smtp) throw new Error('SMTP transport selected but not configured.');
    return new SmtpProvider(config.smtp);
  }

  throw new Error(`Unknown transport "${(config as EmailConfig).provider}".`);
}
