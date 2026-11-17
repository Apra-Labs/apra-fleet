import { credentialResolve } from '../../services/credential-store.js';
import { collectOobConfirm } from '../../services/auth-socket.js';
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
 * Resolve a secret from the credential store, enforcing member scoping
 * and network_policy. `callingMember` must be the genuine caller identity:
 * a member friendly name for member sessions, or '*' only for the fleet
 * operator (orchestrator).
 * Throws when the credential exists but is denied to the caller, expired,
 * or blocked from network egress, so those cases surface their real reason
 * instead of "not found".
 */
export async function resolveSecret(credentialName: string, callingMember: string): Promise<string | undefined> {
  const resolved = credentialResolve(credentialName, callingMember);
  if (!resolved) return undefined;
  if ('denied' in resolved) throw new Error(resolved.denied);
  if ('expired' in resolved) throw new Error(resolved.expired);

  const policy = resolved.meta.network_policy ?? 'allow';
  if (policy === 'deny') {
    throw new Error(
      `Credential '${credentialName}' has network_policy=deny and cannot be used for network egress.`,
    );
  }
  if (policy === 'confirm') {
    const { confirmed, terminalUnavailable } = await collectOobConfirm(credentialName, {
      command: 'send_email',
      memberName: callingMember,
    });
    if (!confirmed) {
      const reason = terminalUnavailable
        ? 'could not be confirmed (terminal unavailable)'
        : 'was not confirmed';
      throw new Error(`Network egress for credential '${credentialName}' ${reason}.`);
    }
  }

  return resolved.plaintext;
}
