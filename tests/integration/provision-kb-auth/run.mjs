#!/usr/bin/env node
// Evidence run for provision_kb_auth against a REAL remote member, by hand.
//
// What it does, printing each step and its result:
//   1. starts a KB test server here (apra-fleet kb-server --token-file, its own
//      data dir), whose token is a random value in a temp file: no real
//      credential is involved;
//   2. attaches to the orchestrator fleet server named by APRA_FLEET_DATA_DIR
//      (never starts one), and with --register registers the member there;
//   3. records the member's KB config (backed up next to it), its home's staged
//      token files and its work folder's post-commit hook;
//   4. registers a live secret on the orchestrator whose fake helper reads the
//      token file;
//   5. calls provision_kb_auth: verified, no token in the result, and the
//      member's KB config names the secret;
//   6. makes a KB call through the member's OWN fleet server (apra-fleet call
//      --member <id> kb_capture on the member) and finds that entry on the test
//      KB server: the member's server used the pushed token;
//   7. rotates the KB server token: without reason the cached token is pushed
//      and must report rejected; with reason rejected a new one is minted and
//      verified;
//   8. checks no staged token file and no new git hook were left on the member;
//   9. cleans up: the pushed secret and KB config on the member, the live
//      secret, the registration (with --register), the KB server.
//
// Needs: the member running a member install of this build; its work folder a
// git repository with an origin remote (a member session's KB identity); the KB
// port reachable FROM THE MEMBER at --kb-url; `node` on the orchestrator
// server's PATH.
//
// Against the shared orchestrator (it must run this build):
//   node tests/integration/provision-kb-auth/run.mjs --member <name> --kb-url http://<this host>:<port> --yes
//
// Against an isolated orchestrator started from this build, with its own data
// dir and port (nothing shared is touched; recommended):
//   npm run build
//   export APRA_FLEET_DATA_DIR=<new empty dir> APRA_FLEET_PORT=<free port>
//   node dist/index.js run &          # the isolated orchestrator
//   node tests/integration/provision-kb-auth/run.mjs --use-build --register \
//     --member kb-evidence --host <member host> --ssh-user <user> --ssh-key <key path> \
//     --work-folder <member work folder> --kb-url http://<this host>:<port> --yes
//   then stop that server and remove the data dir.
// --register uses fleet_install auto: a member older than this build is
// upgraded by it.
//
// Options: [--port <KB listen port>] [--secret <name>] [--fleet-bin <apra-fleet>]
//          [--use-build] [--ssh-port N] [--keep]. Exit code 0 only when every check passed.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');

function usage(msg) {
  console.error(`error: ${msg}`);
  console.error('usage: run.mjs --member <name> --kb-url http://<host reachable from the member>:<port> --yes [--use-build] [--register --host H --ssh-user U --ssh-key K --work-folder F [--ssh-port N]] [--port N] [--secret NAME] [--fleet-bin PATH] [--keep]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { yes: false, keep: false, register: false, useBuild: false };
  const valued = { '--member': 'member', '--kb-url': 'kbUrl', '--port': 'port', '--secret': 'secret', '--fleet-bin': 'fleetBin',
    '--host': 'host', '--ssh-user': 'sshUser', '--ssh-key': 'sshKey', '--work-folder': 'workFolder', '--ssh-port': 'sshPort' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued[a]) { if (argv[i + 1] === undefined) usage(`${a} needs a value`); out[valued[a]] = argv[++i]; }
    else if (a === '--yes') out.yes = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--register') out.register = true;
    else if (a === '--use-build') out.useBuild = true;
    else usage(`unknown argument ${a}`);
  }
  if (!out.member || !out.kbUrl) usage('--member and --kb-url are required');
  if (out.register && !(out.host && out.sshUser && out.sshKey && out.workFolder)) usage('--register needs --host, --ssh-user, --ssh-key and --work-folder');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const kbUrl = new URL(args.kbUrl);
const port = Number(args.port ?? (kbUrl.port || 7878));
const secretName = args.secret ?? `KB_EVIDENCE_${crypto.randomBytes(3).toString('hex')}`;
const isWin = process.platform === 'win32';

let failures = 0;
function step(n, text) { console.log(`\n[${n}] ${text}`); }
function ok(text) { console.log(`  [OK] ${text}`); }
function fail(text) { failures++; console.log(`  [FAIL] ${text}`); }
function info(text) { console.log(`  ${text}`); }
function check(cond, good, bad) { if (cond) ok(good); else fail(bad); return cond; }

// The fleet CLI here: this build (--use-build), or an installed apra-fleet. An npm
// .cmd shim on Windows needs a shell; arguments with spaces are then quoted.
const fleetBin = args.useBuild ? process.execPath : (args.fleetBin ?? 'apra-fleet');
const fleetPre = args.useBuild ? [path.join(repo, 'dist', 'index.js')] : [];
const viaShell = isWin && !args.useBuild && !/\.exe$/i.test(fleetBin);
const shellArgs = (list) => (viaShell ? list.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : list);
const fleetCmd = viaShell ? `"${fleetBin}"` : fleetBin;

function fleet(cliArgs, input) {
  const r = spawnSync(fleetCmd, shellArgs([...fleetPre, ...cliArgs]), { input, encoding: 'utf-8', shell: viaShell, timeout: 120_000 });
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
let registered = false;
let liveRegistered = false;
const m = {};

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
  const r = await tool('execute_command', { member_name: args.member, command: m.posix ? posix : powershell, timeout_s: 90 });
  // No exit code in the result is not a success.
  return { code: typeof r.body.exitCode === 'number' && !r.isError ? r.body.exitCode : null, out: `${r.body.stdout ?? ''}${r.body.stderr ?? ''}`.trim() || r.text };
}

async function provision(extra = {}) {
  const r = await tool('provision_kb_auth', { member_name: args.member, secret: secretName, remote: args.kbUrl, ...extra });
  info(`result: ${JSON.stringify(r.body)}`);
  return r;
}

/** GET on the test KB server with its current token. */
async function kbGet(pathname) {
  const res = await fetch(new URL(pathname, `http://127.0.0.1:${port}`), { headers: { Authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}` } });
  return res.json();
}

/**
 * Staged token files in the member's home, and the post-commit hook's hash (or
 * none). Any probe that fails (a listing that cannot run, a work folder with no
 * .git, a result without exit code 0, unparseable output) gives ok false, which
 * the caller reports as FAIL: a failed probe never counts as nothing found.
 */
async function memberLeftovers() {
  const staged = await onMember(
    `l=$(ls -a ${sq(m.home)}) || exit 3; printf '%s\\n' "$l" | grep -c '^\\.apra-fleet-kb-token-'; exit 0`,
    `try { @(Get-ChildItem -Force -LiteralPath ${pq(m.home)} -Filter '.apra-fleet-kb-token-*' -ErrorAction Stop).Count } catch { exit 3 }`,
  );
  const hook = await onMember(
    `[ -d ${sq(m.gitDir)} ] || exit 3; if [ -f ${sq(m.hook)} ]; then cksum < ${sq(m.hook)} || exit 3; else echo none; fi`,
    `if (-not (Test-Path -LiteralPath ${pq(m.gitDir)} -PathType Container)) { exit 3 }; try { if (Test-Path -LiteralPath ${pq(m.hook)}) { (Get-FileHash -LiteralPath ${pq(m.hook)} -ErrorAction Stop).Hash } else { 'none' } } catch { exit 3 }`,
  );
  const count = /^\d+$/.test(staged.out.trim()) ? Number(staged.out.trim()) : NaN;
  const ok = staged.code === 0 && Number.isFinite(count) && hook.code === 0 && hook.out.trim() !== '';
  return { ok, staged: count, hook: hook.out.trim(), detail: `listing exit ${staged.code}: ${staged.out.slice(0, 120)}; hook exit ${hook.code}: ${hook.out.slice(0, 120)}` };
}

async function main() {
  step(1, `KB test server on port ${port}, token from ${tokenFile}`);
  const serverData = path.join(tmp, 'kb-server-data');
  fs.mkdirSync(serverData);
  kbServer = spawn(fleetCmd, shellArgs([...fleetPre, 'kb-server', '--port', String(port), '--token-file', tokenFile, '--db', path.join(tmp, 'kb.sqlite')]),
    { stdio: ['ignore', 'ignore', 'pipe'], shell: viaShell, env: { ...process.env, APRA_FLEET_DATA_DIR: serverData } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kb-server did not start in 20 s')), 20_000);
    kbServer.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve(); } });
    kbServer.on('exit', (code) => { clearTimeout(timer); reject(new Error(`kb-server exited ${code}`)); });
  });
  ok(`listening; the member must reach it at ${args.kbUrl}`);

  step(2, `orchestrator fleet server (data dir ${process.env.APRA_FLEET_DATA_DIR ?? 'default'})`);
  const { connectFleet } = await import(pathToFileURL(path.join(repo, 'packages', 'apra-fleet-client', 'src', 'client', 'server-resolution.mjs')).href);
  // http forced: attach to the running server only, never start one or fall back to stdio.
  client = await connectFleet({ env: { ...process.env, APRA_FLEET_TRANSPORT: 'http' } });
  info(`server: ${(await tool('version', {})).text.split('\n')[0]}`);
  const names = ((await client.mcpClient.listTools())?.tools ?? []).map((t) => t.name);
  if (!check(names.includes('provision_kb_auth'), 'the server has provision_kb_auth', 'the server has no provision_kb_auth: run this build')) return;
  if (args.register) {
    const reg = await tool('register_member', {
      friendly_name: args.member, member_type: 'remote', host: args.host, port: Number(args.sshPort ?? 22),
      username: args.sshUser, auth_type: 'key', key_path: args.sshKey, work_folder: args.workFolder, fleet_install: 'auto',
    });
    registered = !reg.isError;
    info(reg.text.split('\n').slice(0, 3).join(' | '));
    if (!check(registered, 'member registered on this orchestrator', 'register_member failed')) return;
  }

  step(3, `member "${args.member}"`);
  const d = (await tool('member_detail', { member_name: args.member, format: 'json' })).body;
  info(`type=${d.type} os=${d.os} shell=${d.shell ?? '(default)'} host=${d.host} folder=${d.folder}`);
  if (!check(d.type === 'remote', 'a remote member', 'this script is for a remote member')) return;
  m.id = d.id;
  m.posix = d.os !== 'windows' || d.shell === 'gitbash';
  m.home = (await onMember('printf %s "$HOME"', '[Console]::Out.Write($HOME)')).out.trim();
  const join = (...p) => (m.posix ? p.join('/') : p.join('\\'));
  m.bin = join(m.home, '.apra-fleet', 'bin', d.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet');
  m.config = join(m.home, '.apra-fleet', 'data', 'knowledge', 'config.json');
  m.backup = `${m.config}.evidence-bak`;
  m.gitDir = join(d.folder, '.git');
  m.hook = join(d.folder, '.git', 'hooks', 'post-commit');
  m.args = join(m.home, '.apra-fleet', `kb-evidence-args-${crypto.randomBytes(3).toString('hex')}.json`);
  info(`member install: ${(await onMember(`${sq(m.bin)} --version`, `& ${pq(m.bin)} --version`)).out.split('\n')[0]}`);
  const b = await onMember(
    `if [ -f ${sq(m.config)} ]; then cp -p ${sq(m.config)} ${sq(m.backup)} && echo backed-up; else echo none; fi`,
    `if (Test-Path -LiteralPath ${pq(m.config)}) { Copy-Item -LiteralPath ${pq(m.config)} -Destination ${pq(m.backup)} -Force; 'backed-up' } else { 'none' }`,
  );
  m.hadConfig = b.out.includes('backed-up');
  check(b.code === 0, m.hadConfig ? `KB config copied to ${m.backup}` : 'no KB config on the member yet', `backup failed: ${b.out}`);
  m.before = await memberLeftovers();
  if (!check(m.before.ok, `before: staged token files ${m.before.staged}, post-commit hook ${m.before.hook}`, `the leftover probes failed before the run: ${m.before.detail}`)) return;

  step(4, `live secret ${secretName} on the orchestrator, fake helper ${helper}`);
  // node by bare name: the orchestrator's fleet server resolves it on its own PATH.
  const reg = fleet(['secret', '--live', secretName, '--', 'node', helper, tokenFile]);
  liveRegistered = reg.code === 0;
  if (!check(liveRegistered && /^OK: expires/m.test(reg.out), `registered: ${reg.out}`, `registration failed: ${reg.out}`)) return;

  step(5, 'provision_kb_auth');
  const first = await provision();
  check(!first.isError && first.body.ok === true && first.body.verification?.status === 'verified', 'verified', 'not verified');
  check(!JSON.stringify(first).includes(fs.readFileSync(tokenFile, 'utf8').trim()), 'the result carries no token', 'the token appears in the result');
  const cfg = await onMember(`cat ${sq(m.config)}`, `Get-Content -Raw -LiteralPath ${pq(m.config)}`);
  let parsed = {};
  try { parsed = JSON.parse(cfg.out); } catch { /* reported below */ }
  check(parsed.provider === 'http' && parsed.token_ref === `{{secret.${secretName}}}`,
    `member KB config: provider=${parsed.provider} url=${parsed.url} token_ref=${parsed.token_ref}`, `member KB config does not name the secret: ${cfg.out.slice(0, 200)}`);

  step(6, "a KB call through the member's own fleet server");
  const marker = `kb-evidence-${crypto.randomBytes(4).toString('hex')}`;
  const capture = JSON.stringify({ type: 'knowledge', title: marker, summary: `provision_kb_auth evidence ${marker}.`, content: `Written through the member fleet server for ${marker}.` });
  const call = await onMember(
    `printf '%s' ${sq(capture)} > ${sq(m.args)} && ${sq(m.bin)} call --member ${sq(m.id)} kb_capture --args-file ${sq(m.args)} --rm-args-file`,
    `Set-Content -LiteralPath ${pq(m.args)} -Value ${pq(capture)} -NoNewline -Encoding ascii; & ${pq(m.bin)} call --member ${pq(m.id)} kb_capture --args-file ${pq(m.args)} --rm-args-file`,
  );
  info(`member kb_capture: exit ${call.code}: ${call.out.split('\n').pop().slice(0, 200)}`);
  check(call.code === 0 && !/offline-|E-KB-HTTP-AUTH/.test(call.out), 'kb_capture answered by the member server, not queued', 'kb_capture failed or was queued offline');
  const found = await kbGet(`/api/kb/query?query=${marker}&confidence=CONFIRMED,INFERRED,UNVERIFIED`);
  check((found.l1_results ?? []).some((e) => e.title === marker), 'the entry is on the test KB server: the member server authenticated with the pushed token', 'the entry is not on the test KB server');

  step(7, 'rotate the KB server token; the cached token is now refused');
  fs.writeFileSync(tokenFile, newToken());
  await new Promise((r) => setTimeout(r, 1000));
  const stale = await provision();
  check(stale.body.verification?.status === 'failed' && stale.body.verification?.reason === 'rejected',
    'without reason: the cached token was pushed and the member reports rejected', 'expected verification rejected');
  const fresh = await provision({ reason: 'rejected' });
  check(fresh.body.ok === true, 'with reason rejected: a new token was minted, pushed and verified', 'expected verified after reason rejected');

  step(8, 'nothing left behind on the member');
  const after = await memberLeftovers();
  if (!check(after.ok, 'the leftover probes ran', `the leftover probes failed after the run: ${after.detail}`)) return;
  check(after.staged === m.before.staged, `staged token files: ${after.staged} (as before)`, `staged token files: ${m.before.staged} before, ${after.staged} after`);
  check(after.hook === m.before.hook, `post-commit hook unchanged (${after.hook})`, `post-commit hook changed: ${m.before.hook} -> ${after.hook}`);
}

async function cleanup() {
  if (args.keep) { info('--keep: nothing cleaned up'); return; }
  step(9, 'clean up');
  if (client && m.bin) {
    const del = await onMember(`${sq(m.bin)} secret --delete ${sq(secretName)}`, `& ${pq(m.bin)} secret --delete ${pq(secretName)}`);
    info(`member secret delete: exit ${del.code}`);
    const restore = m.hadConfig
      ? await onMember(`mv -f ${sq(m.backup)} ${sq(m.config)}`, `Move-Item -Force -LiteralPath ${pq(m.backup)} -Destination ${pq(m.config)}`)
      : await onMember(`rm -f ${sq(m.config)}`, `Remove-Item -Force -LiteralPath ${pq(m.config)} -ErrorAction SilentlyContinue`);
    check(restore.code === 0, m.hadConfig ? 'member KB config restored' : 'member KB config removed (there was none)', `restore failed: ${restore.out}`);
  }
  if (liveRegistered) info(`orchestrator live secret delete: ${fleet(['secret', '--delete', secretName]).out}`);
  if (registered) {
    const rm = await tool('remove_member', { member_name: args.member, force: true });
    info(`remove_member: ${rm.text.split('\n')[0]}`);
  }
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
