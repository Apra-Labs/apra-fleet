#!/usr/bin/env node
// Member-host upgrade harness driver.
//
//   node tests/integration/member-host/run.mjs --plan
//       List the passes and their expected outcomes. No VM changes, no network.
//   node tests/integration/member-host/run.mjs --binary <candidate installer>
//        --setup-info <info.json> --i-am-disposable [--passes Q,RF,RB,RFS,RBS] [--out <dir>]
//       Run the passes against the localhost OpenSSH + Git Bash member host that
//       setup-openssh-gitbash.ps1 prepared (Windows, CI=true, disposable only).
//
// Passes: Q (quote-led commands), RF (replace-full from the latest release),
// RB (forced rollback), RFS / RBS (same, with a supervisor running: must refuse
// with E-FLEET-SE-RUNNING and change nothing, then succeed once it is stopped).
// Every spawned process gets HOME / USERPROFILE / GIT_CONFIG_GLOBAL pointed at
// a temp sandbox (lib/sandbox.mjs); nothing is written outside it except the
// --out directory. Exit: 0 PASS, 1 FAIL, 2 usage/refusal, 3 INCONCLUSIVE
// (stale or missing release baseline). ASCII only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPOSABLE_FLAG, disposableRefusal } from './lib/opt-in.mjs';
import { QUOTE_LED_CASES, verifyEcho, memberWorkFolder } from './lib/commands.mjs';
import { PASS_IDS, REFUSAL_CODE, compareSnapshots, planPasses, resolveBaseline } from './lib/scenarios.mjs';
import { assertInside, resolveSandbox, sandboxEnv } from './lib/sandbox.mjs';
import { buildReport } from './lib/report.mjs';
import { resolveLatestRelease, releaseAssetUrl } from '../fresh-install/lib/baseline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`Usage: node tests/integration/member-host/run.mjs --plan | --binary <installer> --setup-info <info.json> ${DISPOSABLE_FLAG} [--passes ${PASS_IDS.join(',')}] [--out <dir>]`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { passes: PASS_IDS.join(',') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    switch (a) {
      case '--plan': o.plan = true; break;
      case '--binary': o.binary = val(); break;
      case '--setup-info': o.setupInfo = val(); break;
      case DISPOSABLE_FLAG: o.disposable = true; break;
      case '--passes': o.passes = val(); break;
      case '--out': o.out = val(); break;
      case '-h': case '--help': usage(); break;
      default: usage(`unknown argument ${a}`);
    }
  }
  o.passList = o.passes.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  for (const p of o.passList) if (!PASS_IDS.includes(p)) usage(`unknown pass ${p}`);
  return o;
}

const sha256Buf = b => crypto.createHash('sha256').update(b).digest('hex');
const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------------------
// Real run (CI only). Everything below talks to the disposable member host.
// ---------------------------------------------------------------------------
async function realRun(o) {
  const refusal = disposableRefusal({ env: process.env, optInFlag: !!o.disposable, platform: process.platform, needWindows: true });
  if (refusal) { console.error(refusal); process.exit(2); }
  if (!o.binary || !fs.existsSync(o.binary)) usage('--binary must point to an existing installer');
  if (!o.setupInfo || !fs.existsSync(o.setupInfo)) usage('--setup-info must point to the file setup-openssh-gitbash.ps1 wrote');
  const info = JSON.parse(fs.readFileSync(o.setupInfo, 'utf8'));

  const sb = resolveSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'member-host-')));
  const outDir = path.resolve(o.out ?? sb.out);
  for (const d of [sb.home, sb.tmp, sb.keyDir, sb.cache, sb.argsDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(sb.gitConfigGlobal, '');
  fs.mkdirSync(outDir, { recursive: true });
  const env = sandboxEnv(process.env, sb);
  const startedAt = new Date().toISOString();
  const notes = [`sandbox root: ${sb.root} (HOME/USERPROFILE/GIT_CONFIG_GLOBAL point inside it)`];

  const pins = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fresh-install', 'pins.json'), 'utf8'));
  const latest = await resolveLatestRelease('Apra-Labs/apra-fleet');
  const baseline = resolveBaseline({ pins, platform: 'windows', latestTag: latest.tag, lookupError: latest.error });
  const inconclusive = [...baseline.reasons];
  if (baseline.tag) notes.push(`baseline: ${baseline.tag} (latest release: ${latest.tag ?? 'unresolved'})`);

  const recordsByPass = {};
  const driverErrors = {};
  const rec = (pass, id, cmd, exit, keyline = '', observed = '') => {
    (recordsByPass[pass] ??= []).push({ pass, id, cmd, exit, keyline, observed: String(observed).slice(0, 400) });
  };

  // --- orchestrator: the candidate installed into the sandbox HOME ----------
  const cand = path.resolve(o.binary);
  const run = (cmd, args, opts = {}) => {
    assertInside(sb, opts.cwd ?? sb.root);
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, cwd: sb.root, timeout: opts.timeoutMs ?? 600000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.error ? `ERR ${r.error.message}` : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const inst = run(cand, ['install', '--workflows', 'none']);
  notes.push(`candidate install exit ${inst.code}`);
  const orchBin = path.join(sb.home, '.apra-fleet', 'bin', 'apra-fleet.exe');
  const candVersion = (/v\d+\.\d+\.\d+_[0-9a-f]+/.exec(run(cand, ['--version']).out) ?? [null])[0];

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'member-host-harness', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: orchBin, args: [], env }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
    return { isError: !!r.isError, text };
  };

  const reg = await call('register_member', {
    friendly_name: 'member-host', member_type: 'remote', host: '127.0.0.1', port: info.port ?? 22,
    username: info.user, auth_type: 'key', key_path: info.keyPath, work_folder: memberWorkFolder(info), llm_provider: 'none',
  });
  const idMatch = /([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(reg.text);
  if (reg.isError || !idMatch) throw new Error(`register_member failed: ${reg.text.slice(0, 300)}`);
  const memberId = idMatch[1];
  const exec = (command, timeout_s = 300) => call('execute_command', { member_id: memberId, command, timeout_s });

  // --- member-side helpers (bash on the member; commands travel via the
  // orchestrator's base64+eval wrapper, which is what these passes exercise) --
  const MH = '$HOME/.apra-fleet';
  const snapshot = async () => {
    const r = await exec(`printf 'V=%s\\n' "$(${MH}/bin/apra-fleet.exe --version 2>&1 | head -1)"; printf 'K=%s\\n' "$(sha256sum ${MH}/fleet.key 2>/dev/null | cut -d' ' -f1)"; ls -1 ${MH}/data 2>/dev/null | sed 's/^/D=/'`);
    const lines = r.text.split(/\r?\n/);
    const pick = p => lines.filter(l => l.startsWith(p)).map(l => l.slice(p.length));
    return { binaryVersion: pick('V=')[0] ?? '', fleetKeySha256: pick('K=')[0] ?? '', dataListing: pick('D=') };
  };
  const installBaselineOnMember = async pass => {
    const url = releaseAssetUrl(baseline.repo ?? 'Apra-Labs/apra-fleet', baseline.tag, baseline.asset);
    const local = path.join(sb.cache, baseline.asset);
    if (!fs.existsSync(local)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (baseline.sha256 && sha256Buf(buf) !== baseline.sha256) throw new Error(`sha256 mismatch for ${url}`);
      fs.writeFileSync(local, buf);
    }
    const sshOpts = ['-i', info.keyPath, '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(sb.keyDir, 'known_hosts')}`, '-o', 'IdentitiesOnly=yes'];
    const put = run('scp', [...sshOpts, local, `${info.user}@127.0.0.1:baseline-installer.exe`]);
    const r = put.code === 0 ? await exec(`chmod +x "$HOME/baseline-installer.exe" && "$HOME/baseline-installer.exe" install --workflows none`, 600) : { isError: true, text: put.out };
    rec(pass, `${pass.toLowerCase()}-baseline-installed`, 'baseline install --workflows none', r.isError ? 1 : 0, '', r.text.slice(-200));
  };
  const startSupervisor = async pass => {
    const r = await exec(`nohup node "$HOME/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs" > "$HOME/supervisor.log" 2>&1 & sleep 8; "${MH}/bin/apra-fleet.exe" fleet-se-check`, 60);
    rec(pass, `${pass.toLowerCase()}-supervisor-started`, 'start fleet-sprint supervisor', /FLEET_SE supervisor/.test(r.text) ? 0 : 1, '', r.text.slice(-200));
  };
  const stopSupervisor = async pass => {
    const r = await exec(`curl -s -X POST http://localhost:8787/api/shutdown -H "Content-Type: application/json" -d "{}"; sleep 5; "${MH}/bin/apra-fleet.exe" fleet-se-check`, 60);
    rec(pass, `${pass.toLowerCase()}-supervisor-stopped`, 'POST /api/shutdown', /FLEET_SE supervisor/.test(r.text) ? 1 : 0, '', r.text.slice(-200));
  };
  const replaceFull = () => call('update_member', { member_id: memberId, fleet_install: 'replace-full' });
  const refusalStep = (pass, id, r, before, after) => {
    const code = r.text.includes(REFUSAL_CODE) ? REFUSAL_CODE : 'NOT-REFUSED';
    rec(pass, `${id}-refused`, 'refusal under a running supervisor', 0, code, r.text.slice(0, 200));
    const cmp = compareSnapshots(before, after);
    rec(pass, `${id}-unchanged`, 'snapshot compare', 0, cmp.unchanged ? 'UNCHANGED' : 'CHANGED', cmp.diffs.join('; '));
  };
  const rollbackCmd = `B="$HOME/.apra-fleet-data.full-install.bak"; "$HOME/.apra-fleet/bin/apra-fleet.exe" uninstall --force --yes; rm -rf "${MH}/data"; cp -R "$B/data" "${MH}/data" 2>/dev/null || cp -R "$B" "${MH}/data"; cp "$B/fleet.key" "${MH}/fleet.key"; "$B/apra-fleet.exe" install --llm none --force`;

  const passes = o.passList;
  for (const pass of passes) {
    try {
      log(`pass ${pass}`);
      if (pass === 'Q') {
        for (const c of QUOTE_LED_CASES) {
          const r = await exec(c.command, 60);
          const v = verifyEcho(c, r.text);
          rec('Q', `q-${c.id}`, c.command, r.isError ? 1 : 0, v.ok ? 'MATCH' : 'MISMATCH', `expected ${JSON.stringify(v.expected)} got ${JSON.stringify(v.got)}`);
        }
      } else if (pass === 'RF' || pass === 'RFS') {
        if (!baseline.tag || !baseline.asset) throw new Error('no usable release baseline');
        await installBaselineOnMember(pass);
        const pre = await snapshot();
        if (pass === 'RFS') {
          await startSupervisor('RFS');
          const refused = await replaceFull();
          refusalStep('RFS', 'rfs', refused, pre, await snapshot());
          await stopSupervisor('RFS');
        }
        const r = await replaceFull();
        rec(pass, pass === 'RF' ? 'rf-replace' : 'rfs-replace', 'update_member fleet_install replace-full', r.isError ? 1 : 0, '', r.text.slice(-200));
        if (pass === 'RF') {
          const v = await exec(`"${MH}/bin/apra-fleet.exe" --version`);
          rec('RF', 'rf-version', 'member --version', 0, candVersion && v.text.includes(candVersion) ? 'MATCH' : 'MISMATCH', v.text.slice(0, 120));
          const m = await exec(`test -f "${MH}/data/member-install.json" && echo present`);
          rec('RF', 'rf-marker', 'member-install.json', /present/.test(m.text) ? 0 : 1, '', m.text.slice(0, 80));
          const t = await exec(`"${MH}/bin/apra-fleet.exe" call --member ${memberId} --list-tools`);
          const ok = /kb_/.test(t.text) && /code_/.test(t.text) && !/execute_|register_|credential_/.test(t.text);
          rec('RF', 'rf-tools', 'call --list-tools', 0, ok ? 'TOOLS-OK' : 'TOOLS-WRONG', t.text.slice(0, 200));
        }
      } else if (pass === 'RB' || pass === 'RBS') {
        const pre = await snapshot();
        if (pass === 'RBS') {
          await startSupervisor('RBS');
          const refused = await exec(rollbackCmd, 300);
          refusalStep('RBS', 'rbs', refused, pre, await snapshot());
          await stopSupervisor('RBS');
        }
        const r = await exec(rollbackCmd, 600);
        const post = await snapshot();
        rec(pass, pass === 'RB' ? 'rb-rollback' : 'rbs-rollback', 'documented Rollback steps', r.isError ? 1 : 0, '', r.text.slice(-200));
        const relVersion = baseline.tag.replace(/^v/, '');
        const vOk = post.binaryVersion.includes(relVersion);
        rec(pass, pass === 'RB' ? 'rb-version' : 'rbs-version', 'member --version', 0, vOk ? 'MATCH' : 'MISMATCH', post.binaryVersion);
        if (pass === 'RB') {
          rec('RB', 'rb-data', 'data dir listing', 0, post.dataListing.length ? 'MATCH' : 'MISMATCH', post.dataListing.join(','));
          rec('RB', 'rb-key', 'fleet.key hash', 0, post.fleetKeySha256 ? 'MATCH' : 'MISMATCH', post.fleetKeySha256);
        }
      }
    } catch (e) {
      driverErrors[pass] = e.message;
    }
  }
  await client.close();

  const report = buildReport({
    passIds: passes, recordsByPass, driverErrors, inconclusive,
    candidate: { path: cand, sha256: sha256Buf(fs.readFileSync(cand)) }, baselineTag: baseline.tag,
    startedAt, finishedAt: new Date().toISOString(), notes,
  });
  fs.writeFileSync(path.join(outDir, 'report.md'), report.markdown);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ final: report.final, passes: report.passResults, records: recordsByPass }, null, 2));
  console.log(report.markdown);
  process.exit(report.final.exitCode);
}

const o = parseArgs(process.argv.slice(2));
if (o.plan) {
  console.log(JSON.stringify({ passes: planPasses(o.passList) }, null, 2));
} else {
  realRun(o).catch(e => { console.error(`DRIVER-ERROR: ${e.message}`); process.exit(2); });
}
