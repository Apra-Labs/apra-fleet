import { credentialResolve } from '../../services/credential-store.js';
import { SendGridProvider } from './sendgrid.js';
import { SmtpProvider } from './smtp.js';
import type { EmailConfig, EmailProvider } from './provider.js';

export type {
  EmailAttachment,
  EmailMessage,
  EmailSendResult,
  EmailProvider,
  EmailConfig,
  EmailProviderName,
} from './provider.js';

/**
 * Construct an EmailProvider from an EmailConfig. Adding a provider is a
 * new EmailConfig branch here -- callers (send_email) do not grow an if/else.
 */
export function createEmailProvider(config: EmailConfig): EmailProvider {
  switch (config.provider) {
    case 'smtp':
      if (!config.smtp) throw new Error('SMTP provider requires smtp config.');
      return new SmtpProvider(config.smtp);
    case 'sendgrid':
      if (!config.sendgrid) throw new Error('SendGrid provider requires sendgrid config.');
      return new SendGridProvider(config.sendgrid);
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown email provider: ${_exhaustive}`);
    }
  }
}

/**
 * Resolve a secret from the credential store, enforcing member scoping.
 * `callingMember` must be the genuine caller identity: a member friendly name
 * for member sessions, or '*' only for the fleet operator (orchestrator).
 * Throws when the credential exists but is denied to the caller or expired,
 * so those cases surface their real reason instead of "not found".
 */
export function resolveSecret(credentialName: string, callingMember: string): string | undefined {
  const resolved = credentialResolve(credentialName, callingMember);
  if (!resolved) return undefined;
  if ('denied' in resolved) throw new Error(resolved.denied);
  if ('expired' in resolved) throw new Error(resolved.expired);
  return resolved.plaintext;
}
