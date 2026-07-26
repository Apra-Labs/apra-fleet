/**
 * `apra-fleet join <member-jwt>` (apra-fleet-6bf, superseding apra-fleet-us9.5/
 * fnz.4's hub-service-based flow): activates a device using a member JWT
 * that a human already obtained out-of-band from fleet-dashboard
 * (POST /v1/ws/:id/members via the dashboard UI, per the AGREED "1b" flow in
 * docs/bootstrap-sync-design-proposal.md -- fleet-dashboard has no
 * short-lived exchange-token endpoint yet, so the long-lived member JWT
 * itself is the credential handed to the device).
 *
 * This calls fleet-dashboard's POST /v1/ws/:id/members/:mid/connect
 * (docs/api-contract.md "Members (JWT-scoped agents)") -- documented as
 * "apra-fleet.exe's first call after registration", which both validates the
 * token (rejecting an unknown/revoked/wrong-workspace/wrong-member token
 * before anything is stored locally) and flips the member's status from
 * "awaiting-connect" to "online" server-side. workspaceId and memberId are
 * read off the token's own `ws`/`sub` claims (decoded, not
 * cryptographically verified -- fleet-dashboard is the only party that can
 * verify the signature; an invalid token simply gets rejected by connect).
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

export const HUB_CREDENTIALS_PATH = path.join(FLEET_DIR, 'hub-credentials.json');

export interface HubCredentials {
  hubUrl: string;
  machineId: string;
  workspaceId: string;
  jwt: string;
}

export interface JoinDeps {
  fetch: typeof fetch;
}

const realDeps: JoinDeps = { fetch: (...a) => globalThis.fetch(...a) };

interface MemberJwtClaims {
  sub?: string;
  ws?: string;
}

function decodeMemberJwtClaims(token: string): MemberJwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('token is not a valid JWT (expected header.payload.signature)');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as MemberJwtClaims;
}

export async function runJoin(args: string[], deps: JoinDeps = realDeps): Promise<void> {
  const token = args[0];
  if (!token) {
    console.error('Usage: apra-fleet join <member-jwt> [--hub-url <url>]');
    process.exitCode = 1;
    return;
  }

  const hubUrlIdx = args.indexOf('--hub-url');
  const hubUrl = hubUrlIdx !== -1 && args[hubUrlIdx + 1]
    ? args[hubUrlIdx + 1]
    : (process.env.APRA_FLEET_HUB_URL ?? 'https://fleet.apralabs.com');

  let claims: MemberJwtClaims;
  try {
    claims = decodeMemberJwtClaims(token);
  } catch (err: any) {
    console.error(`Invalid member JWT: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!claims.ws || !claims.sub) {
    console.error('Invalid member JWT: missing workspace (ws) or member (sub) claim');
    process.exitCode = 1;
    return;
  }

  const workspaceId = claims.ws;
  const memberId = claims.sub;

  let response: Response;
  try {
    response = await deps.fetch(`${hubUrl}/v1/ws/${workspaceId}/members/${memberId}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
  } catch (err: any) {
    console.error(`Could not reach fleet-dashboard at ${hubUrl}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`Enrollment failed (${response.status}): ${body || response.statusText}`);
    process.exitCode = 1;
    return;
  }

  const result = await response.json() as { member: { id: string; name?: string } };

  fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  const credentials: HubCredentials = { hubUrl, machineId: memberId, workspaceId, jwt: token };
  fs.writeFileSync(HUB_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log(`Enrolled machine ${result.member.id} in workspace ${workspaceId}.`);
  console.log(`Hub credentials stored at ${HUB_CREDENTIALS_PATH}.`);
  console.log('Spoke mode (outbound hub connectivity, apra-fleet-us9.6) is not yet built -- this credential is stored for that future use.');
}
