/**
 * Dashboard-facing Member view-model assembly (apra-fleet-us9.4), joining
 * the raw CRUD data (members.ts, machines.ts) with live state (presence.ts)
 * into the shape packages/fleet-api-contract's MemberSchema requires.
 *
 * Separable from apra-fleet-us9.5 (JWT issuance) and apra-fleet-us9.16
 * (OAuth/RBAC): this is pure read-side aggregation over data this service
 * already owns, not an auth or issuance concern.
 *
 * Honesty contract (matching the usage-ledger honesty contract elsewhere in
 * this codebase -- never fake a value that isn't really tracked yet):
 * - `model`: not yet tracked anywhere in the hub schema -- always `null`.
 * - `tags`: not yet a column on `members` -- always `[]`.
 * - `lastPrompt`/`lastPromptAt`: no relay traffic flows through this hub yet
 *   (apra-fleet-us9.6 spoke mode, which would populate relay_queue for real
 *   dispatches, is unbuilt) -- always `null`. Wiring this up for real is
 *   that work's job, not something to fabricate here.
 * - `jwtExp`: no per-member token-expiry record is persisted yet (hub-jwt.ts
 *   is a stateless signer) -- always `0` ("expired/unknown"), per
 *   MemberSchema's own "0 = expired" convention, rather than a made-up number.
 * - `agentVer`: not yet reported by any spoke to this hub -- `'unknown'`.
 * - `reservedBy`: server-side member reservation (apra-fleet-eft.10) is
 *   scoped to the local fleet-server Agent registry, not this hub-service
 *   workspace-member store -- always `null` here.
 */
import { getMember, listMembers } from './members.js';
import { getMachine } from './machines.js';
import { listForMachine } from './presence.js';
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface MemberView {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  machine: string;
  folder: string;
  status: 'busy' | 'online' | 'offline' | 'awaiting-connect';
  lastSeen: number | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
  tags: string[];
  jwtExp: number;
  agentVer: string;
  reservedBy: string | null;
}

async function assembleView(
  workspaceId: string,
  member: { id: string; name: string; provider: string; machine_id: string | null; work_folder: string | null },
  pool: Pool,
): Promise<MemberView> {
  let hostname = 'unknown';
  let status: MemberView['status'] = 'awaiting-connect';
  let lastSeen: number | null = null;

  if (member.machine_id) {
    const machine = await getMachine(workspaceId, member.machine_id, pool);
    if (machine) {
      hostname = machine.hostname;
      const presenceRows = await listForMachine(member.machine_id, pool);
      const own = presenceRows.find(p => p.member_id === member.id);
      if (own) {
        status = own.status as MemberView['status'];
        lastSeen = Math.max(0, Math.floor((Date.now() - new Date(own.last_seen).getTime()) / 1000));
      } else {
        status = 'offline';
      }
    }
  }

  return {
    id: member.id,
    name: member.name,
    provider: member.provider,
    model: null,
    machine: hostname,
    folder: member.work_folder && member.work_folder.length > 0 ? member.work_folder : 'unknown',
    status,
    lastSeen,
    lastPrompt: null,
    lastPromptAt: null,
    tags: [],
    jwtExp: 0,
    agentVer: 'unknown',
    reservedBy: null,
  };
}

export async function getMemberView(
  workspaceId: string,
  memberId: string,
  pool: Pool = getPool(),
): Promise<MemberView | null> {
  const member = await getMember(workspaceId, memberId, pool);
  if (!member) return null;
  return assembleView(workspaceId, member, pool);
}

export async function listMemberViews(workspaceId: string, pool: Pool = getPool()): Promise<MemberView[]> {
  const members = await listMembers(workspaceId, pool);
  return Promise.all(members.map(m => assembleView(workspaceId, m, pool)));
}
