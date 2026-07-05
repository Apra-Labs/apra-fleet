/**
 * Dashboard OAuth session token (apra-fleet-us9.16), identity-only, no
 * workspace. Per docs/dashboard-oauth-rbac-design.md section 1: the
 * published JWTClaimsSchema carries exactly one workspace_id + role, but
 * "list all MY workspaces + role in each" (GET /workspaces) has to be
 * answerable BEFORE any single workspace is selected -- this session token
 * is that answer. Once a workspace is selected, a separate
 * workspace-scoped token authenticates every /ws/:id/... route (see
 * http-server.ts's mintWorkspaceToken, which reuses hub-jwt.ts).
 *
 * Known, documented drift (not fixed here -- see http-server.ts's own
 * comment on this): this deliberately does NOT reuse hub-jwt.ts's
 * HubJwtClaims shape (member_id/workspace_id/role), since a human dashboard
 * user's session identity is a genuinely different concept from a
 * member/spoke token. It also does not yet match the published
 * JWTClaimsSchema's exact field names (iss/ws/sub/exp/role) -- that schema
 * assumes a workspace is already selected (`ws` is required), which a
 * session token by definition has not. Reconciling the full claim-shape
 * family (member tokens, session tokens, workspace-selection tokens) is a
 * legitimate follow-up, not silently resolved by picking new field names
 * with no scrutiny.
 */
import crypto from 'node:crypto';

export interface SessionClaims {
  sub: string; // user id
  jti: string;
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

export function signSession(sub: string, secret: string = getSecret()): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ sub, jti, iat: now, exp: now + SEVEN_DAYS_S }));
  const signing = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', secret).update(signing).digest());
  return { token: signing + '.' + sig, jti };
}

export function verifySession(token: string, secret: string = getSecret()): SessionClaims | null {
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
    if (typeof decoded.sub !== 'string' || typeof decoded.jti !== 'string') return null;
    return { sub: decoded.sub, jti: decoded.jti };
  } catch {
    return null;
  }
}
