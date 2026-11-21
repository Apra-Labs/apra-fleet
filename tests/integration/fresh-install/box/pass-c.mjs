// Fresh-install harness, pass C: git credential helpers across an upgrade.
// Runs INSIDE the box (both dialects call it after installing the pinned
// Node.js; Windows also puts git on PATH). Records one JSON line per
// checklist step to <out>/results.jsonl, facts only -- verdicts are applied
// on the host (lib/verdict.mjs + checklist.json "C").
//
// Every scenario starts from the baseline release with a fresh home, so the
// baseline writes its legacy shared helper file and global git config key;
// then an operator adds helpers of their own, the candidate takes over the
// same data, and one member re-provisions. Scenarios (step-id prefix):
//   CN  two members, the box user's own home, real install / install --force
//   CP  two members, plain home              CS  one member, plain home
//   CQ  two members, home with an apostrophe AND a space   CR  one member, same
//   CW  two members, home with a space           CX  one member, same
// The CN scenario uses the installer and the platform's service; the others
// set HOME (and USERPROFILE on Windows) to their own directory and run the
// baseline and then the candidate server by hand from the same data, because
// a service registered by the installer always runs with the user's real
// profile. No network credential is used: the GitHub PAT is a dummy string,
// and members carry no repo, so provision's connectivity check is skipped.
//
// Usage: node pass-c.mjs --base <baseline installer> --cand <candidate installer> --out <dir>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = opt('--base');
const CAND = opt('--cand');
const OUT = opt('--out');
if (!BASE || !CAND || !OUT) { console.error('usage: pass-c.mjs --base <bin> --cand <bin> --out <dir>'); process.exit(2); }
const IS_WIN = process.platform === 'win32';
const LOGS = path.join(OUT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const RES = path.join(OUT, 'results.jsonl');
const PORT = 7523;
const BASEURL = `http://127.0.0.1:${PORT}`;
const SCOPE = 'https://github.com';
const KEY = `credential.${SCOPE}.helper`;
const OTHER_KEY = 'credential.https://dev.azure.com.helper';
// Operator helpers: one on fleet's key (what `gh auth setup-git` adds), one on another key.
const OP_SAME = '!gh auth git-credential';
const OP_OTHER = '!fi-operator-other-key-helper';
const LEGACY_FILE = IS_WIN ? '.fleet-git-credential-github.bat' : '.fleet-git-credential-github';
const EXE = IS_WIN ? '.exe' : '';

const ascii = s => String(s ?? '').replace(/[^\t\x20-\x7e]/g, '');
const one = s => ascii(String(s ?? '').replace(/\s+/g, ' ')).trim().slice(0, 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m) { fs.appendFileSync(path.join(OUT, 'box.log'), `[${new Date().toISOString().slice(11, 19)}] C ${m}\n`); }
function rec(id, cmd, exit, keyline, observed = '', na = null) {
  const o = { pass: 'C', id, cmd: ascii(cmd), exit: ascii(String(exit)), keyline: one(keyline), observed: one(observed) };
  if (na) o.na = ascii(na);
  fs.appendFileSync(RES, JSON.stringify(o) + '\n');
  log(`${id} exit=${o.exit} key=${o.keyline} obs=${o.observed}${na ? ` NA=${na}` : ''}`);
}
function stepLog(id, name, text) { fs.writeFileSync(path.join(LOGS, `${id}-${name}.log`), text); }

function run(file, args, env, timeoutMs = 600000) {
  const r = spawnSync(file, args, { env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.error ? `ERR ${r.error.code ?? r.error.message}` : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const git = (env, ...args) => run('git', args, env, 60000);
const getAll = (env, key) => { const r = git(env, 'config', '--global', '--get-all', key); return r.code === 0 ? r.out.replace(/\r/g, '').split('\n').slice(0, -1) : []; };
const isFleetValue = v => /\.fleet-git-credential/.test(v);
// Operator-written credential helper lines (every key), as `key value` text: byte-for-byte comparable.
function operatorHelpers(env) {
  const r = git(env, 'config', '--global', '--get-regexp', '^credential\\..*\\.helper$');
  return r.out.replace(/\r/g, '').split('\n').filter(l => l && !isFleetValue(l) && /\s\S/.test(l)).join('\n');
}

async function health() {
  try {
    const res = await fetch(`${BASEURL}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.text();
    return { code: res.status, body, version: /v\d+\.\d+\.\d+_[0-9a-f]+/.exec(body)?.[0] ?? '' };
  } catch { return { code: 'ERR connection failed', body: '', version: '' }; }
}
async function waitHealth(secs, want = v => true) {
  for (let i = 0; i < secs; i += 2) { const h = await health(); if (h.code === 200 && want(h.version)) return h; await sleep(2000); }
  return health();
}
async function waitDown(secs) { for (let i = 0; i < secs; i += 1) { if ((await health()).code !== 200) return true; await sleep(1000); } return false; }

/** Start `<bin> run` detached with env; output to a log. Returns the pid. */
function startServer(bin, env, logName) {
  const fd = fs.openSync(path.join(LOGS, `${logName}.log`), 'a');
  const child = spawn(bin, ['run'], { env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  log(`started ${bin} run pid=${child.pid}`);
  return child.pid;
}
async function stopServer(pid) {
  if (pid) {
    if (IS_WIN) run('taskkill', ['/PID', String(pid), '/T', '/F'], process.env, 30000);
    else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
  }
  if (!(await waitDown(20)) && !IS_WIN && pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } await waitDown(10); }
}

/** One orchestrator MCP session against the box server (install access secret header). */
async function mcpCall(home, tool, args, logId) {
  const keyFile = path.join(home, '.apra-fleet', 'data', 'member-access.key');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (fs.existsSync(keyFile)) headers['X-Apra-Fleet-Member-Secret'] = fs.readFileSync(keyFile, 'utf8').trim();
  const parse = async res => {
    const t = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const msgs = t.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
      return msgs.find(m => m.id !== undefined) ?? null;
    }
    try { return JSON.parse(t); } catch { return { raw: t }; }
  };
  let transcript = `tool ${tool}\nargs ${JSON.stringify(args)}\n`;
  let sid = null;
  try {
    const init = await fetch(`${BASEURL}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fresh-install-pass-c', version: '1' } } }), signal: AbortSignal.timeout(30000) });
    sid = init.headers.get('mcp-session-id');
    const ib = await parse(init);
    transcript += `initialize HTTP ${init.status} session=${sid ? 'yes' : 'no'} ${JSON.stringify(ib).slice(0, 300)}\n`;
    if (init.status !== 200 || !sid) throw new Error(`initialize HTTP ${init.status}`);
    const h2 = { ...headers, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' };
    await fetch(`${BASEURL}/mcp`, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(30000) }).then(r => r.text());
    const res = await fetch(`${BASEURL}/mcp`, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(300000) });
    const body = await parse(res);
    const result = body?.result ?? null;
    const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const sc = result?.structuredContent ?? null;
    transcript += `tools/call HTTP ${res.status}\n--- text ---\n${text}\n--- structuredContent ---\n${JSON.stringify(sc, null, 2)}\n${body?.error ? `--- error ---\n${JSON.stringify(body.error)}\n` : ''}`;
    const failed = !result || result.isError === true || sc?.ok === false || /^\s*(\[FAIL\]|Error)/.test(text);
    return { ok: !failed, text, sc, error: body?.error ?? null };
  } catch (e) {
    transcript += `EXCEPTION ${e.message}\n`;
    return { ok: false, text: '', sc: null, error: e.message };
  } finally {
    if (sid) { try { await fetch(`${BASEURL}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid }, signal: AbortSignal.timeout(10000) }); } catch { /* best effort */ } }
    if (logId) stepLog(logId, tool, transcript);
  }
}

// Member-shell commands (local members: POSIX sh on Linux/macOS, PowerShell 5 on Windows).
const fillCmd = IS_WIN
  ? "$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'; 'protocol=https','host=github.com','' | git credential fill"
  : "printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill";
const statusCmd = 'git status --short --branch';
const lsRemoteCmd = IS_WIN
  ? "$env:GIT_TERMINAL_PROMPT='0'; git ls-remote https://github.com/Apra-Labs/apra-fleet.git HEAD"
  : 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/Apra-Labs/apra-fleet.git HEAD';

async function exec(home, member, command, logId) {
  const r = await mcpCall(home, 'execute_command', { member_name: member, command, timeout_s: 60 }, logId);
  const code = r.sc?.exitCode ?? (/^Exit code: (-?\d+)/.exec(r.text)?.[1] ?? (r.ok ? 0 : 'ERR'));
  return { ...r, code: Number.isFinite(Number(code)) ? Number(code) : code };
}
const passwordOf = text => /password=(\S+)/.exec(text ?? '')?.[1] ?? '';

/**
 * One scenario. sc: { p (id prefix), name, home, two (bool), viaInstall (bool) }.
 * Step numbers are fixed per scenario so both member-count variants share
 * the checklist layout; steps that do not apply to a one-member scenario are
 * simply not in its checklist block.
 */
async function scenario(sc) {
  const { p, home, two, viaInstall } = sc;
  const id = n => `${p}${String(n).padStart(2, '0')}`;
  log(`scenario ${p} (${sc.name}) home=${home} two=${two} viaInstall=${viaInstall}`);
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  // Windows: fleet resolves helper paths from USERPROFILE, while git finds its
  // global config from HOME, else HOMEDRIVE+HOMEPATH (a member shell need not
  // carry HOME) -- point every one of them at the scenario home.
  if (IS_WIN) {
    env.USERPROFILE = home;
    env.HOMEDRIVE = home.slice(0, 2);
    env.HOMEPATH = home.slice(2);
  }
  const installed = path.join(home, '.apra-fleet', 'bin', `apra-fleet${EXE}`);
  const tok = (m, phase) => `fi-dummy-${p.toLowerCase()}-${m}-${phase}`;
  const members = two ? ['m1', 'm2'] : ['m1'];
  const mname = m => `fi-${p.toLowerCase()}-${m}`;
  let pid = null;

  // 01 baseline server up on the baseline version.
  if (viaInstall) {
    const r = run(BASE, ['install', '--workflows', 'none'], env, 900000);
    stepLog(id(1), 'base-install', `${r.out}\n=== EXIT CODE: ${r.code} ===\n`);
    let h = await waitHealth(60);
    let note = `install exit ${r.code}`;
    if (h.code !== 200) { pid = startServer(installed, env, `${id(1)}-server`); h = await waitHealth(60); note += '; started by hand (no service manager)'; }
    rec(id(1), 'base install --workflows none; GET /health', h.code, `${h.body.slice(0, 120)} (${note})`, h.version);
  } else {
    pid = startServer(BASE, env, `${id(1)}-server`);
    const h = await waitHealth(60);
    rec(id(1), `base run (HOME=${home}); GET /health`, h.code, h.body.slice(0, 160), h.version);
  }

  // 02 register the members (local, llm none, own work folder each, a git repo in it).
  const regs = [];
  for (const m of members) {
    const wf = path.join(home, `fi-work-${m}`);
    fs.mkdirSync(wf, { recursive: true });
    git(env, 'init', '-q', wf);
    const args = { friendly_name: mname(m), member_type: 'local', work_folder: wf, llm_provider: 'none', vcs_provider: 'github' };
    if (IS_WIN) args.shell = 'powershell5';
    regs.push(await mcpCall(home, 'register_member', args, `${id(2)}-${m}`));
  }
  rec(id(2), `register_member ${members.map(mname).join(', ')} (local, llm none)`, regs.every(r => r.ok) ? 0 : 1,
    regs.map(r => one(r.text).slice(0, 100) || r.error).join(' | '));

  // 03 baseline provision label github (PAT mode, dummy token), each member.
  const provs = [];
  for (const m of members) {
    provs.push(await mcpCall(home, 'provision_vcs_auth', { member_name: mname(m), provider: 'github', github_mode: 'pat', token: tok(m, 'base'), non_interactive: true }, `${id(3)}-${m}`));
  }
  rec(id(3), `baseline provision_vcs_auth github pat (dummy token) on ${members.map(mname).join(', ')}`, provs.every(r => r.ok) ? 0 : 1,
    provs.map(r => one(r.text.split('\n')[0]) || r.error).join(' | '));

  // 04 the baseline wrote fleet's legacy helper into the GLOBAL git config key.
  const before = getAll(env, KEY);
  const origin = git(env, 'config', '--global', '--list', '--show-origin').out.split('\n')[0] ?? '';
  const legacyPath = path.join(home, LEGACY_FILE);
  // The baseline's empty reset value: absent on Windows PowerShell 5.1, which drops an empty native argument.
  const emptyBefore = before.includes('');
  rec(id(4), `git config --global --get-all ${KEY}`, before.some(isFleetValue) && fs.existsSync(legacyPath) ? 0 : 1,
    `values: ${before.map(v => JSON.stringify(v)).join(', ')}; legacy file ${fs.existsSync(legacyPath) ? 'present' : 'absent'}`, `origin: ${origin.split('\t')[0]}`);

  // 05 operator adds helpers of their own: one on fleet's key, one on another key.
  const a1 = git(env, 'config', '--global', '--add', KEY, OP_SAME);
  const a2 = git(env, 'config', '--global', '--add', OTHER_KEY, OP_OTHER);
  const opBefore = operatorHelpers(env);
  stepLog(id(5), 'operator-helpers-before', `${opBefore}\n`);
  rec(id(5), `git config --global --add ${KEY} '${OP_SAME}'; --add ${OTHER_KEY} '${OP_OTHER}'`,
    a1.code === 0 && a2.code === 0 ? 0 : 1, opBefore.replace(/\n/g, ' | '));

  // 16 (two members) baseline behaviour of m2's dispatch, for step 11 to compare against.
  let base2 = null;
  if (two) {
    const f = await exec(home, mname('m2'), fillCmd, id(16));
    base2 = { code: f.code, pw: passwordOf(f.text), err: one(f.sc?.stderr ?? '').slice(0, 160) };
    rec(id(16), `baseline execute_command ${mname('m2')}: git credential fill`, f.code === 0 && base2.pw === tok('m2', 'base') ? 0 : 1,
      `password=${base2.pw || '(none)'} exit=${f.code}${base2.err ? ` stderr: ${base2.err}` : ''}`, `want ${tok('m2', 'base')}`);
  }

  // 06 upgrade to the candidate.
  if (viaInstall) {
    const r = run(CAND, ['install', '--force', '--workflows', 'none'], env, 900000);
    stepLog(id(6), 'cand-install-force', `${r.out}\n=== EXIT CODE: ${r.code} ===\n`);
    let h = await waitHealth(60, v => v === '' || !/^v0\.4\.5/.test(v));
    let note = `install --force exit ${r.code}`;
    if (h.code !== 200 || /^v0\.4\.5/.test(h.version)) {
      await stopServer(pid); pid = startServer(installed, env, `${id(6)}-server`); h = await waitHealth(60); note += '; started by hand (no service manager)';
    }
    rec(id(6), 'cand install --force --workflows none; GET /health', h.code, `${h.body.slice(0, 120)} (${note})`, h.version);
  } else {
    await stopServer(pid);
    pid = startServer(CAND, env, `${id(6)}-server`);
    const h = await waitHealth(60);
    rec(id(6), `cand run on the same data (HOME=${home}); GET /health`, h.code, h.body.slice(0, 160), h.version);
  }

  // 07 re-provision m1 on the candidate: the result must report what happened to the legacy global helper.
  const re = await mcpCall(home, 'provision_vcs_auth', { member_name: mname('m1'), provider: 'github', github_mode: 'pat', token: tok('m1', 'new'), non_interactive: true }, id(7));
  const notice = re.text.split('\n').find(l => /Upgrade:/.test(l)) ?? '(no upgrade notice in the result text)';
  const lg = re.sc?.legacyGlobalHelper;
  rec(id(7), `candidate provision_vcs_auth github pat on ${mname('m1')}`, re.ok ? 0 : 1, notice,
    lg ? `outcome=${lg.outcome} removed=${lg.removedValues} kept=${lg.keptValues} keptForMember=${lg.keptForMember ?? ''} notice=${lg.notice ? 'yes' : 'no'}` : `legacyGlobalHelper=${JSON.stringify(lg)}`);

  // 08 operator helpers byte-for-byte unchanged (both keys).
  const opAfter = operatorHelpers(env);
  stepLog(id(8), 'operator-helpers-after', `${opAfter}\n`);
  rec(id(8), 'git config --global --get-regexp credential helpers (non-fleet values) before vs after',
    opAfter === opBefore && opAfter.includes(OP_SAME) && opAfter.includes(OP_OTHER) ? 0 : 1,
    `after: ${opAfter.replace(/\n/g, ' | ')}`, opAfter === opBefore ? 'identical' : `DIFFERENT; before: ${opBefore.replace(/\n/g, ' | ')}`);

  // 09 fleet's own legacy value: kept for a sharer (two members) / removed with the file, "" reset kept (one member).
  const after = getAll(env, KEY);
  const fleetLeft = after.some(isFleetValue);
  const fileLeft = fs.existsSync(legacyPath);
  const emptyLeft = after.includes('');
  const want09 = two ? (fleetLeft && fileLeft) : (!fleetLeft && !fileLeft && emptyLeft === emptyBefore && after.includes(OP_SAME));
  rec(id(9), `git config --global --get-all ${KEY}; test -e ~/${LEGACY_FILE}`, want09 ? 0 : 1,
    `values: ${after.map(v => JSON.stringify(v)).join(', ')}`, `fleet value ${fleetLeft ? 'present' : 'gone'}; legacy file ${fileLeft ? 'present' : 'gone'}; empty reset ${emptyLeft ? 'present' : 'absent'} (baseline: ${emptyBefore ? 'present' : 'absent'})`);

  // 10 m1's dispatch answers with its NEW per-member token.
  const f1 = await exec(home, mname('m1'), fillCmd, id(10));
  const p1 = passwordOf(f1.text);
  rec(id(10), `execute_command ${mname('m1')}: git credential fill (host github.com)`, f1.code === 0 && p1 === tok('m1', 'new') ? 0 : 1,
    `password=${p1 || '(none)'} exit=${f1.code}`, `want ${tok('m1', 'new')}`);

  // 11 (two members) m2, never re-provisioned, still answers: its LEGACY entry is served by the global key the sharer guard kept.
  if (two) {
    const f2 = await exec(home, mname('m2'), fillCmd, id(11));
    const p2 = passwordOf(f2.text);
    // Exactly what it did on the baseline (step 16): the upgrade must not change it.
    const same = base2 && f2.code === base2.code && p2 === base2.pw;
    rec(id(11), `execute_command ${mname('m2')}: git credential fill (legacy entry, global key)`, same ? 0 : 1,
      `password=${p2 || '(none)'} exit=${f2.code}${f2.code !== 0 ? ` stderr: ${one(f2.sc?.stderr ?? '').slice(0, 160)}` : ''}`,
      `${same ? 'unchanged' : 'CHANGED'} vs baseline (password=${base2?.pw || '(none)'} exit=${base2?.code})`);
  }

  // 12 a dispatch carrying m1's GIT_CONFIG_PARAMETERS runs git cleanly in this home.
  const st = await exec(home, mname('m1'), statusCmd, id(12));
  rec(id(12), `execute_command ${mname('m1')}: ${statusCmd}`, st.code, one(st.text.replace(/^Exit code: -?\d+\s*/, '')) || '(empty)');

  // 13 same, against a public remote (needs network to github.com; advisory).
  const ls = await exec(home, mname('m1'), lsRemoteCmd, id(13));
  rec(id(13), `execute_command ${mname('m1')}: git ls-remote <public github repo> HEAD`, ls.code, one(ls.text.replace(/^Exit code: -?\d+\s*/, '')) || '(empty)');

  if (two) {
    // 14 remove_member m2 (legacy entry; m1 runs as the same user).
    const rm = await mcpCall(home, 'remove_member', { member_name: mname('m2') }, id(14));
    rec(id(14), `remove_member ${mname('m2')}`, rm.ok ? 0 : 1, one(rm.text).slice(0, 240) || rm.error);

    // 15 m1 and the operator are untouched by that removal.
    const f1b = await exec(home, mname('m1'), fillCmd, id(15));
    const p1b = passwordOf(f1b.text);
    const op2 = operatorHelpers(env);
    const vals = getAll(env, KEY);
    const ok15 = f1b.code === 0 && p1b === tok('m1', 'new') && op2 === opBefore && vals.some(isFleetValue) && fs.existsSync(legacyPath);
    rec(id(15), `after remove_member: ${mname('m1')} fill; operator helpers; ${KEY}`, ok15 ? 0 : 1,
      `m1 password=${p1b || '(none)'}; operator helpers ${op2 === opBefore ? 'identical' : 'CHANGED'}`,
      `values: ${vals.map(v => JSON.stringify(v)).join(', ')}; legacy file ${fs.existsSync(legacyPath) ? 'present' : 'gone'}`);
  }

  if (!viaInstall) await stopServer(pid);
  log(`scenario ${p} done`);
  return pid;
}

// Not under the box user's home: on docker that home itself has an apostrophe and a space.
const homesRoot = IS_WIN ? 'C:\\fi\\homes' : path.join(os.tmpdir(), 'fi-homes');
const scenarios = [
  { p: 'CS', name: 'one member, plain home', home: path.join(homesRoot, 'plain-solo'), two: false },
  { p: 'CP', name: 'two members, plain home', home: path.join(homesRoot, 'plain-pair'), two: true },
  { p: 'CQ', name: 'two members, home with an apostrophe and a space', home: path.join(homesRoot, "fi o'brien-pair"), two: true },
  { p: 'CR', name: 'one member, home with an apostrophe and a space', home: path.join(homesRoot, "fi o'brien-solo"), two: false },
  { p: 'CW', name: 'two members, home with a space', home: path.join(homesRoot, 'fi john smith-pair'), two: true },
  { p: 'CX', name: 'one member, home with a space', home: path.join(homesRoot, 'fi john smith-solo'), two: false },
  // Last: the installer's service (CN) keeps running when the pass ends.
  { p: 'CN', name: 'two members, real home, installer', home: os.homedir(), two: true, viaInstall: true },
];
const only = opt('--only');
for (const sc of scenarios) {
  if (only && !only.split(',').includes(sc.p)) continue;
  try { await scenario(sc); } catch (e) { log(`scenario ${sc.p} crashed: ${e.stack ?? e.message}`); }
}
log('pass C scenarios done');
