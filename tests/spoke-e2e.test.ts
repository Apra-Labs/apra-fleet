/**
 * Full spoke-to-spoke round trip (apra-fleet-jfn), the acceptance test for
 * "apra-fleet.exe has a runnable spoke-mode command that connects to the
 * hub and can both fulfill and originate relayed execute_command calls
 * end-to-end against a real (or pg-mem-backed) hub service." Two spoke
 * instances (runSpoke) connect to the SAME real hub HTTP server (real
 * pg-mem persistence, not a mock): machine B fulfills a relayed
 * execute_command (via a REAL LocalStrategy child process) addressed to a
 * member it hosts; machine A originates the request via RelayStrategy and
 * receives the correlated result over its own stream.
 *
 * relay-context.ts is a process-wide singleton, so within this single test
 * process, whichever runSpoke() call happens LAST owns the active context
 * -- B is started first (its context is irrelevant here, it never
 * originates), A is started last (so RelayStrategy, called immediately
 * after, uses A's context/registry -- the SAME registry instance A's own
 * hub-client composes into its onEnvelope dispatch, so a result delivered
 * over A's stream resolves the pending promise RelayStrategy is awaiting).
 *
 * This exact test is what caught two real bugs earlier in this session
 * (correlation_id never persisted; relay-executor.ts never addressing its
 * result back to the originator) -- both were fixed prerequisites to this
 * test passing at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPool, closePool } from '../src/hub-service/db/pool.js';
import { createWorkspace } from '../src/hub-service/workspaces.js';
import { createMember } from '../src/hub-service/members.js';
import { createHttpServer, listen, type HttpServerHandle } from '../src/hub-service/http-server.js';
import { sign } from '../src/hub-service/hub-jwt.js';
import { runSpoke, type SpokeDeps } from '../src/cli/spoke.js';
import { setRelayContext } from '../src/services/relay-context.js';
import { RelayStrategy } from '../src/services/relay-strategy.js';
import type { Agent } from '../src/types.js';

const SECRET = 'test-hub-secret';

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

const HOST_OS: 'windows' | 'macos' | 'linux' = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const successCommand = HOST_OS === 'windows' ? "Write-Output 'relay-e2e'" : "node -e \"console.log('relay-e2e')\"";

describe('spoke-to-spoke relayed execute_command (real HTTP + real pg-mem + real child process)', () => {
  let pool: any;
  let handle: HttpServerHandle;
  let port: number;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);
    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
  });

  afterEach(async () => {
    setRelayContext(null);
    await handle.close();
    await closePool();
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('machine A originates a relayed execute_command that machine B fulfills via a real child process, and A receives the correlated result', async () => {
    const hubUrl = `http://127.0.0.1:${port}`;

    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);

    const { token: tokenA } = sign({ member_id: 'mach-a', workspace_id: 'ws-a', role: 'spoke' }, SECRET);
    const { token: tokenB } = sign({ member_id: 'mach-b', workspace_id: 'ws-a', role: 'spoke' }, SECRET);

    // B hosts target-member as a REAL local agent -- relay-executor.ts's
    // real LocalStrategy path, exercised through the full spoke wiring
    // this time, not in isolation.
    const localAgentOnB: Agent = {
      id: 'local-agent-b', friendlyName: 'target', agentType: 'local', os: HOST_OS,
      workFolder: os.tmpdir(), createdAt: new Date().toISOString(),
    };

    const depsB: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-b',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-b', workspaceId: 'ws-a', jwt: tokenB }),
      getAgentForMember: (memberId) => (memberId === 'target-member' ? localAgentOnB : null),
      getMemberSnapshot: () => [{ memberId: 'target-member', status: 'online' }],
      onLog: () => {},
    };
    const spokeB = runSpoke('target-member', depsB);
    expect(spokeB).not.toBeNull();

    const depsA: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-a',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-a', workspaceId: 'ws-a', jwt: tokenA }),
      getAgentForMember: () => null,
      getMemberSnapshot: () => [{ memberId: 'origin-member', status: 'online' }],
      onLog: () => {},
    };
    // Started LAST: relay-context.ts is a process-wide singleton, and
    // RelayStrategy (used next) reads whichever context was set most
    // recently -- this must be A's, since A is the one originating.
    const spokeA = runSpoke('origin-member', depsA);
    expect(spokeA).not.toBeNull();

    try {
      // Give both spokes a moment to connect and announce presence before
      // relying on the hub knowing about them (not strictly required for
      // this flow, but matches real startup ordering).
      await new Promise((r) => setTimeout(r, 200));

      const relayAgentTargetingB: Agent = {
        id: 'relay-agent', friendlyName: 'via-relay', agentType: 'relay', relayMemberId: 'target-member',
        workFolder: '/tmp', createdAt: new Date().toISOString(),
      };
      const strategy = new RelayStrategy(relayAgentTargetingB);
      const result = await strategy.execCommand(successCommand, 8000);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('relay-e2e');
    } finally {
      spokeA?.stop();
      spokeB?.stop();
    }
  }, 20000);
});
