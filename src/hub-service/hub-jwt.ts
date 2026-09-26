/**
 * Hub-side JWT sign/verify (apra-fleet-us9.4/us9.5), an MVP stopgap distinct
 * from apra-fleet.exe's own local jwt.ts (~/.apra-fleet/fleet.key,
 * per-install HS256 key). The hub is a separate, already-network-facing
 * service (fleet.apralabs.com) with its own signing authority -- HS256
 * keyed on the HUB_JWT_SECRET env var here, NOT a local file (the hub has
 * no single "local machine" to derive one from).
 *
 * The SIGNING MECHANISM is explicitly a stopgap: apra-fleet-us9.5's real
 * design (asymmetric signing, hub-brokered enrollment exchange) will
 * replace HS256 wholesale. The `jti` claim and revocation story
 * (src/hub-service/jwt-revocation.ts, src/hub-service/member-tokens.ts),
 * however, are NOT stopgaps -- per-token identity for revocation is
 * orthogonal to the signing algorithm and carries over unchanged once
 * us9.5's asymmetric signer lands, same as apra-fleet.exe's own local
 * jwt.ts's shape is deliberately mirrored here.
 *
 * CLAIMS SHAPE (fixed 2026-07-05, closing a previously-acknowledged
 * contract-shape drift): FIELD NAMES match packages/fleet-api-contract's
 * JWTClaimsSchema field-for-field (iss/ws/sub/exp/role) plus `jti`, which
 * the contract doesn't need but revocation does. This used to be an
 * ad-hoc member_id/workspace_id shape, fixed once the full hub-relay
 * stack (apra-fleet-us9.6/us9.7/us9.12/jfn) was built and tested,
 * providing a real safety net (tsc + the full test suite) for a rename
 * that touches every hub-jwt.ts consumer.
 *
 * `role`'s VALUE DOMAIN (apra-fleet-y2f) is deliberately NOT one uniform
 * enum across every caller, because sign()/verify() here are reused for
 * THREE conceptually different token families with different role
 * vocabularies:
 *   - Dashboard workspace-selection tokens (http-server.ts's
 *     `POST /workspaces/:id/select`): `role` really is the contract's
 *     RoleSchema ('member'|'admin'|'superadmin', a human user's RBAC
 *     level) -- that ONE call site validates against RoleSchema
 *     explicitly (defense-in-depth; `UserRole` is already type-identical).
 *   - Member/agent tokens (member-tokens.ts): `role: 'doer'` -- an
 *     execution-capability tag for a regular fleet member, not an RBAC
 *     level. Not contract-bound.
 *   - Machine/spoke tokens (enrollment.ts): `role` defaults to `'spoke'`
 *     (enrollment_tokens.role column) -- identifies a machine-level relay
 *     identity, again not an RBAC level. Not contract-bound.
 * `HubJwtClaims.role` is therefore typed as a bare `string` here
 * deliberately, not `Role` from the contract -- constraining it to
 * RoleSchema would be a category error for the latter two families.
 */
import crypto from 'node:crypto';

export interface HubJwtClaims {
  /** Issuer -- "hub" for this stopgap signer (see JWTClaimsSchema's `iss`). */
  iss: string;
  /** workspace_id -- the hard security boundary (JWTClaimsSchema's `ws`). */
  ws: string;
  /** Subject -- the member/machine's stable id (JWTClaimsSchema's `sub`). */
  sub: string;
  /** Expiry, unix seconds (JWTClaimsSchema's `exp`). */
  exp: number;
  /** See this file's header comment: value domain varies by token family
   *  (dashboard RBAC role / member 'doer' / machine 'spoke'), only the
   *  first of which is contract-bound. */
  role: string;
  /** Unique per issuance -- the identity revoke()/isRevoked() key on.
   *  Not part of JWTClaimsSchema (dashboard/contract clients don't need
   *  it), but required internally for rotation/revocation. */
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

export type SignInput = Omit<HubJwtClaims, 'jti' | 'exp' | 'iss'> & { iss?: string };

/** Mints a fresh jti for every call -- the caller (member-tokens.ts) persists
 *  it so a later rotation knows what to revoke. `iss` defaults to "hub"
 *  (this stopgap signer has no per-request URL context to embed). */
export function sign(payload: SignInput, secret: string = getSecret()): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SEVEN_DAYS_S;
  const body = b64url(JSON.stringify({ iss: payload.iss ?? 'hub', ws: payload.ws, sub: payload.sub, role: payload.role, jti, iat: now, exp }));
  const signing = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', secret).update(signing).digest());
  return { token: signing + '.' + sig, jti };
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
      typeof decoded.iss !== 'string' ||
      typeof decoded.ws !== 'string' ||
      typeof decoded.sub !== 'string' ||
      typeof decoded.exp !== 'number' ||
      typeof decoded.role !== 'string' ||
      typeof decoded.jti !== 'string'
    ) {
      return null;
    }
    return { iss: decoded.iss, ws: decoded.ws, sub: decoded.sub, exp: decoded.exp, role: decoded.role, jti: decoded.jti };
  } catch {
    return null;
  }
}
