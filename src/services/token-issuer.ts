/**
 * Pluggable token issuer (apra-fleet-2xs.2 rescope / apra-fleet-us9.2).
 *
 * The JWT hard security boundary is the `workspace_id` claim (NOT project_id --
 * see docs/hub-spoke-master-plan.md section 3). Tokens are minted and verified
 * through the TokenIssuer seam so that the hub era (dashboard-issued,
 * asymmetric-key tokens) can replace the local dev-mode issuer without any
 * change to token shape or to the enforcement code that consumes claims.
 *
 * Phase 1 semantics: one machine == one implicit workspace. The local issuer
 * derives its workspace_id from the install's own signing-key identity
 * (~/.apra-fleet/fleet.key), which is stable for the lifetime of the install
 * and non-reversible (sha256 of the 32-byte random key).
 */

import crypto from 'node:crypto';
import { getOrCreateKey, sign, verify, type JwtClaims } from './jwt.js';

export interface IssueTokenParams {
  member_id: string;
  role: string;
  work_folder: string;
  /** Optional non-security grouping label inside a workspace. Carries ZERO
   *  security weight -- workspace_id is the only enforcement boundary. */
  project_id?: string;
}

export interface TokenIssuer {
  /** The workspace this issuer mints tokens for. */
  workspaceId(): string;
  /** Mint a signed token carrying the workspace_id hard boundary. */
  issue(params: IssueTokenParams): string;
  /** Verify a token. Returns null for invalid/expired/foreign-signed tokens. */
  verify(token: string): JwtClaims | null;
}

/**
 * Derive the local install's workspace id: stable per install, bound to the
 * same identity that signs local tokens (the fleet key), non-reversible.
 */
export function localWorkspaceId(): string {
  const key = getOrCreateKey();
  const digest = crypto.createHash('sha256')
    .update('apra-fleet-workspace-v1:' + key)
    .digest('hex');
  return 'ws-' + digest.slice(0, 16);
}

/** Dev-mode issuer: local HS256 mint, one-machine-one-workspace. */
class LocalTokenIssuer implements TokenIssuer {
  workspaceId(): string {
    return localWorkspaceId();
  }

  issue(params: IssueTokenParams): string {
    return sign({
      member_id: params.member_id,
      workspace_id: this.workspaceId(),
      role: params.role,
      work_folder: params.work_folder,
      ...(params.project_id !== undefined ? { project_id: params.project_id } : {}),
    });
  }

  verify(token: string): JwtClaims | null {
    return verify(token);
  }
}

let activeIssuer: TokenIssuer = new LocalTokenIssuer();

/** The issuer currently in effect (local dev-mode issuer by default). */
export function getTokenIssuer(): TokenIssuer {
  return activeIssuer;
}

/**
 * Swap seam for the hub era: a dashboard/hub-backed issuer (asymmetric-key
 * verify, remote mint) replaces the local one here with no changes anywhere
 * else. Also used by tests.
 */
export function setTokenIssuer(issuer: TokenIssuer): void {
  activeIssuer = issuer;
}

/** Restore the default local issuer (test hygiene). */
export function resetTokenIssuer(): void {
  activeIssuer = new LocalTokenIssuer();
}
