import type { CredentialStatus } from './types.js';

const NEAR_EXPIRY_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export function validateCredentials(json: string): CredentialStatus | null {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return null; }

  const expiresAt: string | undefined = parsed?.expiresAt;
  if (!expiresAt) return null;

  const msLeft = new Date(expiresAt).getTime() - Date.now();

  if (msLeft <= 0) {
    return parsed?.refreshToken
      ? { status: 'expired-refreshable' }
      : { status: 'expired-no-refresh' };
  }

  return msLeft < NEAR_EXPIRY_THRESHOLD_MS
    ? { status: 'near-expiry', minutesLeft: Math.ceil(msLeft / 60000) }
    : { status: 'valid' };
}

export function credentialStatusNote(cs: CredentialStatus | null): string {
  if (!cs) return '';
  if (cs.status === 'valid') return '';
  if (cs.status === 'near-expiry') {
    return `Note: Token expires in ~${cs.minutesLeft} minute${cs.minutesLeft === 1 ? '' : 's'}. Consider re-authenticating to refresh.`;
  }
  return cs.status === 'expired-refreshable'
    ? 'Note: Token is expired but has a refresh token — the agent CLI will auto-refresh on first use.'
    : 'Token is expired with no refresh token. Re-authenticate to get a fresh token before provisioning.';
}
