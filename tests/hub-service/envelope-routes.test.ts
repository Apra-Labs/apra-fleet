/**
 * Envelope submission (apra-fleet-us9.6 slice 1) unit tests: real pg-mem
 * running every real migration file, proving submitEnvelope() routes
 * presence and relay kinds correctly per docs/hub-spoke-wire-protocol.md
 * sections 3-5, including the workspace-boundary and unknown-target
 * rejections.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember } from '../../src/hub-service/members.js';
import { submitEnvelope, type InboundEnvelope } from '../../src/hub-service/envelope-routes.js';
import { fetchDeliverable } from '../../src/hub-service/relay-queue.js';
import { listForMachine } from '../../src/hub-service/presence.js';

let pool: any;

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
    await p.query(sql);
  }
  return p;
}

const claims = (workspaceId: string, machineId: string) => ({ member_id: machineId, workspace_id: workspaceId, role: 'spoke', jti: 'jti-1' });

describe('submitEnvelope (apra-fleet-us9.6 slice 1)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-1', 'Workspace One', pool);
    await createWorkspace('ws-2', 'Workspace Two', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('rejects an envelope whose workspace_id does not match the bearer token', async () => {
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-2', kind: 'presence.heartbeat',
      from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: null },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(400);
  });

  it('rejects an unrecognized kind', async () => {
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'bogus.kind',
      from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: null },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(400);
  });

  it('presence.announce replaces the machine snapshot and returns a presence.ack', async () => {
    await createMember('mem-1', 'ws-1', { name: 'Alice', provider: 'anthropic' }, pool);
    await createMember('mem-2', 'ws-1', { name: 'Bob', provider: 'anthropic' }, pool);
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'presence.announce',
      from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: null },
      payload: { members: [{ member_id: 'mem-1', status: 'online' }, { member_id: 'mem-2', status: 'busy' }] },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(200);
    expect((result.body as any).kind).toBe('presence.ack');
    expect((result.body as any).payload.next_heartbeat_due_ms).toBeGreaterThan(0);

    const rows = await listForMachine('mach-1', pool);
    expect(rows.map((r) => r.member_id).sort()).toEqual(['mem-1', 'mem-2']);

    // A second announce with a SMALLER snapshot must drop the stale member
    // (full-snapshot replace, not merge -- wire-protocol.md section 4).
    const env2: InboundEnvelope = { ...env, envelope_id: 'e2', payload: { members: [{ member_id: 'mem-1', status: 'online' }] } };
    await submitEnvelope(claims('ws-1', 'mach-1'), env2, pool);
    const rows2 = await listForMachine('mach-1', pool);
    expect(rows2.map((r) => r.member_id)).toEqual(['mem-1']);
  });

  it('presence.announce (apra-fleet-us9.11.1) silently drops a member_id that does not resolve in the caller\'s workspace, without rejecting the rest of the snapshot', async () => {
    await createMember('mem-1', 'ws-1', { name: 'Alice', provider: 'anthropic' }, pool);
    await createMember('mem-x', 'ws-2', { name: 'Eve', provider: 'anthropic' }, pool);
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'presence.announce',
      from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: null },
      payload: { members: [{ member_id: 'mem-1', status: 'online' }, { member_id: 'mem-x', status: 'online' }, { member_id: 'no-such-member', status: 'online' }] },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(200);

    const rows = await listForMachine('mach-1', pool);
    expect(rows.map((r) => r.member_id)).toEqual(['mem-1']);
  });

  it('presence.heartbeat renews last_seen for an already-announced member without dropping others', async () => {
    await createMember('mem-1', 'ws-1', { name: 'Alice', provider: 'anthropic' }, pool);
    const announceEnv: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'presence.announce',
      from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: null },
      payload: { members: [{ member_id: 'mem-1', status: 'online' }] },
    };
    await submitEnvelope(claims('ws-1', 'mach-1'), announceEnv, pool);

    const hbEnv: InboundEnvelope = {
      envelope_id: 'e2', workspace_id: 'ws-1', kind: 'presence.heartbeat',
      from: { machine_id: 'mach-1', member_id: 'mem-1' }, to: { machine_id: null, member_id: null },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), hbEnv, pool);
    expect(result.status).toBe(200);
    const rows = await listForMachine('mach-1', pool);
    expect(rows).toHaveLength(1);
  });

  it('presence.heartbeat (apra-fleet-us9.11.1) is a no-op for a member_id that does not resolve in the caller\'s workspace', async () => {
    const hbEnv: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'presence.heartbeat',
      from: { machine_id: 'mach-1', member_id: 'no-such-member' }, to: { machine_id: null, member_id: null },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), hbEnv, pool);
    expect(result.status).toBe(200);
    const rows = await listForMachine('mach-1', pool);
    expect(rows).toHaveLength(0);
  });

  it('enqueues a relay-kind envelope addressed to a member that resolves in the same workspace', async () => {
    await createMember('mem-1', 'ws-1', { name: 'Alice', provider: 'anthropic' }, pool);
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'execute_command.request',
      from: { machine_id: 'mach-1', member_id: 'mem-1' }, to: { machine_id: 'mach-2', member_id: 'mem-1' },
      payload: { cmd: 'ls' },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(202);

    const deliverable = await fetchDeliverable('ws-1', 'mem-1', pool);
    expect(deliverable).toHaveLength(1);
    expect(deliverable[0].kind).toBe('execute_command.request');
    expect(deliverable[0].payload).toEqual({ cmd: 'ls' });
  });

  it('rejects a relay envelope targeting a member from a DIFFERENT workspace (403, not a silent drop)', async () => {
    await createMember('mem-x', 'ws-2', { name: 'Eve', provider: 'anthropic' }, pool);
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'execute_command.request',
      from: { machine_id: 'mach-1', member_id: 'mem-1' }, to: { machine_id: null, member_id: 'mem-x' },
      payload: { cmd: 'ls' },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(403);
  });

  it('rejects a relay envelope with no to.member_id', async () => {
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'execute_command.request',
      from: { machine_id: 'mach-1', member_id: 'mem-1' }, to: { machine_id: null, member_id: null },
      payload: { cmd: 'ls' },
    };
    const result = await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    expect(result.status).toBe(400);
  });

  it('is idempotent on retry with the same envelope_id (re-admission is a no-op, not a duplicate)', async () => {
    await createMember('mem-1', 'ws-1', { name: 'Alice', provider: 'anthropic' }, pool);
    const env: InboundEnvelope = {
      envelope_id: 'e1', workspace_id: 'ws-1', kind: 'execute_command.request',
      from: { machine_id: 'mach-1', member_id: 'mem-1' }, to: { machine_id: null, member_id: 'mem-1' },
      payload: { cmd: 'ls' },
    };
    await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    await submitEnvelope(claims('ws-1', 'mach-1'), env, pool);
    const deliverable = await fetchDeliverable('ws-1', 'mem-1', pool);
    expect(deliverable).toHaveLength(1);
  });
});
