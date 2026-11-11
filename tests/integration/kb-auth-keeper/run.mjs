#!/usr/bin/env node
// Evidence run for fleet-sprint's KB auth keeper against a REAL remote member, by hand.
//
// Real dispatches through the engine's own pieces: fleet-sprint's KB auth
// keeper (kb-auth-keeper.mjs) around the workflow agent() that fleet-sprint
// dispatches with, on an isolated orchestrator started from this build. The
// token lives SECONDS, so the refresh comes due inside a dispatch.
//
//   1. starts a KB test server here (apra-fleet kb-server --token-file); its
//      token is a random value in a temp file, so no real credential is involved;
//   2. attaches to the isolated orchestrator (APRA_FLEET_DATA_DIR), checks that
//      its config.json sets liveSecrets.refreshFraction (so T is most of the
//      token's life), and with --register registers the member there;
//   3. registers a live secret whose fake helper hands out the KB server's
//      current token, valid for --lifetime-s, and points the orchestrator's KB
//      config at it (apra-fleet kb-setup --token-ref): the keeper reads both
//      from fleet_status;
//   4. dispatch 1, short-lived token: the keeper pushes before the dispatch (no
//      token recorded yet), and its timer pushes again while the agent works;
//   5. dispatch 2, long-lived token: the KB server token is rotated right after
//      the keeper's pre-dispatch push, so the agent's kb_query is rejected; the
//      keeper heals with reason rejected and resumes the session exactly once,
//      and the resumed agent's kb_query works;
//   6. cleans up what it created: the member's pushed secret and KB config
//      (restored from a backup), the live secret, the orchestrator KB config,
//      the KB server. It never deregisters a member (remove_member deletes the
//      member's LLM login files): with --register the registration stays in the
//      isolated data dir, removed with it.
//
// Needs: a member install of this build on the member (query_errors with
// origin, provision_kb_auth's push); the member's LLM sessions reaching their
// own fleet server's kb_* tools; the KB port reachable FROM THE MEMBER at
// --kb-url and from here; `node` on the orchestrator server's PATH.
//
// Only against an isolated orchestrator from this build (it changes that
// orchestrator's KB config and needs a short T):
//   npm run build
//   export APRA_FLEET_DATA_DIR=<new empty dir> APRA_FLEET_PORT=<free port>
//   printf '{"liveSecrets":{"refreshFraction":0.9}}' > "$APRA_FLEET_DATA_DIR/config.json"
//   node dist/index.js run &          # the isolated orchestrator
//   node tests/integration/kb-auth-keeper/run.mjs --register --member kb-keeper \
//     --host <member host> --ssh-user <user> --ssh-key <key path> \
//     --work-folder <member work folder> --kb-url http://<this host>:<port> --yes
//   then stop that server and remove the data dir.
//
// Options: [--port <KB listen port>] [--lifetime-s N (default 60)] [--model <tier>]
//          [--ssh-port N] [--keep]. Exit code 0 only when every check passed.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const isWin = process.platform === 'win32';

function usage(msg) {
  console.error(`error: ${msg}`);
  console.error('usage: run.mjs --member <name> --kb-url http://<host reachable from the member>:<port> --yes [--register --host H --ssh-user U --ssh-key K --work-folder F [--ssh-port N]] [--port N] [--lifetime-s N] [--model TIER] [--keep]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { yes: false, keep: false, register: false };
  const valued = { '--member': 'member', '--kb-url': 'kbUrl', '--port': 'port', '--lifetime-s': 'lifetimeS', '--model': 'model',
    '--host': 'host', '--ssh-user': 'sshUser', '--ssh-key': 'sshKey', '--work-folder': 'workFolder', '--ssh-port': 'sshPort' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued[a]) { if (argv[i + 1] === undefined) usage(`${a} needs a value`); out[valued[a]] = argv[++i]; }
    else if (a === '--yes') out.yes = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--register') out.register = true;
    else usage(`unknown argument ${a}`);
  }
  if (!out.member || !out.kbUrl) usage('--member and --kb-url are required');
  if (out.register && !(out.host && out.sshUser && out.sshKey && out.workFolder)) usage('--register needs --host, --ssh-user, --ssh-key and --work-folder');
  if (!process.env.APRA_FLEET_DATA_DIR) usage('APRA_FLEET_DATA_DIR must name the isolated orchestrator\'s data dir (see the header)');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const kbUrl = new URL(args.kbUrl);
const port = Number(args.port ?? (kbUrl.port || 7878));
const lifetimeS = Number(args.lifetimeS ?? 60);
const secretName = `KB_KEEPER_${crypto.randomBytes(3).toString('hex')}`;
const dataDir = process.env.APRA_FLEET_DATA_DIR;

let failures = 0;
function step(n, text) { console.log(`\n[${n}] ${text}`); }
function ok(text) { console.log(`  [OK] ${text}`); }
function fail(text) { failures++; console.log(`  [FAIL] ${text}`); }
function info(text) { console.log(`  ${text}`); }
function check(cond, good, bad) { if (cond) ok(good); else fail(bad); return cond; }

// This build's CLI, on the isolated data dir (inherited from the environment).
function fleet(cliArgs, input) {
  const r = spawnSync(process.execPath, [path.join(repo, 'dist', 'index.js'), ...cliArgs], { input, encoding: 'utf-8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

if (!args.yes) {
  console.log(`This changes the KB config of member "${args.member}" and of the orchestrator at ${dataDir} while it runs, and restores the member's at the end.`);
  console.log('Re-run with --yes to go ahead.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keeper-evidence-'));
const tokenFile = path.join(tmp, 'kb-server.token');
const lifetimeFile = path.join(tmp, 'lifetime-s');
const helper = path.join(tmp, 'fake-helper.mjs');
const newToken = () => crypto.randomBytes(24).toString('hex');
fs.writeFileSync(tokenFile, newToken(), { mode: 0o600 });
fs.writeFileSync(lifetimeFile, String(lifetimeS));
// The fake helper: whatever the KB server accepts now, valid for the seconds in lifetimeFile.
fs.writeFileSync(helper, [
  "import fs from 'node:fs';",
  'const token = fs.readFileSync(process.argv[2], "utf8").trim();',
  'const seconds = Number(fs.readFileSync(process.argv[3], "utf8"));',
  'process.stdout.write(JSON.stringify({ token, expires_at: new Date(Date.now() + seconds * 1000).toISOString() }));',
].join('\n'));

let kbServer;
let client;
let registered = false;
let liveRegistered = false;
let orchestratorKbWritten = false;
const m = {};

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const pq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

async function tool(name, input) {
  const r = await client.mcpClient.callTool(name, input);
  return { isError: !!r?.isError, body: payload(r), text: (r?.content ?? []).map((c) => c.text ?? '').join('\n') };
}

async function onMember(posix, powershell) {
  const r = await tool('execute_command', { member_name: args.member, command: m.posix ? posix : powershell, timeout_s: 90 });
  return { code: typeof r.body.exitCode === 'number' && !r.isError ? r.body.exitCode : null, out: `${r.body.stdout ?? ''}${r.body.stderr ?? ''}`.trim() || r.text };
}

/** One keeper-wrapped dispatch. Returns {value, lines, runs}; each run keeps its own toolErrors. */
async function keeperDispatch(wf, keeperState, prompt, beforeFirstRun) {
  const lines = [];
  keeperState.log = (l) => { lines.push(l); info(l); };
  const runs = [];
  const run = async (p, o) => {
    if (runs.length === 0 && beforeFirstRun) await beforeFirstRun();
    const entry = { resume: o.resume, note: p.startsWith('KB auth is restored'), toolErrors: [] };
    runs.push(entry);
    const onToolErrors = (r, meta) => { entry.toolErrors.push(r); o.onToolErrors?.(r, meta); };
    return wf.agent(p, { ...o, onToolErrors });
  };
  const value = await keeperState.keeper.dispatch({
    member: args.member, prompt,
    opts: { member_name: args.member, label: 'kb-keeper evidence', timeout_s: 300, max_total_s: 600, ...(args.model ? { model: args.model } : {}) },
    run,
  });
  return { value, lines, runs };
}

async function main() {
  step(1, `KB test server on port ${port}, token from ${tokenFile}`);
  const serverData = path.join(tmp, 'kb-server-data');
  fs.mkdirSync(serverData);
  kbServer = spawn(process.execPath, [path.join(repo, 'dist', 'index.js'), 'kb-server', '--port', String(port), '--token-file', tokenFile, '--db', path.join(tmp, 'kb.sqlite')],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, APRA_FLEET_DATA_DIR: serverData } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kb-server did not start in 20 s')), 20_000);
    kbServer.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve(); } });
    kbServer.on('exit', (code) => { clearTimeout(timer); reject(new Error(`kb-server exited ${code}`)); });
  });
  ok(`listening; the member must reach it at ${args.kbUrl}`);

  step(2, `isolated orchestrator, data dir ${dataDir}`);
  let fraction = null;
  try { fraction = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))?.liveSecrets?.refreshFraction ?? null; } catch { /* reported below */ }
  if (!check(typeof fraction === 'number' && fraction >= 0.5, `config.json liveSecrets.refreshFraction ${fraction}: a ${lifetimeS} s token is refreshed ${Math.round(lifetimeS * (1 - fraction))} s after its push`,
    'config.json in the data dir must set liveSecrets.refreshFraction >= 0.5 before the server starts (see the header)')) return;
  const { connectFleet } = await import(pathToFileURL(path.join(repo, 'packages', 'apra-fleet-client', 'src', 'client', 'server-resolution.mjs')).href);
  client = await connectFleet({ env: { ...process.env, APRA_FLEET_TRANSPORT: 'http' } });
  info(`server: ${(await tool('version', {})).text.split('\n')[0]}`);
  const names = ((await client.mcpClient.listTools())?.tools ?? []).map((t) => t.name);
  if (!check(names.includes('provision_kb_auth') && names.includes('query_errors'), 'the server has provision_kb_auth and query_errors', 'run this build as the orchestrator')) return;
  if (args.register) {
    const reg = await tool('register_member', {
      friendly_name: args.member, member_type: 'remote', host: args.host, port: Number(args.sshPort ?? 22),
      username: args.sshUser, auth_type: 'key', key_path: args.sshKey, work_folder: args.workFolder, fleet_install: 'auto',
    });
    registered = !reg.isError;
    info(reg.text.split('\n').slice(0, 3).join(' | '));
    if (!check(registered, 'member registered on this orchestrator', 'register_member failed')) return;
  }
  const d = (await tool('member_detail', { member_name: args.member, format: 'json' })).body;
  info(`member: type=${d.type} os=${d.os} shell=${d.shell ?? '(default)'} fleetMcp=${d.fleetMcp?.state ?? 'unknown'}`);
  if (!check(d.type === 'remote', 'a remote member', 'this script is for a remote member')) return;
  m.posix = d.os !== 'windows' || d.shell === 'gitbash';
  m.home = (await onMember('printf %s "$HOME"', '[Console]::Out.Write($HOME)')).out.trim();
  const join = (...p) => (m.posix ? p.join('/') : p.join('\\'));
  m.bin = join(m.home, '.apra-fleet', 'bin', d.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet');
  m.config = join(m.home, '.apra-fleet', 'data', 'knowledge', 'config.json');
  m.backup = `${m.config}.keeper-bak`;
  // Moved aside, so the member has no KB config: the keeper never rewires a
  // member KB set up for something else, and would skip this member.
  const b = await onMember(
    `if [ -f ${sq(m.config)} ]; then mv -f ${sq(m.config)} ${sq(m.backup)} && echo backed-up; else echo none; fi`,
    `if (Test-Path -LiteralPath ${pq(m.config)}) { Move-Item -LiteralPath ${pq(m.config)} -Destination ${pq(m.backup)} -Force; 'backed-up' } else { 'none' }`,
  );
  m.hadConfig = b.out.includes('backed-up');
  if (!check(b.code === 0, m.hadConfig ? `member KB config moved aside to ${m.backup}` : 'no KB config on the member yet', `backup failed: ${b.out}`)) return;

  step(3, `live secret ${secretName} (token for ${lifetimeS} s) and the orchestrator KB config`);
  const reg = fleet(['secret', '--live', secretName, '--', 'node', helper, tokenFile, lifetimeFile]);
  liveRegistered = reg.code === 0;
  if (!check(liveRegistered && /^OK: expires/m.test(reg.out), `registered: ${reg.out}`, `registration failed: ${reg.out}`)) return;
  const setup = fleet(['kb-setup', '--remote', args.kbUrl, '--token-ref', secretName]);
  orchestratorKbWritten = setup.code === 0;
  if (!check(orchestratorKbWritten, `orchestrator KB config: ${setup.out.split('\n').pop()}`, `kb-setup failed: ${setup.out}`)) return;
  const cred = (await tool('fleet_status', { format: 'json' })).body?.kbHealth?.credential;
  if (!check(cred?.kind === 'live' && cred?.secretName === secretName, `fleet_status kbHealth.credential: live secret ${cred?.secretName} at ${cred?.url}`, `fleet_status shows no live KB credential: ${JSON.stringify(cred)}`)) return;

  const { createKbAuthKeeper } = await import(pathToFileURL(path.join(repo, 'packages', 'apra-fleet-se', 'fleet-sprint', 'kb-auth-keeper.mjs')).href);
  const { FleetWorkflow } = await import(pathToFileURL(path.join(repo, 'packages', 'apra-fleet-workflow', 'src', 'workflow', 'index.mjs')).href);
  const wf = new FleetWorkflow(client);
  // One keeper for the run, as in a sprint; its log goes through keeperState.log.
  const keeperState = { log: () => {} };
  keeperState.keeper = createKbAuthKeeper({ callTool: (n, a) => client.mcpClient.callTool(n, a), log: (l) => keeperState.log(l) });
  const marker = `kb-keeper-${crypto.randomBytes(4).toString('hex')}`;
  const kbPrompt = (n) => `This is a test of KB access. Call the kb_query tool ${n} with query "${marker}". ` +
    'Report each call\'s outcome in one line (ok, or the error code and reason). Do nothing else, then reply DONE.';

  step(4, `dispatch 1: pre-dispatch push and a timer push while the agent works (token lives ${lifetimeS} s)`);
  const d1 = await keeperDispatch(wf, keeperState, kbPrompt('three times, waiting about 15 seconds between calls (for example with a sleep shell command if you have one)'));
  info(`agent: ${String(d1.value).split('\n').slice(-3).join(' | ')}`);
  check(d1.lines.some((l) => /provision_kb_auth for member .*no token recorded in this sprint process/.test(l)), 'pushed before the dispatch: no token recorded yet', 'no pre-dispatch push logged');
  check(d1.lines.some((l) => /provision_kb_auth for member .*refresh time reached during a dispatch/.test(l)), 'pushed again by the timer during the dispatch', 'no timer push logged (a dispatch shorter than the refresh delay? raise the wait or lower --lifetime-s)');
  check(d1.runs.length === 1, 'no heal was needed', `the dispatch was re-run ${d1.runs.length - 1} time(s)`);
  check(d1.runs[0].toolErrors.some((r) => r.available === true), 'toolErrors were read from the member', `toolErrors not available: ${JSON.stringify(d1.runs[0].toolErrors)}`);

  step(5, 'dispatch 2: the KB server token is rotated after the pre-dispatch push, so the agent is rejected and healed');
  // A long-lived token now, so no timer push repairs it before the agent's call;
  // and wait out dispatch 1's last refresh window, so dispatch 2 starts with a push.
  fs.writeFileSync(lifetimeFile, '3600');
  const waitS = Math.ceil(lifetimeS * (1 - fraction)) + 5;
  info(`waiting ${waitS} s for the recorded refresh time to pass`);
  await new Promise((r) => setTimeout(r, waitS * 1000));
  const d2 = await keeperDispatch(wf, keeperState, kbPrompt('once'), async () => {
    fs.writeFileSync(tokenFile, newToken());
    info('KB server token rotated: the member\'s copy is now refused');
    await new Promise((r) => setTimeout(r, 1000));
  });
  info(`agent: ${String(d2.value).split('\n').slice(-3).join(' | ')}`);
  check(d2.lines.some((l) => /provision_kb_auth for member .*token within its refresh window/.test(l)), `pushed before the dispatch: the ${lifetimeS} s token was due`, 'no pre-dispatch push logged');
  const resumes = d2.lines.filter((l) => /KB auth restored, resuming session/.test(l));
  check(resumes.length === 1, `healed and resumed once: ${resumes[0] ?? ''}`, `expected exactly one resume, logged ${resumes.length}`);
  check(d2.runs.length === 2 && typeof d2.runs[1].resume === 'string' && d2.runs[1].note, 'the second run resumed the session by id with the note', `runs: ${JSON.stringify(d2.runs)}`);
  const authIn = (reports) => reports.flatMap((r) => (r.available ? r.entries : [])).filter((e) => e.code === 'E-KB-HTTP-AUTH');
  const firstAuth = authIn(d2.runs[0]?.toolErrors ?? []);
  check(firstAuth.some((e) => e.reason === 'rejected' && e.origin === 'session'), `the agent's own KB call was rejected: ${JSON.stringify(firstAuth)}`, `no rejected E-KB-HTTP-AUTH from the agent in toolErrors: ${JSON.stringify(d2.runs[0]?.toolErrors)}`);
  const resumedReports = d2.runs[1]?.toolErrors ?? [];
  check(resumedReports.some((r) => r.available) && authIn(resumedReports).length === 0, 'the resumed session made its KB call with no auth error',
    `the resumed session's toolErrors: ${JSON.stringify(resumedReports)}`);
}

async function cleanup() {
  if (args.keep) { info('--keep: nothing cleaned up'); return; }
  step(6, 'clean up');
  if (client && m.bin) {
    const del = await onMember(`${sq(m.bin)} secret --delete ${sq(secretName)}`, `& ${pq(m.bin)} secret --delete ${pq(secretName)}`);
    info(`member secret delete: exit ${del.code}`);
    const restore = m.hadConfig
      ? await onMember(`mv -f ${sq(m.backup)} ${sq(m.config)}`, `Move-Item -Force -LiteralPath ${pq(m.backup)} -Destination ${pq(m.config)}`)
      : await onMember(`rm -f ${sq(m.config)}`, `Remove-Item -Force -LiteralPath ${pq(m.config)} -ErrorAction SilentlyContinue`);
    check(restore.code === 0, m.hadConfig ? 'member KB config restored' : 'member KB config removed (there was none)', `restore failed: ${restore.out}`);
  }
  if (orchestratorKbWritten) {
    fs.rmSync(path.join(dataDir, 'knowledge', 'config.json'), { force: true });
    info('orchestrator KB config removed (an isolated data dir)');
  }
  if (liveRegistered) info(`orchestrator live secret delete: ${fleet(['secret', '--delete', secretName]).out}`);
  // Detach without deregistering (see the header).
  if (registered) info(`member "${args.member}" stays registered on this orchestrator (not deregistered on purpose)`);
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
