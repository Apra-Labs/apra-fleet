/**
 * Pull-sync (apra-fleet-aho): fetches the SaaS-connected workspace's
 * member/project config from fleet-dashboard's GET /v1/ws/:id/bootstrap
 * (fleet-dashboard-1il) and caches it as a sibling JSON file, per
 * docs/bootstrap-sync-design-proposal.md question 2 ("one JSON file or
 * two, not JSON vs. a DB") -- deliberately NOT merged into
 * registry.ts's registry.json, since a fleet-dashboard "workspace member"
 * (a cloud collaborator/agent identity) is a different concept from this
 * file's local SSH/relay-connected Agent registry.
 *
 * Sync is a plain on-demand fetch (no background polling daemon, per
 * question 4) with fail-open behavior (question 5): network failure or a
 * 5xx/429 response falls back to the last-synced cache rather than
 * blocking the caller, but a 401 is a distinct, non-fail-open state
 * (rotation has no grace period -- silently retrying on a dead credential
 * would mask a deliberate revocation) that callers must surface, not swallow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { HUB_CREDENTIALS_PATH, type HubCredentials } from '../cli/join.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';

export const CLOUD_CACHE_PATH = path.join(FLEET_DIR, 'cloud-cache.json');

export interface CloudCache {
  workspaceId: string;
  // Kept as unknown[] (not a narrowed Member/Project type) so unrecognized
  // fields fleet-dashboard adds later round-trip through this cache
  // untouched, per the negotiation's additive-only contract-evolution rule.
  members: unknown[];
  projects: unknown[];
  lastSyncedAt: number;
}

export type CloudSyncResult =
  | { status: 'synced'; cache: CloudCache }
  | { status: 'offline'; cache: CloudCache | null }
  | { status: 'not-connected' }
  | { status: 'credential-expired' };

export interface CloudSyncDeps {
  fetch: typeof fetch;
  now(): number;
  readCredentials(): HubCredentials | null;
}

const realDeps: CloudSyncDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
  readCredentials: readHubCredentials,
};

export function readHubCredentials(): HubCredentials | null {
  if (!fs.existsSync(HUB_CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(HUB_CREDENTIALS_PATH, 'utf-8')) as HubCredentials;
  } catch {
    return null;
  }
}

export function readCloudCache(): CloudCache | null {
  if (!fs.existsSync(CLOUD_CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CLOUD_CACHE_PATH, 'utf-8')) as CloudCache;
  } catch {
    return null;
  }
}

function writeCloudCache(cache: CloudCache): void {
  fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CLOUD_CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
  enforceOwnerOnly(CLOUD_CACHE_PATH);
}

/**
 * Fail-open triggers on network failure or any non-401 error response
 * (5xx, 429, or anything else fleet-dashboard might return) -- never on
 * 401, which is surfaced as its own distinct `credential-expired` status
 * so a caller can prompt for re-enrollment/rotation instead of silently
 * operating on stale data next to a dead credential.
 */
export async function syncCloudCache(deps: CloudSyncDeps = realDeps): Promise<CloudSyncResult> {
  const creds = deps.readCredentials();
  if (!creds) return { status: 'not-connected' };

  let response: Response;
  try {
    response = await deps.fetch(`${creds.hubUrl}/v1/ws/${creds.workspaceId}/bootstrap`, {
      headers: { Authorization: `Bearer ${creds.jwt}` },
    });
  } catch {
    return { status: 'offline', cache: readCloudCache() };
  }

  if (response.status === 401) {
    return { status: 'credential-expired' };
  }

  if (!response.ok) {
    return { status: 'offline', cache: readCloudCache() };
  }

  const body = await response.json().catch(() => null) as { members?: unknown[]; projects?: unknown[] } | null;
  const cache: CloudCache = {
    workspaceId: creds.workspaceId,
    members: body?.members ?? [],
    projects: body?.projects ?? [],
    lastSyncedAt: deps.now(),
  };
  writeCloudCache(cache);
  return { status: 'synced', cache };
}
