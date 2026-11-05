import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterStdinJs, writeNodeHelper, type HelperLaunch } from './token-command-helpers.js';

// Shared by the HTTP KB live secret suites: a real node helper script
// that counts its runs, and a real local KB HTTP server that records which
// token each request carried. No mocks.
//
// Every token the helper mints is JWT-shaped: header.payload.<prefix>-<n>,
// where n is the helper run that minted it and the payload carries exp. The
// signature segment is the plain canary prefix, so a substring check for the
// prefix catches a leaked token.

export interface HelperControl {
  /** ok: print a token; fail: exit 3 without printing one. */
  mode: 'ok' | 'fail';
  /** Lifetime of a minted token (expires_at = now + lifetimeMs). */
  lifetimeMs: number;
  /** Wait this long before answering, so concurrent callers overlap the run. */
  delayMs: number;
}

export interface HelperRun {
  credential: string;
}

export interface CountingHelper {
  launch: HelperLaunch;
  setControl(patch: Partial<HelperControl>): void;
  /** One entry per helper run, in order: the FLEET_CREDENTIAL it saw. */
  runs(): HelperRun[];
  /** expires_at (ms) of the token minted by run n. */
  expiresAtOf(n: number): number;
}

const DEFAULT_CONTROL: HelperControl = { mode: 'ok', lifetimeMs: 3_600_000, delayMs: 0 };

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
}

/**
 * Write the counting helper into `dir`. Each run appends one line to a
 * counter file, writes `tokenPrefix` to its stderr (which fleet must discard),
 * then follows the control file.
 */
export function writeCountingHelper(dir: string, tokenPrefix: string): CountingHelper {
  const controlPath = path.join(dir, 'helper-control.json');
  const counterPath = path.join(dir, 'helper-runs.log');
  const issuedPath = path.join(dir, 'helper-issued.log');
  fs.writeFileSync(controlPath, JSON.stringify(DEFAULT_CONTROL));
  const js = afterStdinJs(`
    const argv = process.argv.slice(2);
    const ctl = JSON.parse(fs.readFileSync(argv[0], "utf8"));
    fs.appendFileSync(argv[1], JSON.stringify({ credential: process.env.FLEET_CREDENTIAL }) + "\\n");
    const n = fs.readFileSync(argv[1], "utf8").split("\\n").filter(Boolean).length;
    process.stderr.write(${JSON.stringify(tokenPrefix)} + "-stderr-" + n + "\\n");
    setTimeout(function () {
      if (ctl.mode === "fail") process.exit(3);
      const expiresAtMs = Date.now() + ctl.lifetimeMs;
      const b64 = function (o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); };
      const token = b64({ alg: "none", typ: "JWT" }) + "." + b64({ exp: Math.floor(expiresAtMs / 1000), n: n }) +
        "." + ${JSON.stringify(tokenPrefix)} + "-" + n;
      fs.appendFileSync(argv[2], JSON.stringify({ n: n, expiresAtMs: expiresAtMs }) + "\\n");
      process.stdout.write(JSON.stringify({ token: token, expires_at: new Date(expiresAtMs).toISOString() }));
    }, ctl.delayMs);
  `);
  const launch = writeNodeHelper(dir, 'kb-token-helper', js, [controlPath, counterPath, issuedPath]);
  let control = { ...DEFAULT_CONTROL };
  return {
    launch,
    setControl(patch) {
      control = { ...control, ...patch };
      fs.writeFileSync(controlPath, JSON.stringify(control));
    },
    runs: () => readLines(counterPath).map(l => JSON.parse(l) as HelperRun),
    expiresAtOf(n) {
      const line = readLines(issuedPath).map(l => JSON.parse(l) as { n: number; expiresAtMs: number }).find(i => i.n === n);
      if (!line) throw new Error(`helper run ${n} minted no token`);
      return line.expiresAtMs;
    },
  };
}

/** The helper run that minted `token` (its trailing -<n>), or NaN for any other bearer value. */
export function helperRunOf(token: string, tokenPrefix: string): number {
  const sig = token.split('.')[2] ?? '';
  return sig.startsWith(`${tokenPrefix}-`) ? Number(sig.slice(tokenPrefix.length + 1)) : NaN;
}

export interface SeenRequest {
  path: string;
  /** The bearer value as sent. */
  token: string;
  atMs: number;
  authorized: boolean;
}

export interface StubKbServer {
  url: string;
  requests: SeenRequest[];
  /** Which bearer values the server accepts; everything else gets 401. */
  accept: (token: string) => boolean;
  close(): Promise<void>;
}

/** A local KB HTTP server answering capture/query/context/invalidate/prime, 401 for a token `accept` refuses. */
export function startStubKbServer(): Promise<StubKbServer> {
  const stub = { requests: [] as SeenRequest[], accept: (_token: string) => true } as StubKbServer;
  let captures = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const pathname = (req.url ?? '').split('?')[0];
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const authorized = stub.accept(token);
      stub.requests.push({ path: pathname, token, atMs: Date.now(), authorized });
      res.setHeader('Content-Type', 'application/json');
      if (!authorized) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const bodies: Record<string, unknown> = {
        '/api/kb/capture': { id: `srv-${++captures}`, audn_decision: 'add' },
        '/api/kb/query': { results: [], total: 0, l1_only: false },
        '/api/kb/context': { results: [] },
        '/api/kb/invalidate': { invalidated: 0 },
      };
      const body = bodies[pathname];
      res.writeHead(body ? 200 : 404);
      res.end(JSON.stringify(body ?? { error: 'Not found' }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stub.close = () => new Promise<void>(done => server.close(() => done()));
    resolve(stub);
  }));
}
