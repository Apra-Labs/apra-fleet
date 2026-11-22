// The KB server withdraw route (spec section 2.9.1), exercised against fleet's
// sample kb-server (src/commands/kb-server.ts, startKbServer). One scenario
// list feeds both the recorder (record-route-fixtures.mjs, which writes
// route-fixtures/withdraw/*.json) and the replay test
// (tests/memory-contract-withdraw-route.test.ts, which runs the same list
// against a fresh server and requires the committed fixtures to match), so a
// committed fixture is always what the sample server really answers.
//
// Entry ids are minted by the server, so they are recorded as placeholders
// ({{ENTRY_...}}); every other request and response byte is literal. The
// tombstone times are fixed: one long before any promotion (the re-promotion
// rule keeps the entry) and one in the future (clamped to now, so it
// postdates the promotion and lowers the entry).
//
// Node builtins plus the caller-supplied startKbServer (dist/ for the
// recorder, src/ for the test), like the rest of this directory.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WITHDRAW_ROUTE_REMOTE = 'https://example.test/memory-contract-withdraw-route.git';
export const LONG_AGO = '2000-01-01T00:00:00.000Z';
export const FUTURE = '2999-01-01T00:00:00.000Z';
const NOTE = 'the cited guard was removed when the reader was rewritten';
const PROMOTE_REASON = 'Checked against src/widget.ts: the widget is exported as described.';

async function startFrom(folder, startKbServer, dbPath, tokenFile) {
  const cwd = process.cwd();
  process.chdir(folder);
  let server;
  try {
    server = await startKbServer(0, false, dbPath, tokenFile);
  } finally {
    process.chdir(cwd);
  }
  return server;
}

/**
 * Run every withdraw-route scenario against a fresh sample kb-server and
 * return the cases, ids replaced by placeholders.
 *
 * @param {object} deps
 * @param {Function} deps.startKbServer
 * @param {string} deps.tokenFile   file holding the bearer token the server accepts
 * @param {string} deps.scratchDir  an empty folder this function may write
 * @returns {Promise<Array<{route: string, case: string, kind: string, request: object, response: object}>>}
 */
export async function runWithdrawRouteScenarios({ startKbServer, tokenFile, scratchDir }) {
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();
  const repo = path.join(scratchDir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['remote', 'add', 'origin', WITHDRAW_ROUTE_REMOTE], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = await startFrom(repo, startKbServer, path.join(scratchDir, 'kb.sqlite'), tokenFile);
  const url = `http://127.0.0.1:${server.address().port}`;

  const placeholders = new Map();
  const normalize = (value) => {
    let text = JSON.stringify(value);
    for (const [id, name] of placeholders) text = text.split(id).join(name);
    return JSON.parse(text);
  };

  let project = null;
  async function send(method, route, body) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (project !== null) headers['X-KB-Project'] = project;
    const res = await fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  // The server names its own project in a 409 to a request for none.
  const probe = await send('GET', '/api/kb/capabilities');
  if (probe.status !== 409 || typeof probe.body.server_project !== 'string') {
    throw new Error(`withdraw route scenarios: expected a 409 naming the server project, got HTTP ${probe.status}`);
  }
  project = probe.body.server_project;

  async function entry(name, confirmed) {
    const captured = await send('POST', '/api/kb/capture', {
      type: 'knowledge', title: `Withdraw route fixture: ${name}`,
      summary: `src/widget.ts exports widget; synthetic entry for the withdraw route fixture ${name}.`,
      content: 'widget in src/widget.ts is exported as the constant 1.', source_files: ['src/widget.ts'],
      symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
      author: 'test', source: 'doer', confidence: 'INFERRED',
    });
    if (captured.status !== 201) throw new Error(`withdraw route scenarios: capture answered HTTP ${captured.status}`);
    const id = captured.body.id;
    placeholders.set(id, `{{ENTRY_${name.toUpperCase().replace(/-/g, '_')}}}`);
    if (confirmed) {
      const promoted = await send('POST', '/api/kb/promote', { id, reason: PROMOTE_REASON });
      if (promoted.status !== 200 || promoted.body.new_confidence !== 'CONFIRMED') {
        throw new Error(`withdraw route scenarios: promote answered HTTP ${promoted.status}`);
      }
    }
    return id;
  }

  const cases = [];
  async function record(route, caseName, kind, method, pathname, body) {
    const response = await send(method, pathname, body);
    cases.push(normalize({ route, case: caseName, kind, request: { method, path: pathname, ...(body === undefined ? {} : { body }) }, response }));
  }
  const withdraw = (caseName, kind, withdrawals) =>
    record('withdraw', caseName, kind, 'POST', '/api/kb/withdraw', { withdrawals });

  try {
    await record('capabilities', 'lists-withdraw', 'happy', 'GET', '/api/kb/capabilities');

    const rule = await entry('rule', true);
    // The re-promotion rule: a tombstone older than the promotion keeps the entry.
    await withdraw('repromoted', 'happy', [{ id: rule, at: LONG_AGO, reason: 'withdrawn', note: NOTE }]);
    await withdraw('withdrawn', 'happy', [{ id: rule, at: FUTURE, reason: 'withdrawn', note: NOTE, evidence_files: ['src/widget.ts'] }]);
    // Idempotent: the same tombstone again is not_confirmed, which counts as done.
    await withdraw('idempotent-repeat', 'happy', [{ id: rule, at: FUTURE, reason: 'withdrawn', note: NOTE, evidence_files: ['src/widget.ts'] }]);

    const inferred = await entry('inferred', false);
    await withdraw('never-raises-and-not-found', 'happy', [
      { id: inferred, at: LONG_AGO, reason: 'withdrawn' },
      { id: 'no-such-entry', at: FUTURE, reason: 'withdrawn' },
    ]);

    const bare = await entry('no-evidence', true);
    await withdraw('evidence-not-required', 'happy', [{ id: bare, at: FUTURE, reason: 'demoted' }]);

    const gone = await entry('gone-evidence', true);
    await withdraw('refusal-evidence-absolute', 'refusal', [{ id: gone, at: FUTURE, reason: 'withdrawn', evidence_files: ['/etc/passwd'] }]);
    await withdraw('refusal-evidence-traversing', 'refusal', [{ id: gone, at: FUTURE, reason: 'withdrawn', evidence_files: ['src/../../outside.ts'] }]);
    // Repo-relative evidence is not resolved: a withdrawal is often recorded because a cited file went away.
    await withdraw('evidence-unresolved-accepted', 'happy', [{ id: gone, at: FUTURE, reason: 'withdrawn', evidence_files: ['src/deleted-since.ts'] }]);

    await withdraw('refusal-bad-request', 'refusal', [{ id: 'x', at: 'not a time', reason: 'withdrawn' }]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return cases;
}

/** The committed fixture file name for a case. */
export function routeFixtureFile(c) {
  return `${c.route}--${c.case}.json`;
}
