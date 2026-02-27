const NEAR_EXPIRY_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export type CredentialStatus =
  | { status: 'valid' }
  | { status: 'near-expiry'; minutesLeft: number }
  | { status: 'expired-refreshable' }
  | { status: 'expired-no-refresh' };

export function validateCredentials(json: string): CredentialStatus | null {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return null; }

  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.expiresAt) return null;

  const msLeft = new Date(oauth.expiresAt).getTime() - Date.now();

  if (msLeft <= 0) {
    return oauth.refreshToken
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
    return `Note: Token expires in ~${cs.minutesLeft} minute${cs.minutesLeft === 1 ? '' : 's'}. Consider running /login to refresh.`;
  }
  return cs.status === 'expired-refreshable'
    ? 'Note: Token is expired but has a refresh token — the agent CLI will auto-refresh on first use.'
    : 'Token is expired with no refresh token. Run /login to get a fresh token before provisioning.';
}
