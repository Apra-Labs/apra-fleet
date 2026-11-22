import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { startKbServer } from '../../src/commands/kb-server.js';
import { resetKbProviders, getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import { KB_LOCAL_CAPABILITIES } from '../../src/services/knowledge/kb-local-capabilities.js';

// Every route the local capabilities advertise must have a handler on the
// bundled kb-server. KB_LOCAL_CAPABILITIES.routes is DERIVED from
// KB_REQUIRED_ROUTES + KB_OPTIONAL_ROUTES, so comparing it with the server's
// GET /api/kb/capabilities answer is tautological: a route added to those
// constants without a kb-server handler would be advertised and then answered
// with the catch-all 404 NOT_FOUND. This file asks the server itself.
//
// Each route is probed with an empty request on GET and on POST (the methods
// HttpKbProvider uses; trying both means no per-route method table to keep in
// step). A route is served when at least one method answers anything but the
// catch-all 404 {code: NOT_FOUND} -- a 400 for the empty body, or a 404
// ENTRY_NOT_FOUND from a handler, both count.
//
// FALSIFICATION: adding a name (e.g. 'bogus') to KB_OPTIONAL_ROUTES in
// src/services/knowledge/http-provider.ts, with no handler, fails the
// "every advertised route" test naming that route. The control case below
// also proves the probe can see a missing route.

const TOKEN = 'kb-server-routes-test-token';

let scratch: string;
let folder: string;
let server: http.Server | undefined;
let port = 0;

function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-KB-Project': getProjectSlug(folder),
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data).toString();
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isCatchAllNotFound(r: { status: number; body: any }): boolean {
  return r.status === 404 && r.body?.code === 'NOT_FOUND';
}

/** True when GET or POST /api/kb/<route> reaches a handler. */
async function served(route: string): Promise<{ served: boolean; answers: string }> {
  const get = await call('GET', '/api/kb/' + route);
  const post = await call('POST', '/api/kb/' + route, {});
  return {
    served: !isCatchAllNotFound(get) || !isCatchAllNotFound(post),
    answers: 'GET ' + get.status + ' ' + JSON.stringify(get.body?.code) + ', POST ' + post.status + ' ' + JSON.stringify(post.body?.code),
  };
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-routes-'));
  const tokenFile = path.join(scratch, 'token');
  fs.writeFileSync(tokenFile, TOKEN);
  folder = path.join(scratch, 'repo');
  fs.mkdirSync(folder, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-server-routes.git'], { cwd: folder });
  const cwd = process.cwd();
  process.chdir(folder);
  try {
    server = await startKbServer(0, false, path.join(scratch, 'kb.db'), tokenFile);
  } finally {
    process.chdir(cwd);
  }
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
  resetKbProviders();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb-server serves every route its capabilities advertise', () => {
  it('the server advertises exactly the local capabilities routes', async () => {
    const res = await call('GET', '/api/kb/capabilities');
    expect(res.status).toBe(200);
    expect([...res.body.routes].sort()).toEqual([...KB_LOCAL_CAPABILITIES.routes].sort());
  });

  it('every advertised route answers something other than the catch-all 404', async () => {
    const res = await call('GET', '/api/kb/capabilities');
    const routes = res.body.routes as string[];
    expect(routes.length).toBeGreaterThan(0);
    const unserved: string[] = [];
    for (const route of routes) {
      const r = await served(route);
      if (!r.served) unserved.push(route + ' (' + r.answers + ')');
    }
    expect(unserved, 'advertised routes with no kb-server handler').toEqual([]);
  });

  it('control: a route name with no handler is seen as unserved', async () => {
    expect((await served('no-such-route')).served).toBe(false);
  });
});
