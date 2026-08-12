import { credentialResolve } from '../../services/credential-store.js';

export type { EmailAttachment, EmailMessage, EmailSendResult, EmailProvider, EmailConfig } from './provider.js';

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
