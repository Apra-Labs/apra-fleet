import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startKbServer, parseKbServerArgs } from '../../src/commands/kb-server.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';

let tmp: string;
let tokenFile: string;
let server: http.Server;
let port: number;
const stderrChunks: string[] = [];
let origWrite: typeof process.stderr.write;

function status(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/kb/query?query=zz', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(pred: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor timed out');
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-token-file-'));
  tokenFile = path.join(tmp, 'token.txt');
  fs.writeFileSync(tokenFile, 'tok-AAAA\n');
  origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    stderrChunks.push(String(chunk));
    return (origWrite as any)(chunk, ...rest);
  }) as any;
  server = await startKbServer(0, false, path.join(tmp, 'kb.sqlite'), tokenFile);
  port = (server.address() as any).port;
});

afterAll(async () => {
  process.stderr.write = origWrite;
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('kb-server --token-file', () => {
  it('accepts the file token and rejects others', async () => {
    expect(await status('tok-AAAA')).toBe(200);
    expect(await status('tok-BBBB')).toBe(401);
  });

  it('picks up an in-place rewrite without restart', async () => {
    const same = server;
    fs.writeFileSync(tokenFile, 'tok-BBBB');
    await waitFor(async () => (await status('tok-BBBB')) === 200);
    expect(await status('tok-AAAA')).toBe(401);
    expect(server).toBe(same);
  });

  it('picks up a write-temp + rename replacement', async () => {
    const tmpFile = path.join(tmp, 'token.new');
    fs.writeFileSync(tmpFile, 'tok-CCCC\n');
    fs.renameSync(tmpFile, tokenFile);
    await waitFor(async () => (await status('tok-CCCC')) === 200);
    expect(await status('tok-BBBB')).toBe(401);
  });

  it('keeps the last good token when the file is emptied and warns without leaking tokens', async () => {
    fs.writeFileSync(tokenFile, '');
    await waitFor(async () => stderrChunks.some((c) => c.includes('warning') && c.includes(tokenFile)));
    expect(await status('tok-CCCC')).toBe(200);
    const all = stderrChunks.join('');
    expect(all).not.toMatch(/tok-[A-C]{4}/);
  });

  it('parses --token-file and fails to start naming a missing file', async () => {
    expect(parseKbServerArgs(['--token-file', '/x/t']).tokenFile).toBe('/x/t');
    const missing = path.join(tmp, 'nope.txt');
    await expect(startKbServer(0, false, path.join(tmp, 'k2.sqlite'), missing)).rejects.toThrow(missing);
    await expect(startKbServer(0, true, undefined, tokenFile)).rejects.toThrow(/--generate-token/);
  });

  it('stops the watcher when the server closes', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const handles = (process as any)._getActiveHandles().filter((h: any) => h.constructor?.name === 'Timeout' && h._repeat);
    // The poll interval (250ms repeat) must be gone; none of ours remains.
    expect(handles.some((h: any) => h._repeat === 250)).toBe(false);
    // Closing the server releases the --db database: Windows refuses to
    // unlink a file that still has an open sqlite handle.
    expect(() => fs.rmSync(path.join(tmp, 'kb.sqlite'))).not.toThrow();
  });
});
