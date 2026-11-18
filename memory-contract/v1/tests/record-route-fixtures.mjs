// Records memory-contract/v1/route-fixtures/withdraw/*.json against fleet's
// sample kb-server (dist/commands/kb-server.js -- run `npm run build` first):
//
//   node memory-contract/v1/tests/record-route-fixtures.mjs
//
// The scenario list lives in withdraw-route-scenarios.mjs, shared with
// tests/memory-contract-withdraw-route.test.ts, which replays it and requires
// these files to match. Stale fixture files are removed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-contract-route-fixtures-')));
process.env.APRA_FLEET_DATA_DIR = path.join(SCRATCH, 'fleet-data');
fs.mkdirSync(process.env.APRA_FLEET_DATA_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1', 'route-fixtures', 'withdraw');
const TOKEN_FILE = path.join(REPO_ROOT, 'tests', 'knowledge', 'fixtures', 'kb-http-test-token.txt');

const { runWithdrawRouteScenarios, routeFixtureFile } = await import(pathToFileURL(path.join(HERE, 'withdraw-route-scenarios.mjs')).href);
const { startKbServer } = await import(pathToFileURL(path.join(REPO_ROOT, 'dist', 'commands', 'kb-server.js')).href);

try {
  const cases = await runWithdrawRouteScenarios({ startKbServer, tokenFile: TOKEN_FILE, scratchDir: path.join(SCRATCH, 'world') });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = new Set(cases.map(routeFixtureFile));
  for (const existing of fs.readdirSync(OUT_DIR)) if (!names.has(existing)) fs.rmSync(path.join(OUT_DIR, existing));
  for (const c of cases) fs.writeFileSync(path.join(OUT_DIR, routeFixtureFile(c)), JSON.stringify(c, null, 2) + '\n');
  console.log(`record-route-fixtures: wrote ${cases.length} fixtures to ${OUT_DIR}`);
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}
