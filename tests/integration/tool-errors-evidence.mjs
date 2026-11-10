#!/usr/bin/env node
// Live evidence for execute_prompt's toolErrors (not part of npm test).
//
// Dispatches a short prompt to a REAL member through the running fleet
// server. The agent is told to call kb_query with the removed `repo_path`
// key, which every fleet server refuses before the handler with the typed
// error E-SCOPE-KEY-REMOVED -- no KB, network or credential needed. The
// script then prints structuredContent.toolErrors and checks that it holds
// that entry.
//
// It prints which read path toolErrors took -- in-process (local member) or
// SSH (remote member), with the member's OS -- and refuses a local member
// unless --allow-local is passed: a local PASS proves only the in-process
// path, never the SSH round trip.
//
// Usage:
//   node tests/integration/tool-errors-evidence.mjs --member <name-or-uuid> [--timeout-s 300] [--model cheap] [--allow-local]
//
// Needs: a running fleet server for this install (the same APRA_FLEET_DATA_DIR
// it runs with), the member registered there with a working LLM, and, for a
// remote member, its own apra-fleet install at a build that has query_errors
// (else toolErrors reports available:false, which the script prints and
// fails on).
// Exit: 0 entry found, 1 not found or the dispatch failed, 2 usage error or
// a local member without --allow-local.

import { connectFleet } from '@apralabs/apra-fleet-client/server-resolution';
import { parseToolJson } from '@apralabs/apra-fleet-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = { timeoutS: 300, model: 'cheap', allowLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--member' && v) { out.member = v; i++; }
    else if (a === '--timeout-s' && v) { out.timeoutS = Number(v); i++; }
    else if (a === '--model' && v) { out.model = v; i++; }
    else if (a === '--allow-local') out.allowLocal = true;
    else return { error: `unknown or incomplete argument: ${a}` };
  }
  if (!out.member) return { error: '--member <name-or-uuid> is required' };
  if (!Number.isFinite(out.timeoutS) || out.timeoutS <= 0) return { error: '--timeout-s must be a positive number' };
  return out;
}

const PROMPT = [
  'This is a test of error reporting. Do exactly this and nothing else:',
  'call the apra-fleet MCP tool kb_query once with the arguments',
  '{"query": "tool error evidence", "repo_path": "/no/such/folder"}.',
  'Its schema says repo_path is removed; passing it anyway is the point of this test, so do pass it.',
  'The call is expected to fail. Do not retry it and do not call any other tool.',
  'Then reply with one line: the error code the call returned.',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  const { fleetApi, transport } = await connectFleet();
  try {
    const who = UUID_RE.test(args.member) ? { member_id: args.member } : { member_name: args.member };
    const detail = parseToolJson(await fleetApi.memberDetail({ ...who, format: 'json' }));
    const local = detail.type === 'local';
    const path = {
      member: detail.name, type: detail.type, os: detail.os, shell: detail.shell ?? null,
      read: local ? 'in-process (this fleet server)' : 'ssh (apra-fleet call query_errors on the member)',
      fleetMcp: detail.fleetMcp ? { state: detail.fleetMcp.state, version: detail.fleetMcp.version ?? null } : null,
    };
    console.log(JSON.stringify({ path }, null, 2));
    if (local && !args.allowLocal) {
      console.error('REFUSED: a local member exercises only the in-process read, not SSH; pass --allow-local to run it anyway');
      return 2;
    }
    const started = new Date().toISOString();
    const result = await fleetApi.executePrompt({
      ...who,
      prompt: PROMPT,
      resume: false,
      model: args.model,
      timeout_s: args.timeoutS,
      max_total_s: args.timeoutS,
    });
    const sc = result?.structuredContent ?? {};
    console.log(JSON.stringify({ started, isError: sc.isError ?? false, reason: sc.reason ?? null, response: sc.response ?? null, toolErrors: sc.toolErrors ?? null }, null, 2));
    if (sc.isError) {
      console.error(`FAIL: the dispatch failed (${sc.reason ?? 'unknown reason'})`);
      return 1;
    }
    const te = sc.toolErrors;
    if (!te) {
      console.error('FAIL: the result carries no toolErrors (is the fleet server built with this change?)');
      return 1;
    }
    if (!te.available) {
      console.error(`FAIL: toolErrors unavailable: ${te.detail}`);
      return 1;
    }
    const hit = (te.entries ?? []).find(e => e.tool === 'kb_query' && e.code === 'E-SCOPE-KEY-REMOVED');
    if (!hit) {
      console.error('FAIL: no kb_query E-SCOPE-KEY-REMOVED entry (did the agent make the call? see response above)');
      return 1;
    }
    console.log(`PASS (${path.read}, os ${path.os}): toolErrors holds ${JSON.stringify(hit)}`);
    return 0;
  } finally {
    // close() releases the server-side session, then stops the transport.
    try { await (transport.close ? transport.close() : transport.stop?.()); } catch { /* ignore */ }
  }
}

main().then(code => process.exit(code), err => { console.error(`FAIL: ${err?.stack ?? err}`); process.exit(1); });
