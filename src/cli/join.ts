/**
 * `apra-fleet join <token>` (apra-fleet-us9.5/fnz.4): exchanges a
 * hub-issued enrollment token for a machine JWT, entirely via an OUTBOUND
 * call to the hub -- no local server needs to accept any inbound
 * connection for this (docs/hub-spoke-master-plan.md section 4). Stores
 * the result locally for apra-fleet-us9.6 (spoke mode, not yet built) to
 * eventually use for its outbound hub connection.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  hostname(): string;
}

const realDeps: JoinDeps = { fetch: (...a) => globalThis.fetch(...a), hostname: () => os.hostname() };

export async function runJoin(args: string[], deps: JoinDeps = realDeps): Promise<void> {
  const token = args[0];
  if (!token) {
    console.error('Usage: apra-fleet join <token> [--hub-url <url>]');
    process.exitCode = 1;
    return;
  }

  const hubUrlIdx = args.indexOf('--hub-url');
  const hubUrl = hubUrlIdx !== -1 && args[hubUrlIdx + 1]
    ? args[hubUrlIdx + 1]
    : (process.env.APRA_FLEET_HUB_URL ?? 'https://fleet.apralabs.com');

  const hostname = deps.hostname();

  let response: Response;
  try {
    response = await deps.fetch(`${hubUrl}/join/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, hostname }),
    });
  } catch (err: any) {
    console.error(`Could not reach hub at ${hubUrl}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`Enrollment failed (${response.status}): ${body || response.statusText}`);
    process.exitCode = 1;
    return;
  }

  const result = await response.json() as { machineId: string; workspaceId: string; jwt: string };

  fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  const credentials: HubCredentials = { hubUrl, machineId: result.machineId, workspaceId: result.workspaceId, jwt: result.jwt };
  fs.writeFileSync(HUB_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log(`Enrolled machine ${result.machineId} in workspace ${result.workspaceId}.`);
  console.log(`Hub credentials stored at ${HUB_CREDENTIALS_PATH}.`);
  console.log('Spoke mode (outbound hub connectivity, apra-fleet-us9.6) is not yet built -- this credential is stored for that future use.');
}
