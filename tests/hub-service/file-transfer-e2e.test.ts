/**
 * Real end-to-end proof for hub-brokered file transfer (apra-fleet-us9.12),
 * written in response to an independent adversarial review that found:
 * every existing file-transfer test mocked `submitEnvelope` directly and
 * fed the receiver its chunks by hand, so the sender -> hub -> receiver
 * round trip had NEVER actually been exercised -- exactly the
 * mocked-transport blind spot that hid three other wire-protocol bugs
 * found earlier this session. tests/file-transfer-relay.test.ts's own
 * header falsely cited this file as already existing; it did not, until
 * now.
 *
 * Mirrors tests/spoke-e2e.test.ts's pattern: two real spoke instances
 * (runSpoke) against the SAME real HTTP hub server + real pg-mem. Machine
 * A sends a real file (chunked, multi-chunk to prove reassembly) to a
 * member hosted on machine B; B's spoke (via createFileTransferReceiver,
 * now wired into spoke.ts's dispatch) reassembles, verifies the sha256,
 * and writes it to a real (test-scoped) directory, then posts the
 * correlated file_transfer.result back; A receives it over its own
 * stream.
 *
 * apra-fleet-8yn wired RelayStrategy.transferFiles to sendFileOverRelay
 * (the push/send direction) -- see the dedicated "RelayStrategy.transferFiles"
 * describe block below for the real end-to-end proof of THAT path, through
 * getStrategy()/AgentStrategy rather than calling sendFileOverRelay
 * directly. receiveFiles/deleteFiles still throw "not yet supported": no
 * pull-direction wire-protocol kind exists yet (sendFileOverRelay is
 * push-only), and deletion has no relay kind at all -- honest gaps, not
 * hidden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember } from '../../src/hub-service/members.js';
import { createHttpServer, listen, type HttpServerHandle } from '../../src/hub-service/http-server.js';
import { sign } from '../../src/hub-service/hub-jwt.js';
import { runSpoke, type SpokeDeps } from '../../src/cli/spoke.js';
import { setRelayContext, getRelayContext } from '../../src/services/relay-context.js';
import { sendFileOverRelay } from '../../src/services/file-transfer-relay.js';
import { RelayStrategy } from '../../src/services/relay-strategy.js';
import type { Agent } from '../../src/types.js';

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

describe('file transfer over relay: sender -> real hub -> receiver (real HTTP + real pg-mem)', () => {
  let pool: any;
  let handle: HttpServerHandle;
  let port: number;
  let receivedDir: string;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);
    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
    receivedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-transfer-e2e-'));
  });

  afterEach(async () => {
    setRelayContext(null);
    await handle.close();
    await closePool();
    fs.rmSync(receivedDir, { recursive: true, force: true });
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('sends a multi-chunk file from machine A to a member hosted on machine B, verifies the write, and A receives the correlated result', async () => {
    const hubUrl = `http://127.0.0.1:${port}`;

    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);

    const { token: tokenA } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    const { token: tokenB } = sign({ sub: 'mach-b', ws: 'ws-a', role: 'spoke' }, SECRET);

    let writtenPath: string | null = null;
    let writtenData: Buffer | null = null;

    const depsB: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-b',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-b', workspaceId: 'ws-a', jwt: tokenB }),
      getAgentForMember: () => null,
      getMemberSnapshot: () => [{ memberId: 'target-member', status: 'online' }],
      onLog: () => {},
      // Test-scoped, not the real sandboxedWriteFile default -- proves the
      // receiver's wiring calls writeFile with the right (path, data),
      // without polluting the real user's FLEET_DIR.
      writeFile: async (destPath, data) => {
        writtenPath = destPath;
        writtenData = data;
        const abs = path.join(receivedDir, path.basename(destPath));
        fs.writeFileSync(abs, data);
      },
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
      writeFile: async () => {},
    };
    // Started LAST: relay-context.ts is a process-wide singleton (see
    // spoke-e2e.test.ts) -- A must own it since A is the sender awaiting
    // the correlated result.
    const spokeA = runSpoke('origin-member', depsA);
    expect(spokeA).not.toBeNull();

    try {
      await new Promise((r) => setTimeout(r, 200));

      // A file spanning multiple chunks (small chunk size forces >1
      // chunk), proving reassembly, not just a single-envelope pass-through.
      const fileContent = Buffer.from(crypto.randomBytes(5000).toString('hex'));
      const ctx = getRelayContext()!;
      const fileTransferDeps = { ...ctx.deps, generateEnvelopeId: () => crypto.randomUUID() };
      const result = await sendFileOverRelay(
        fileTransferDeps,
        ctx.registry,
        fileContent,
        'target-member',
        'subdir/received.bin',
        8000,
        1000, // maxChunkBytes -- forces multiple chunks for a 10KB (hex-encoded) payload
      ) as { status: string; bytes?: number };

      expect(result.status).toBe('ok');
      expect(result.bytes).toBe(fileContent.length);

      expect(writtenPath).toBe('subdir/received.bin');
      expect(writtenData).not.toBeNull();
      expect((writtenData as unknown as Buffer).equals(fileContent)).toBe(true);

      const onDisk = fs.readFileSync(path.join(receivedDir, 'received.bin'));
      expect(onDisk.equals(fileContent)).toBe(true);
    } finally {
      spokeA?.stop();
      spokeB?.stop();
    }
  }, 20000);

  it('reports a corrupt result (does not write) when a chunk is tampered with in transit', async () => {
    const hubUrl = `http://127.0.0.1:${port}`;
    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);
    const { token: tokenA } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    const { token: tokenB } = sign({ sub: 'mach-b', ws: 'ws-a', role: 'spoke' }, SECRET);

    let writeCalled = false;
    const depsB: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-b',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-b', workspaceId: 'ws-a', jwt: tokenB }),
      getAgentForMember: () => null,
      getMemberSnapshot: () => [{ memberId: 'target-member', status: 'online' }],
      onLog: () => {},
      writeFile: async () => { writeCalled = true; },
    };
    const spokeB = runSpoke('target-member', depsB);

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
      writeFile: async () => {},
    };
    const spokeA = runSpoke('origin-member', depsA);

    try {
      await new Promise((r) => setTimeout(r, 200));

      const ctx = getRelayContext()!;
      // Wrap submitEnvelope so the SECOND chunk's data is corrupted after
      // chunking (simulating on-the-wire tampering) -- the receiver must
      // catch this via the sha256 check, not silently accept it.
      let chunkCount = 0;
      const tamperingDeps = {
        ...ctx.deps,
        generateEnvelopeId: () => crypto.randomUUID(),
        submitEnvelope: async (envelope: any) => {
          if (envelope.kind === 'file_transfer.chunk') {
            chunkCount++;
            if (chunkCount === 2) {
              envelope.payload.data_base64 = Buffer.from('tampered').toString('base64');
            }
          }
          return ctx.deps.submitEnvelope(envelope);
        },
      };

      const fileContent = Buffer.from(crypto.randomBytes(3000).toString('hex'));
      const result = await sendFileOverRelay(tamperingDeps, ctx.registry, fileContent, 'target-member', 'x.bin', 8000, 1000) as { status: string };

      expect(result.status).toBe('corrupt');
      expect(writeCalled).toBe(false);
    } finally {
      spokeA?.stop();
      spokeB?.stop();
    }
  }, 20000);
});

describe('RelayStrategy.transferFiles (apra-fleet-8yn): real end-to-end through AgentStrategy, not sendFileOverRelay directly', () => {
  let pool: any;
  let handle: HttpServerHandle;
  let port: number;
  let receivedDir: string;
  let localSrcDir: string;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);
    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
    receivedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-transfer-e2e-received-'));
    localSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-transfer-e2e-src-'));
  });

  afterEach(async () => {
    setRelayContext(null);
    await handle.close();
    await closePool();
    fs.rmSync(receivedDir, { recursive: true, force: true });
    fs.rmSync(localSrcDir, { recursive: true, force: true });
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('sends real local files through getStrategy()/RelayStrategy to a member on a different spoke, and reports success per file', async () => {
    const hubUrl = `http://127.0.0.1:${port}`;
    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);
    const { token: tokenA } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    const { token: tokenB } = sign({ sub: 'mach-b', ws: 'ws-a', role: 'spoke' }, SECRET);

    const depsB: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-b',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-b', workspaceId: 'ws-a', jwt: tokenB }),
      getAgentForMember: () => null,
      getMemberSnapshot: () => [{ memberId: 'target-member', status: 'online' }],
      onLog: () => {},
      writeFile: async (destPath, data) => {
        const abs = path.join(receivedDir, path.basename(destPath));
        fs.writeFileSync(abs, data);
      },
    };
    const spokeB = runSpoke('target-member', depsB);

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
      writeFile: async () => {},
    };
    // Started LAST: relay-context.ts is a process-wide singleton (see
    // spoke-e2e.test.ts) -- A must own it since A is the one sending.
    const spokeA = runSpoke('origin-member', depsA);

    try {
      await new Promise((r) => setTimeout(r, 200));

      const file1 = path.join(localSrcDir, 'report.txt');
      const file2 = path.join(localSrcDir, 'notes.md');
      fs.writeFileSync(file1, 'quarterly report contents');
      fs.writeFileSync(file2, 'meeting notes');

      const relayAgent: Agent = {
        id: 'relay-agent', friendlyName: 'via-relay', agentType: 'relay', relayMemberId: 'target-member',
        workFolder: '/tmp', createdAt: new Date().toISOString(),
      };
      const strategy = new RelayStrategy(relayAgent);
      const result = await strategy.transferFiles([file1, file2]);

      expect(result.success.sort()).toEqual(['notes.md', 'report.txt']);
      expect(result.failed).toEqual([]);
      expect(fs.readFileSync(path.join(receivedDir, 'report.txt'), 'utf-8')).toBe('quarterly report contents');
      expect(fs.readFileSync(path.join(receivedDir, 'notes.md'), 'utf-8')).toBe('meeting notes');
    } finally {
      spokeA?.stop();
      spokeB?.stop();
    }
  }, 20000);

  it('reports a per-file failure without throwing when one local file does not exist', async () => {
    const hubUrl = `http://127.0.0.1:${port}`;
    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);
    const { token: tokenA } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    const { token: tokenB } = sign({ sub: 'mach-b', ws: 'ws-a', role: 'spoke' }, SECRET);

    const depsB: SpokeDeps = {
      fetch: (...a) => globalThis.fetch(...a),
      hostname: () => 'machine-b',
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      random: () => 0,
      readCredentials: () => ({ hubUrl, machineId: 'mach-b', workspaceId: 'ws-a', jwt: tokenB }),
      getAgentForMember: () => null,
      getMemberSnapshot: () => [{ memberId: 'target-member', status: 'online' }],
      onLog: () => {},
      writeFile: async (destPath, data) => {
        fs.writeFileSync(path.join(receivedDir, path.basename(destPath)), data);
      },
    };
    const spokeB = runSpoke('target-member', depsB);

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
      writeFile: async () => {},
    };
    const spokeA = runSpoke('origin-member', depsA);

    try {
      await new Promise((r) => setTimeout(r, 200));

      const goodFile = path.join(localSrcDir, 'exists.txt');
      fs.writeFileSync(goodFile, 'real content');
      const missingFile = path.join(localSrcDir, 'does-not-exist.txt');

      const relayAgent: Agent = {
        id: 'relay-agent', friendlyName: 'via-relay', agentType: 'relay', relayMemberId: 'target-member',
        workFolder: '/tmp', createdAt: new Date().toISOString(),
      };
      const strategy = new RelayStrategy(relayAgent);
      const result = await strategy.transferFiles([goodFile, missingFile]);

      expect(result.success).toEqual(['exists.txt']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].path).toBe('does-not-exist.txt');
    } finally {
      spokeA?.stop();
      spokeB?.stop();
    }
  }, 20000);
});
