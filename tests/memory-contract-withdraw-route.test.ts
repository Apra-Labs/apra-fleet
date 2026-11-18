// memory-contract/v1 conformance for the KB server withdraw route (spec section
// 2.9.1): re-runs the recorded scenario list (memory-contract/v1/tests/
// withdraw-route-scenarios.mjs) against a FRESH sample kb-server
// (src/commands/kb-server.ts) and requires every committed fixture under
// memory-contract/v1/route-fixtures/withdraw to match what the server answers
// now, byte for byte after id placeholders. No stale or missing fixture file is
// allowed. Re-record with `npm run build && node
// memory-contract/v1/tests/record-route-fixtures.mjs`.
//
// The fixtures cover: capabilities listing withdraw, the one re-promotion rule
// (an older tombstone keeps the entry, a newer one lowers it), idempotency (a
// repeat is not_confirmed), never raising confidence, not_found, evidence being
// optional and unresolved-but-repo-relative evidence accepted, and absolute /
// '..' evidence refused with 422 E-DEMOTE-EVIDENCE-UNRESOLVED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startKbServer } from '../src/commands/kb-server.js';
import { runWithdrawRouteScenarios, routeFixtureFile } from '../memory-contract/v1/tests/withdraw-route-scenarios.mjs';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'memory-contract', 'v1', 'route-fixtures', 'withdraw');
const TOKEN_FILE = path.join(ROOT, 'tests', 'knowledge', 'fixtures', 'kb-http-test-token.txt');

let scratch: string;
let cases: Array<{ route: string; case: string; kind: string; request: unknown; response: { status: number; body: any } }>;

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-withdraw-route-'));
  cases = await runWithdrawRouteScenarios({ startKbServer, tokenFile: TOKEN_FILE, scratchDir: scratch });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('withdraw route fixtures match the sample kb-server', () => {
  it('the committed fixture set is exactly the scenario list', () => {
    expect(fs.readdirSync(FIXTURE_DIR).sort()).toEqual(cases.map(routeFixtureFile).sort());
  });

  it('every committed fixture is what the server answers now', () => {
    for (const c of cases) {
      const committed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, routeFixtureFile(c)), 'utf-8'));
      expect(c, routeFixtureFile(c)).toEqual(committed);
    }
  });

  it('the recorded outcomes cover the contract rules', () => {
    const by = (name: string) => cases.find(c => c.case === name)!.response;
    expect(by('lists-withdraw').body.routes).toContain('withdraw');
    expect(by('repromoted').body.results[0].outcome).toBe('repromoted');
    expect(by('withdrawn').body.results[0].outcome).toBe('withdrawn');
    expect(by('idempotent-repeat').body.results[0].outcome).toBe('not_confirmed');
    expect(by('never-raises-and-not-found').body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['not_confirmed', 'not_found']);
    expect(by('evidence-not-required').body.results[0].outcome).toBe('withdrawn');
    expect(by('evidence-unresolved-accepted').body.results[0].outcome).toBe('withdrawn');
    for (const name of ['refusal-evidence-absolute', 'refusal-evidence-traversing']) {
      expect(by(name).status).toBe(422);
      expect(by(name).body.code).toBe('E-DEMOTE-EVIDENCE-UNRESOLVED');
    }
    expect(by('refusal-bad-request')).toMatchObject({ status: 400, body: { code: 'BAD_REQUEST' } });
  });
});
