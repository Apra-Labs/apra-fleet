import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Resolved lazily on every call (never cached at module load) so that
 * changing `os.homedir()` -- e.g. a test pointing `process.env.HOME` at a
 * temp directory before calling `getOrCreateKey()` -- actually takes effect.
 * A module-load-time constant would freeze whatever home directory was
 * current at first import, which on POSIX is read from `process.env.HOME`
 * (`os.homedir()`'s own resolution order): a test that sets `HOME` in
 * `beforeEach` (after the module has already been imported once) would
 * silently keep reading/writing the real developer's `~/.apra-fleet/fleet.key`
 * instead of the temp one it thinks it isolated to (apra-fleet-iywi.2.2 review
 * finding).
 */
function keyPath(): string {
  return path.join(os.homedir(), '.apra-fleet', 'fleet.key');
}

export function getOrCreateKey(): string {
  const filePath = keyPath();
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing.length === 64) return existing;
  } catch {
    // file missing or unreadable -- create it
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, key, { encoding: 'utf8', mode: 0o600 });
  return key;
}

export interface JwtClaims {
  member_id: string;
  /** HARD security boundary (docs/hub-spoke-master-plan.md section 3).
   *  Phase 1: one machine == one implicit workspace, minted by the local
   *  issuer (src/services/token-issuer.ts); hub-era: minted by the dashboard.
   *  Same claim shape either way -- no token migration needed. */
  workspace_id: string;
  role: string;
  work_folder: string;
  /** Optional grouping label inside a workspace. Carries ZERO security
   *  weight -- no enforcement check may rely on it. */
  project_id?: string;
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

export function sign(payload: JwtClaims): string {
  const key = getOrCreateKey();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + SEVEN_DAYS_S }));
  const signing = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', key).update(signing).digest());
  return signing + '.' + sig;
}

export function verify(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key = getOrCreateKey();
    const expectedSig = b64url(crypto.createHmac('sha256', key).update(header + '.' + body).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const decoded = JSON.parse(b64urlDecode(body));
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) return null;
    if (
      typeof decoded.member_id !== 'string' ||
      typeof decoded.workspace_id !== 'string' ||
      typeof decoded.role !== 'string' ||
      typeof decoded.work_folder !== 'string'
    ) {
      return null;
    }
    return {
      member_id: decoded.member_id,
      workspace_id: decoded.workspace_id,
      role: decoded.role,
      work_folder: decoded.work_folder,
      ...(typeof decoded.project_id === 'string' ? { project_id: decoded.project_id } : {}),
    };
  } catch {
    return null;
  }
}
