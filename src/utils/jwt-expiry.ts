const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * exp of a JWT, as an ISO time, decoded locally; null for anything that is not
 * three base64url segments whose middle one is a JSON object with a numeric
 * exp. Nothing else is read from the token.
 */
export function jwtExpiry(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(p => BASE64URL_SEGMENT.test(p))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    const at = new Date(exp * 1000);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  } catch {
    return null;
  }
}
