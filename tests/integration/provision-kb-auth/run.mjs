#!/usr/bin/env node
// Evidence run for provision_kb_auth against a REAL remote member, by hand.
//
// What it does, printing each step and its result:
//   1. starts a KB test server here (apra-fleet kb-server --token-file), whose
//      token is a random value in a temp file: no real credential is involved;
//   2. registers a live secret on the orchestrator whose fake helper reads that
//      file (apra-fleet secret --live ... -- node fake-helper.mjs <file>);
//   3. backs up the member's KB config on the member (a copy next to it);
//   4. calls provision_kb_auth through the orchestrator's running fleet server
//      and checks it is verified, and that the member's KB config names the
//      secret;
//   5. rotates the KB server token: provision_kb_auth without reason pushes the
//      cached token and must report verification rejected; with reason
//      rejected it must mint a new one and report verified;
//   6. cleans up: deletes the pushed secret on the member, restores its KB
//      config, deletes the live secret here, stops the KB server.
//
// It changes the member's KB config while it runs, and needs the member to run
// a member install of this build. The KB server must be reachable FROM THE
// MEMBER at --kb-url (it listens on all interfaces here, on --port or the
// port in --kb-url). The orchestrator's fleet server must run this build, with
// the same data dir as the apra-fleet CLI used here.
//
// Usage:
//   node tests/integration/provision-kb-auth/run.mjs --member <name> --kb-url http://<this host>:<port> --yes
//     [--port <listen port>] [--secret <name>] [--fleet-bin <apra-fleet path>] [--keep]
//
// Exit code 0 only when every check passed.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');

function parseArgs(argv) {
  const out = { yes: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (argv[i + 1] === undefined) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '--member') out.member = next();
    else if (a === '--kb-url') out.kbUrl = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--secret') out.secret = next();
    else if (a === '--fleet-bin') out.fleetBin = next();
    else if (a === '--yes') out.yes = true;
    else if (a === '--keep') out.keep = true;
    else usage(`unknown argument ${a}`);
  }
  if (!out.member || !out.kbUrl) usage('--member and --kb-url are required');
  return out;
}

function usage(msg) {
  console.error(`error: ${msg}`);
  console.error('usage: run.mjs --member <name> --kb-url http://<host reachable from the member>:<port> --yes [--port N] [--secret NAME] [--fleet-bin PATH] [--keep]');
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const kbUrl = new URL(args.kbUrl);
const port = args.port ?? Number(kbUrl.port || 7878);
const secretName = args.secret ?? `KB_EVIDENCE_${crypto.randomBytes(3).toString('hex')}`;
const fleetBin = args.fleetBin ?? 'apra-fleet';
const isWin = process.platform === 'win32';

let failures = 0;
function step(n, text) { console.log(`\n[${n}] ${text}`); }
function ok(text) { console.log(`  [OK] ${text}`); }
function fail(text) { failures++; console.log(`  [FAIL] ${text}`); }
function info(text) { console.log(`  ${text}`); }
function check(cond, good, bad) { if (cond) ok(good); else fail(bad); return cond; }

// npm installs a .cmd shim on Windows, which needs a shell; arguments with spaces are then quoted.
const viaShell = isWin && !/\.exe$/i.test(fleetBin);
const shellArgs = (list) => (viaShell ? list.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : list);
const fleetCmd = viaShell ? `"${fleetBin}"` : fleetBin;

/** The fleet CLI on this host. */
function fleet(cliArgs, input) {
  const r = spawnSync(fleetCmd, shellArgs(cliArgs), { input, encoding: 'utf-8', shell: viaShell, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

if (!args.yes) {
  console.log(`This changes the KB config of member "${args.member}" while it runs and restores it at the end.`);
  console.log('Re-run with --yes to go ahead.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-auth-evidence-'));
const tokenFile = path.join(tmp, 'kb-server.token');
const helper = path.join(tmp, 'fake-helper.mjs');
const newToken = () => crypto.randomBytes(24).toString('hex');
fs.writeFileSync(tokenFile, newToken(), { mode: 0o600 });
// The fake helper: hands out whatever the KB server accepts now, valid for an hour.
fs.writeFileSync(helper, [
  "import fs from 'node:fs';",
  'const token = fs.readFileSync(process.argv[2], "utf8").trim();',
  'process.stdout.write(JSON.stringify({ token, expires_at: new Date(Date.now() + 3600000).toISOString() }));',
].join('\n'));

let kbServer;
let client;
let memberCtx;

/** structuredContent of a tool result, or a parsed text body. */
function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

async function tool(name, input) {
  const r = await client.mcpClient.callTool(name, input);
  return { isError: !!r?.isError, body: payload(r), text: (r?.content ?? []).map((c) => c.text ?? '').join('\n') };
}

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const pq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** A command on the member through execute_command, built for its shell with absolute, quoted paths. */
async function onMember(posix, powershell) {
  const r = await tool('execute_command', { member_name: args.member, command: memberCtx.posix ? posix : powershell, timeout_s: 60 });
  return { code: r.body.exitCode ?? (r.isError ? 1 : 0), out: `${r.body.stdout ?? ''}${r.body.stderr ?? ''}`.trim() || r.text };
}

async function provision(extra = {}) {
  const r = await tool('provision_kb_auth', { member_name: args.member, secret: secretName, remote: args.kbUrl, ...extra });
  info(`result: ${JSON.stringify(r.body)}`);
  return r;
}

async function main() {
  step(1, `KB test server on port ${port}, token from ${tokenFile}`);
  // Its own data dir: the test server never reads or writes the orchestrator's.
  const serverData = path.join(tmp, 'kb-server-data');
  fs.mkdirSync(serverData);
  kbServer = spawn(fleetCmd, shellArgs(['kb-server', '--port', String(port), '--token-file', tokenFile, '--db', path.join(tmp, 'kb.sqlite')]),
    { stdio: ['ignore', 'ignore', 'pipe'], shell: viaShell, env: { ...process.env, APRA_FLEET_DATA_DIR: serverData } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kb-server did not start in 20 s')), 20_000);
    kbServer.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve(); } });
    kbServer.on('exit', (code) => { clearTimeout(timer); reject(new Error(`kb-server exited ${code}`)); });
  });
  ok(`listening; the member must reach it at ${args.kbUrl}`);

  step(2, 'connect to the orchestrator fleet server');
  const { connectFleet } = await import(pathToFileURL(path.join(repo, 'packages', 'apra-fleet-client', 'src', 'client', 'server-resolution.mjs')).href);
  // http forced: attach to the running server only, never start one or fall back to stdio.
  client = await connectFleet({ env: { ...process.env, APRA_FLEET_TRANSPORT: 'http' } });
  const version = await tool('version', {});
  info(`server: ${version.text.split('\n')[0]}`);
  const tools = await client.mcpClient.listTools();
  const names = (tools?.tools ?? []).map((t) => t.name);
  if (!check(names.includes('provision_kb_auth'), 'the server has provision_kb_auth', 'the server has no provision_kb_auth: run this build')) return;

  step(3, `member "${args.member}"`);
  const detail = await tool('member_detail', { member_name: args.member, format: 'json' });
  const d = detail.body;
  info(`type=${d.type} os=${d.os} shell=${d.shell ?? '(default)'} host=${d.host}`);
  if (!check(d.type === 'remote', 'a remote member', 'this script is for a remote member')) return;
  memberCtx = { posix: d.os !== 'windows' || d.shell === 'gitbash' };
  const homeR = await onMember('printf %s "$HOME"', '[Console]::Out.Write($HOME)');
  const home = homeR.out.trim();
  const join = (...p) => (memberCtx.posix ? p.join('/') : p.join('\\'));
  memberCtx.bin = join(home, '.apra-fleet', 'bin', d.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet');
  memberCtx.config = join(home, '.apra-fleet', 'data', 'knowledge', 'config.json');
  memberCtx.backup = `${memberCtx.config}.evidence-bak`;
  const mv = await onMember(`${sq(memberCtx.bin)} --version`, `& ${pq(memberCtx.bin)} --version`);
  info(`member install: ${mv.out.split('\n')[0]}`);

  step(4, 'back up the member KB config');
  const b = await onMember(
    `if [ -f ${sq(memberCtx.config)} ]; then cp -p ${sq(memberCtx.config)} ${sq(memberCtx.backup)} && echo backed-up; else echo none; fi`,
    `if (Test-Path -LiteralPath ${pq(memberCtx.config)}) { Copy-Item -LiteralPath ${pq(memberCtx.config)} -Destination ${pq(memberCtx.backup)} -Force; 'backed-up' } else { 'none' }`,
  );
  memberCtx.hadConfig = b.out.includes('backed-up');
  check(b.code === 0, memberCtx.hadConfig ? `copied to ${memberCtx.backup}` : 'no KB config on the member yet', `backup failed: ${b.out}`);

  step(5, `live secret ${secretName} on the orchestrator, fake helper ${helper}`);
  // node by bare name: the orchestrator's fleet server resolves it on its own PATH.
  const reg = fleet(['secret', '--live', secretName, '--', 'node', helper, tokenFile]);
  if (!check(reg.code === 0 && /^OK: expires/m.test(reg.out), `registered: ${reg.out}`, `registration failed: ${reg.out}`)) return;

  step(6, 'provision_kb_auth');
  const first = await provision();
  check(!first.isError && first.body.ok === true && first.body.verification?.status === 'verified', 'verified', 'not verified');
  check(!JSON.stringify(first).includes(fs.readFileSync(tokenFile, 'utf8').trim()), 'the result carries no token', 'the token appears in the result');
  const cfg = await onMember(`cat ${sq(memberCtx.config)}`, `Get-Content -Raw -LiteralPath ${pq(memberCtx.config)}`);
  let parsed = {};
  try { parsed = JSON.parse(cfg.out); } catch { /* reported below */ }
  check(parsed.provider === 'http' && parsed.token_ref === `{{secret.${secretName}}}`,
    `member KB config: provider=${parsed.provider} url=${parsed.url} token_ref=${parsed.token_ref}`, `member KB config does not name the secret: ${cfg.out.slice(0, 200)}`);

  step(7, 'rotate the KB server token; the cached token is now refused');
  fs.writeFileSync(tokenFile, newToken());
  await new Promise((r) => setTimeout(r, 1000));
  const stale = await provision();
  check(stale.body.verification?.status === 'failed' && stale.body.verification?.reason === 'rejected',
    'without reason: the cached token was pushed and the member reports rejected', 'expected verification rejected');
  const fresh = await provision({ reason: 'rejected' });
  check(fresh.body.ok === true, 'with reason rejected: a new token was minted, pushed and verified', 'expected verified after reason rejected');
}

async function cleanup() {
  if (args.keep) { info('--keep: nothing cleaned up'); return; }
  step(8, 'clean up');
  if (client && memberCtx?.bin) {
    const del = await onMember(`${sq(memberCtx.bin)} secret --delete ${sq(secretName)}`, `& ${pq(memberCtx.bin)} secret --delete ${pq(secretName)}`);
    info(`member secret delete: exit ${del.code}`);
    const restore = memberCtx.hadConfig
      ? await onMember(`mv -f ${sq(memberCtx.backup)} ${sq(memberCtx.config)}`, `Move-Item -Force -LiteralPath ${pq(memberCtx.backup)} -Destination ${pq(memberCtx.config)}`)
      : await onMember(`rm -f ${sq(memberCtx.config)}`, `Remove-Item -Force -LiteralPath ${pq(memberCtx.config)} -ErrorAction SilentlyContinue`);
    check(restore.code === 0, memberCtx.hadConfig ? 'member KB config restored' : 'member KB config removed (there was none)', `restore failed: ${restore.out}`);
  }
  const del = fleet(['secret', '--delete', secretName]);
  info(`orchestrator live secret delete: ${del.out}`);
  // Through a .cmd shim the child is cmd.exe, so the whole tree is stopped.
  if (kbServer && kbServer.exitCode === null) {
    if (isWin) spawnSync('taskkill', ['/PID', String(kbServer.pid), '/T', '/F'], { windowsHide: true });
    else kbServer.kill();
  }
  try { await client?.transport?.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  await main();
} catch (err) {
  fail(`stopped: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await cleanup();
  console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
