import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { checkRunningInstance, claimStartupLock } from '../src/services/singleton.js';

// Use a per-run temp directory so tests are isolated and don't touch the real FLEET_DIR
const TEST_DIR = path.join(os.tmpdir(), `apra-fleet-singleton-test-${process.pid}`);
const SERVER_INFO = path.join(TEST_DIR, 'server.json');
const LOCK_FILE = path.join(TEST_DIR, 'server.lock');

const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.APRA_FLEET_DATA_DIR = TEST_DIR;
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.APRA_FLEET_DATA_DIR;
  } else {
    process.env.APRA_FLEET_DATA_DIR = originalDataDir;
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// (a) stale server.json (dead PID) is cleaned up and startup proceeds
// ---------------------------------------------------------------------------
describe('(a) stale server.json is cleaned up', () => {
  it('returns running=false and deletes server.json when PID is dead', async () => {
    // Write server.json with a PID that will never be alive (max safe int32)
    fs.writeFileSync(SERVER_INFO, JSON.stringify({
      pid: 2147483647,
      url: 'http://127.0.0.1:7523/mcp',
      version: 'v0.0.1',
      port: 7523,
      startedAt: new Date().toISOString(),
    }));
    expect(fs.existsSync(SERVER_INFO)).toBe(true);

    const result = await checkRunningInstance();

    expect(result.running).toBe(false);
    expect(fs.existsSync(SERVER_INFO)).toBe(false);
  });

  it('returns running=false when server.json does not exist', async () => {
    const result = await checkRunningInstance();
    expect(result.running).toBe(false);
  });

  it('returns running=false when server.json is malformed', async () => {
    fs.writeFileSync(SERVER_INFO, 'not json');
    const result = await checkRunningInstance();
    expect(result.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) health endpoint returns correct JSON
// ---------------------------------------------------------------------------
describe('(b) health endpoint check', () => {
  it('returns running=true when PID is alive and health endpoint responds 200', async () => {
    // Start a minimal HTTP server to act as the /health endpoint
    const mockServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address() as { port: number };

    try {
      fs.writeFileSync(SERVER_INFO, JSON.stringify({
        pid: process.pid, // current process is definitely alive
        url: `http://127.0.0.1:${addr.port}/mcp`,
        version: 'v0.0.1',
        port: addr.port,
        startedAt: new Date().toISOString(),
      }));

      const result = await checkRunningInstance();

      expect(result.running).toBe(true);
      if (result.running) {
        expect(result.pid).toBe(process.pid);
        expect(result.url).toContain('/mcp');
      }
    } finally {
      await new Promise<void>(resolve => mockServer.close(() => resolve()));
    }
  });

  it('returns running=false when PID is alive but health endpoint is down', async () => {
    // Port 1 will always fail to connect
    fs.writeFileSync(SERVER_INFO, JSON.stringify({
      pid: process.pid,
      url: 'http://127.0.0.1:1/mcp',
      version: 'v0.0.1',
      port: 1,
      startedAt: new Date().toISOString(),
    }));

    const result = await checkRunningInstance();

    expect(result.running).toBe(false);
    expect(fs.existsSync(SERVER_INFO)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) lock file prevents concurrent startup -- second acquire gets acquired=false
// ---------------------------------------------------------------------------
describe('(c) startup lock prevents concurrent startup', () => {
  it('first claim acquires, second claim returns acquired=false', () => {
    const lock1 = claimStartupLock();
    expect(lock1.acquired).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(true);

    const lock2 = claimStartupLock();
    expect(lock2.acquired).toBe(false);

    lock1.release();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('release() deletes the lock file', () => {
    const lock = claimStartupLock();
    expect(lock.acquired).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(true);

    lock.release();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('after release, next claim acquires successfully', () => {
    const lock1 = claimStartupLock();
    lock1.release();

    const lock2 = claimStartupLock();
    expect(lock2.acquired).toBe(true);
    lock2.release();
  });
});

// ---------------------------------------------------------------------------
// (d) stale lock file (>60s old) is cleaned up and lock is acquired
// ---------------------------------------------------------------------------
describe('(d) stale lock file is cleaned up', () => {
  it('acquires lock when existing lock file is older than 60 seconds', () => {
    // Create a lock file and backdate its mtime by 70 seconds
    fs.writeFileSync(LOCK_FILE, '99999');
    const staleMtime = new Date(Date.now() - 70_000);
    fs.utimesSync(LOCK_FILE, staleMtime, staleMtime);

    expect(fs.existsSync(LOCK_FILE)).toBe(true);

    const lock = claimStartupLock();
    expect(lock.acquired).toBe(true);
    lock.release();
  });

  it('does not acquire when existing lock file is fresh (< 60 seconds)', () => {
    // Create a fresh lock file
    fs.writeFileSync(LOCK_FILE, '99999');

    const lock = claimStartupLock();
    expect(lock.acquired).toBe(false);

    // Clean up manually since we didn't acquire
    fs.unlinkSync(LOCK_FILE);
  });
});
