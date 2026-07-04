/**
 * Hub-side JWT sign/verify (apra-fleet-us9.4), an MVP stopgap distinct from
 * apra-fleet.exe's own local jwt.ts (~/.apra-fleet/fleet.key, per-install
 * HS256 key). The hub is a separate, already-network-facing service
 * (fleet.apralabs.com) with its own signing authority -- HS256 keyed on the
 * HUB_JWT_SECRET env var here, NOT a local file (the hub has no single
 * "local machine" to derive one from).
 *
 * This is explicitly a stopgap: apra-fleet-us9.5 (Cloud JWT issuance) owns
 * the real design (asymmetric signing, revocation, enrollment exchange).
 * The shape mirrors src/services/jwt.ts deliberately so the eventual
 * migration is a drop-in swap of the signing mechanism, not a claim-shape
 * change -- same pattern as token-issuer.ts's swappable TokenIssuer seam.
 */
import crypto from 'node:crypto';

export interface HubJwtClaims {
  member_id: string;
  workspace_id: string;
  role: string;
}

function b64url(buf: Buffer | string): string {
  const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

function getSecret(): string {
  const secret = process.env.HUB_JWT_SECRET;
  if (!secret) {
    throw new Error('HUB_JWT_SECRET is not set. The hub service requires a signing secret (self-hostable: operators set their own).');
  }
  return secret;
}

export function sign(payload: HubJwtClaims, secret: string = getSecret()): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + SEVEN_DAYS_S }));
  const signing = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', secret).update(signing).digest());
  return signing + '.' + sig;
}

export function verify(token: string, secret: string = getSecret()): HubJwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + body).digest());
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    const decoded = JSON.parse(b64urlDecode(body));
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) return null;
    if (
      typeof decoded.member_id !== 'string' ||
      typeof decoded.workspace_id !== 'string' ||
      typeof decoded.role !== 'string'
    ) {
      return null;
    }
    return { member_id: decoded.member_id, workspace_id: decoded.workspace_id, role: decoded.role };
  } catch {
    return null;
  }
}
