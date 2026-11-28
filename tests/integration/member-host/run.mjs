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
// RB (forced rollback), RFS (replace-full refuses while a sprint runs and
// changes nothing, then stops the idle supervisor itself and replaces), RBS
// (the rollback's guarded reinstall refuses with E-FLEET-SE-RUNNING under a
// supervisor and changes nothing, then the rollback succeeds once it is
// stopped). Every spawned process gets HOME / USERPROFILE / GIT_CONFIG_GLOBAL
// pointed at a temp sandbox (lib/sandbox.mjs); nothing is written outside it
// except the --out directory. Exit: 0 PASS, 1 FAIL, 2 usage/refusal, 3
// INCONCLUSIVE (stale or missing release baseline). ASCII only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPOSABLE_FLAG, disposableRefusal } from './lib/opt-in.mjs';
import {
  QUOTE_LED_CASES, verifyEcho, memberWorkFolder, baselineInstallArgs, supervisorStartCommand, supervisorStartOutcome,
  CHECK_BIN, NODE_PATH_COMMAND, SUPERVISOR_COPY_DIR, detachedLaunchCommand, launchedPid, standInSprintCommandLine,
  sprintLockCommand, sprintStopCommand, fleetSeCheckCommand, waitSupervisorUpCommand, supervisorStopCommand,
  parseFleetSe, idleSupervisorStoppedNote, launchFailureLine, serviceDiagCommand, cimProbeCommand, diagLine,
  supervisorCopyCommand, supervisorDiagCommand, gitBashPath,
} from './lib/commands.mjs';
import {
  PASS_IDS, REFUSAL_CODE, compareSnapshots, planPasses, resolveBaseline, toolListKeyline, namedServerLog, serverLogCrashed, taskRunState,
  SERVER_NOT_STARTED, SERVER_CRASHED,
} from './lib/scenarios.mjs';
import { assertInside, resolveSandbox, sandboxEnv } from './lib/sandbox.mjs';
import { MEMBER_PROVIDER, guardedReinstallCommand, listBackupsCommand, pickNewestBackup, restoreChecks, rollbackCommand, rollbackSucceeded } from './lib/rollback.mjs';
import { toolResult, execOutcome } from './lib/mcp-result.mjs';
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
const tail = (s, n = 200) => String(s ?? '').trim().slice(-n);

// ---------------------------------------------------------------------------
// Real run (CI only). Everything below talks to the disposable member host.
// ---------------------------------------------------------------------------
async function realRun(o) {
  const refusal = disposableRefusal({ env: process.env, optInFlag: !!o.disposable, platform: process.platform, needWindows: true });
  if (refusal) { console.error(refusal); process.exit(2); }
  if (!o.binary || !fs.existsSync(o.binary)) usage('--binary must point to an existing installer');
  if (!o.setupInfo || !fs.existsSync(o.setupInfo)) usage('--setup-info must point to the file setup-openssh-gitbash.ps1 wrote');
  const info = JSON.parse(fs.readFileSync(o.setupInfo, 'utf8'));
  if (!info.home) usage('the setup info has no member home (setup-openssh-gitbash.ps1 writes it)');

  const sb = resolveSandbox(fs.mkdtempSync(path.join(os.tmpdir(), 'member-host-')));
  const outDir = path.resolve(o.out ?? sb.out);
  for (const d of [sb.home, sb.tmp, sb.keyDir, sb.cache, sb.argsDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(sb.gitConfigGlobal, '');
  fs.mkdirSync(outDir, { recursive: true });
  const env = sandboxEnv(process.env, sb);
  const startedAt = new Date().toISOString();
  const notes = [`sandbox root: ${sb.root} (HOME/USERPROFILE/GIT_CONFIG_GLOBAL point inside it); orchestrator port ${env.APRA_FLEET_PORT}`];

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
  // --transport stdio: the driver talks to the orchestrator over stdio, so it
  // needs no service. An http install registers a per-user service that
  // starts in the runner user's REAL environment (not this sandbox's
  // APRA_FLEET_PORT / data dir) and binds the default 7523, which the
  // member -- another user on this host -- then cannot use.
  const inst = run(cand, ['install', '--workflows', 'none', '--transport', 'stdio']);
  notes.push(`candidate install exit ${inst.code}`);
  if (inst.code !== 0) throw new Error(`the candidate install on the orchestrator failed (exit ${inst.code}): ${tail(inst.out, 400)}`);
  const orchBin = path.join(sb.home, '.apra-fleet', 'bin', 'apra-fleet.exe');
  const candVersion = (/v\d+\.\d+\.\d+_[0-9a-f]+/.exec(run(cand, ['--version']).out) ?? [null])[0];
  notes.push(`candidate version: ${candVersion ?? 'unresolved'}`);
  // Who listens on the default port before any member install (should be nobody).
  const listen = run('netstat', ['-ano', '-p', 'TCP']);
  notes.push(`listeners on :7523 before the passes: ${String(listen.out).split(/\r?\n/).filter(l => /:7523\s/.test(l) && /LISTENING/.test(l)).map(l => l.trim()).join(' ; ') || 'none'}`);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'member-host-harness', version: '1.0.0' });
  // Same args install writes into the MCP config. A SEA binary run with no
  // args is the installer, not the MCP server.
  await client.connect(new StdioClientTransport({ command: orchBin, args: ['run', '--transport', 'stdio'], env }));
  const call = async (name, args) => toolResult(await client.callTool({ name, arguments: args }, undefined, { timeout: 1800000 }));

  // claude: a member install is made only for claude / opencode members (an
  // llm_provider none member gets none, so replace-full would have nothing to
  // do). fleet_install skip: the passes put the release baseline on the member
  // first; replace-full then replaces it.
  const reg = await call('register_member', {
    friendly_name: 'member-host', member_type: 'remote', host: '127.0.0.1', port: info.port ?? 22,
    username: info.user, auth_type: 'key', key_path: info.keyPath, work_folder: memberWorkFolder(info), llm_provider: MEMBER_PROVIDER,
    fleet_install: 'skip', vcs_provider: 'none',
  });
  const idMatch = /([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(reg.text);
  if (reg.isError || !idMatch) throw new Error(`register_member failed: ${reg.text.slice(0, 300)}`);
  const memberId = idMatch[1];
  /** { exitCode, stdout, stderr, failure, text } of a member command. */
  const exec = async (command, timeout_s = 300) => {
    const r = await call('execute_command', { member_id: memberId, command, timeout_s });
    return { ...execOutcome(r), text: r.text };
  };
  const out = x => `${x.stdout}${x.stderr ? `\n[stderr]\n${x.stderr}` : ''}`;

  // --- member-side helpers (bash on the member; commands travel via the
  // orchestrator's base64+eval wrapper, which is what these passes exercise) --
  const MH = '$HOME/.apra-fleet';
  const snapshot = async () => {
    const r = await exec(`printf 'V=%s\\n' "$(${MH}/bin/apra-fleet.exe --version 2>&1 | head -1)"; printf 'K=%s\\n' "$(sha256sum ${MH}/fleet.key 2>/dev/null | cut -d' ' -f1)"; ls -1 ${MH}/data 2>/dev/null | sed 's/^/D=/'`);
    if (r.exitCode !== 0) throw new Error(`snapshot command failed (${r.failure ?? `exit ${r.exitCode}`}): ${tail(out(r))}`);
    const lines = r.stdout.split(/\r?\n/);
    const pick = p => lines.filter(l => l.startsWith(p)).map(l => l.slice(p.length));
    return { binaryVersion: pick('V=')[0] ?? '', fleetKeySha256: pick('K=')[0] ?? '', dataListing: pick('D=') };
  };
  const sshOpts = ['-i', info.keyPath, '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(sb.keyDir, 'known_hosts')}`, '-o', 'IdentitiesOnly=yes'];
  const putHome = (local, name) => run('scp', [...sshOpts, local, `${info.user}@127.0.0.1:${name}`]);
  // The candidate's own fleet-se-check (the install guard's detection) is the
  // version-independent supervisor/sprint probe: the release baseline binary
  // predates that verb.
  const putCheck = putHome(cand, CHECK_BIN);
  if (putCheck.code !== 0) throw new Error(`copying the candidate to the member failed: ${tail(putCheck.out)}`);
  const nodePath = await exec(NODE_PATH_COMMAND, 30);
  const memberNode = nodePath.exitCode === 0 ? nodePath.stdout.trim().split(/\r?\n/).pop() : '';
  notes.push(`member node: ${memberNode || `unresolved (${tail(out(nodePath), 120)})`}`);

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
    const put = putHome(local, 'baseline-installer.exe');
    // --force: RFS installs over RB's restored install, which may have left a
    // server running (the refusal's own remedy). No supervisor runs yet.
    const installArgs = ['install', ...baselineInstallArgs(pass), '--force'].join(' ');
    const r = put.code === 0
      ? await exec(`chmod +x "$HOME/baseline-installer.exe" && "$HOME/baseline-installer.exe" ${installArgs}`, 600)
      : { exitCode: 1, stdout: '', stderr: put.out };
    rec(pass, `${pass.toLowerCase()}-baseline-installed`, `baseline ${installArgs}`, r.exitCode, '', tail(out(r)));
  };
  const fleetSe = async () => {
    const r = await exec(fleetSeCheckCommand(), 60);
    return { r, found: parseFleetSe(r.stdout) };
  };
  const startSupervisor = async (pass, fromCopy = false) => {
    const lc = pass.toLowerCase();
    if (!memberNode) { rec(pass, `${lc}-supervisor-started`, 'start fleet-sprint supervisor', 1, '', 'node not found on the member'); return false; }
    const launch = await exec(supervisorStartCommand({ node: memberNode, home: info.home, fromCopy }), 60);
    // Checked in a LATER session: the supervisor must outlive the launching one.
    const check = launchedPid(launch.stdout) ? await exec(waitSupervisorUpCommand(), 180) : { stdout: '' };
    const o2 = supervisorStartOutcome(out(launch), check.stdout);
    if (o2.exit !== 0) {
      // In the notes, not `observed` (cut to 400 chars, 240 in the table).
      const d = await exec(supervisorDiagCommand(launchedPid(launch.stdout)), 60);
      notes.push(`${pass}: supervisor not seen; launch said: ${launchFailureLine(out(launch))} || ${diagLine(out(d), 1200)}`);
      o2.observed += ' | diagnostics in the report notes';
    }
    rec(pass, `${lc}-supervisor-started`, `start fleet-sprint supervisor${fromCopy ? ` from ~/${SUPERVISOR_COPY_DIR}` : ''}`, o2.exit, '', o2.observed);
    return o2.exit === 0;
  };
  const stopSupervisor = async pass => {
    const r = await exec(supervisorStopCommand(), 120);
    const found = parseFleetSe(r.stdout);
    rec(pass, `${pass.toLowerCase()}-supervisor-stopped`, 'POST /api/shutdown, wait for /api/health to stop answering', found.ok && !found.supervisor ? 0 : 1, '', tail(out(r)));
  };
  const replaceFull = () => call('update_member', { member_id: memberId, fleet_install: 'replace-full' });
  // A step whose precondition failed is recorded FAIL and NOT run: running it
  // anyway (a replace-full or reinstall that was meant to be refused) changes
  // the member and wrecks every later step's baseline.
  const skipped = (pass, id, cmd, precondition) => rec(pass, id, cmd, 1, 'SKIPPED', `not run: precondition ${precondition} failed`);
  // Report-note diagnostics (never a verdict): why the member's HTTP service
  // is or is not answering.
  const serviceDiag = async label => {
    const d = await exec(serviceDiagCommand(), 60);
    const st = await exec(`"${MH}/bin/apra-fleet.exe" status 2>&1 | head -20; ls -1 ${MH}/data/*.log ${MH}/data/logs 2>&1 | head -5`, 60);
    notes.push(`service diag (${label}): ${diagLine(d.stdout)} || status: ${diagLine(out(st), 400)}`);
  };
  const unchangedStep = (pass, id, before, after) => {
    const cmp = compareSnapshots(before, after);
    rec(pass, `${id}-unchanged`, 'snapshot compare', 0, cmp.unchanged ? 'UNCHANGED' : 'CHANGED', cmp.diffs.join('; '));
  };
  // The snapshot taken right before each successful replace-full (after the
  // release baseline was installed): RB checks its rollback against RF's, RBS
  // against RFS's -- equality, not mere presence.
  const preReplaceBy = {};
  const findBackup = async (pass) => {
    const cmd = listBackupsCommand();
    const r = await exec(cmd, 60);
    const backup = pickNewestBackup(r.stdout);
    rec(pass, `${pass.toLowerCase()}-backup`, cmd, backup ? 0 : 1, '', backup ?? tail(out(r)));
    if (!backup) throw new Error('no replace-full backup found on the member; the rollback has nothing to restore from');
    return backup;
  };
  const versionStep = async (pass) => {
    const v = await exec(`"${MH}/bin/apra-fleet.exe" --version`);
    rec(pass, `${pass.toLowerCase()}-version`, 'member --version', v.exitCode, candVersion && v.stdout.includes(candVersion) ? 'MATCH' : 'MISMATCH', `expected ${candVersion} in: ${tail(out(v), 120)}`);
  };

  const passes = o.passList;
  for (const pass of passes) {
    try {
      log(`pass ${pass}`);
      if (pass === 'Q') {
        for (const c of QUOTE_LED_CASES) {
          const r = await exec(c.command, 60);
          const v = verifyEcho(c, r.stdout);
          rec('Q', `q-${c.id}`, c.command, r.exitCode, v.ok ? 'MATCH' : 'MISMATCH', `expected ${JSON.stringify(v.expected)} got ${JSON.stringify(v.got)}${r.failure ? ` (${r.failure})` : ''}`);
        }
      } else if (pass === 'RF') {
        if (!baseline.tag || !baseline.asset) throw new Error('no usable release baseline');
        await installBaselineOnMember(pass);
        await serviceDiag('RF, after the release install');
        const pre = await snapshot();
        preReplaceBy[pass] = pre;
        const r = await replaceFull();
        rec(pass, 'rf-replace', 'update_member fleet_install replace-full', r.isError ? 1 : 0, '', r.text.slice(0, 300));
        await versionStep('RF');
        const m = await exec(`test -f "${MH}/data/member-install.json" && echo present`);
        rec('RF', 'rf-marker', 'member-install.json', /present/.test(m.stdout) ? m.exitCode : 1, '', tail(out(m), 80));
        const t = await exec(`"${MH}/bin/apra-fleet.exe" call --member ${memberId} --list-tools`);
        // Classified from the FULL output: the recorded tail cuts the error code off.
        let toolsKey = toolListKeyline(t.exitCode, t.exitCode === 0 ? t.stdout : out(t), candVersion);
        if (toolsKey === SERVER_NOT_STARTED) {
          // The signature alone cannot tell the gap from a member server that
          // crashed on start. The gap means the task never ran its action, so:
          // the task's Last Result must be a never-ran code (a run that ended
          // or is still running is not the gap), and neither the log the error
          // names (the newest fleet-<pid>.log of ANY process, often the start
          // CLI's own) nor data/fleet.log (where the task wrapper appends the
          // server's stderr) may show a crash. A crash is never excused.
          const sd = await exec(serviceDiagCommand(), 60);
          const task = taskRunState(sd.stdout);
          const named = namedServerLog(out(t));
          const logs = [named ? gitBashPath(named) : null, `${MH}/data/fleet.log`].filter(Boolean);
          const l = await exec(logs.map(f => `echo "== ${f}"; tail -n 200 "${f}" 2>&1`).join('; ') + '; exit 0', 60);
          const crashed = l.exitCode !== 0 || serverLogCrashed(l.stdout);
          if (crashed || task.state === 'exited' || task.state === 'running') toolsKey = SERVER_CRASHED;
          const lt = await exec(logs.map(f => `echo "== ${f}"; tail -n 12 "${f}" 2>&1`).join('; ') + '; exit 0', 60);
          notes.push(`RF rf-tools ${toolsKey}: task Last Result ${task.code ?? 'unreadable'} (${task.state}); crash in the logs: ${crashed ? 'yes' : 'no'}`);
          notes.push(`service diag (RF, after the candidate member install): ${diagLine(sd.stdout)}`);
          notes.push(`RF rf-tools server logs (last lines): ${diagLine(out(lt), 2500)}`);
        }
        rec('RF', 'rf-tools', 'call --list-tools', t.exitCode, toolsKey, tail(out(t)));
        // The gap path above already recorded the service diag.
        if (toolsKey === 'TOOLS-WRONG') await serviceDiag('RF, after the candidate member install');
      } else if (pass === 'RFS') {
        if (!baseline.tag || !baseline.asset) throw new Error('no usable release baseline');
        await installBaselineOnMember(pass);
        // Copy the release's fleet-sprint runtime aside FIRST, while the full
        // install is certainly there: RBS starts its supervisor from the copy.
        // workflows/ AND node_modules/: serve.mjs imports bare packages that
        // resolve only from a node_modules/ next to workflows/.
        const cp = await exec(supervisorCopyCommand(MH), 300);
        rec('RFS', 'rfs-workflows-copied', `copy ${MH}/{workflows,node_modules} to ~/${SUPERVISOR_COPY_DIR}`, /copied/.test(cp.stdout) ? cp.exitCode : 1, '', tail(out(cp)));
        await startSupervisor('RFS');
        // A running sprint: a stand-in process holding a sprint lock, which is
        // what the install guard's detection counts (no LLM needed).
        let sprintPid = null;
        let sprintSeen = false;
        if (memberNode) {
          const l = await exec(detachedLaunchCommand(standInSprintCommandLine({ node: memberNode }), info.home), 60);
          sprintPid = launchedPid(l.stdout);
          if (sprintPid) {
            const w = await exec(sprintLockCommand(sprintPid), 60);
            const f = parseFleetSe(w.stdout);
            sprintSeen = f.sprints.includes(sprintPid);
            rec('RFS', 'rfs-sprint-started', 'stand-in sprint + lock, fleet-se-check', sprintSeen ? 0 : 1, '', tail(out(w)));
            if (!sprintSeen) {
              // What the guard's command-line probe (Get-CimInstance) gets in this session.
              const c = await exec(cimProbeCommand(sprintPid), 60);
              notes.push(`RFS: install-guard command-line probe for the stand-in sprint pid ${sprintPid}: ${diagLine(c.stdout)}`);
            }
          } else {
            rec('RFS', 'rfs-sprint-started', 'stand-in sprint launch', 1, '', launchFailureLine(out(l)));
          }
        }
        if (sprintSeen) {
          // Taken with everything running, right before the refused attempt.
          const before = await snapshot();
          const refused = await replaceFull();
          const reason = refused.isError ? String(refused.structured?.reason ?? 'NO-REASON') : 'NOT-REFUSED';
          rec('RFS', 'rfs-refused', 'update_member replace-full under a running sprint', 0, reason, refused.text.slice(0, 300));
          unchangedStep('RFS', 'rfs', before, await snapshot());
        } else {
          skipped('RFS', 'rfs-refused', 'update_member replace-full under a running sprint', 'rfs-sprint-started');
          skipped('RFS', 'rfs-unchanged', 'snapshot compare', 'rfs-sprint-started');
        }
        if (sprintPid) {
          const s = await exec(sprintStopCommand(sprintPid), 60);
          const f = parseFleetSe(s.stdout);
          rec('RFS', 'rfs-sprint-stopped', 'end the stand-in sprint', f.ok && f.sprints.length === 0 && f.supervisor ? 0 : 1, '', tail(out(s)));
        }
        const pre = await snapshot();
        preReplaceBy[pass] = pre;
        const r = await replaceFull();
        rec('RFS', 'rfs-replace', 'update_member replace-full with the idle supervisor running', r.isError ? 1 : 0, idleSupervisorStoppedNote(r.text) ? 'IDLE-SUPERVISOR-STOPPED' : 'NO-STOP-NOTE', r.text.slice(0, 300));
        const gone = await fleetSe();
        rec('RFS', 'rfs-supervisor-gone', 'fleet-se-check after the replacement', gone.found.ok && !gone.found.supervisor ? 0 : 1, '', tail(out(gone.r)));
        await versionStep('RFS');
      } else if (pass === 'RB' || pass === 'RBS') {
        const lc = pass.toLowerCase();
        const backup = await findBackup(pass);
        if (pass === 'RBS') {
          // The refusal attempt runs ONLY the guarded step (the backup binary's
          // reinstall): the uninstall and data restore that precede it in the
          // full rollback are not guarded and would destroy state. The
          // supervisor runs from RFS's copy of the release's fleet-sprint (the
          // member install has none).
          const probe = guardedReinstallCommand(backup);
          if (await startSupervisor('RBS', true)) {
            const pre = await snapshot();
            const refused = await exec(probe, 300);
            rec('RBS', 'rbs-refused', probe, 0, out(refused).includes(REFUSAL_CODE) ? REFUSAL_CODE : 'NOT-REFUSED', tail(out(refused), 300));
            unchangedStep('RBS', 'rbs', pre, await snapshot());
          } else {
            skipped('RBS', 'rbs-refused', probe, 'rbs-supervisor-started');
            skipped('RBS', 'rbs-unchanged', 'snapshot compare', 'rbs-supervisor-started');
          }
          await stopSupervisor('RBS');
        }
        const cmd = rollbackCommand(backup);
        const r = await exec(cmd, 600);
        rec(pass, `${lc}-rollback`, cmd, rollbackSucceeded({ isError: r.exitCode !== 0, text: r.stdout }) ? 0 : 1, '', tail(out(r), 300));
        const post = await snapshot();
        const checks = restoreChecks({ preReplace: preReplaceBy[pass === 'RB' ? 'RF' : 'RFS'], post, releaseVersion: baseline.tag });
        rec(pass, `${lc}-version`, 'member --version', 0, checks.version.keyline, checks.version.detail);
        rec(pass, `${lc}-data`, 'data dir listing vs before replace-full', 0, checks.data.keyline, checks.data.detail);
        rec(pass, `${lc}-key`, 'fleet.key hash vs before replace-full', 0, checks.key.keyline, checks.key.detail);
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
  // Loud in the CI run summary, even when the job is green.
  for (const g of report.knownGaps) console.log(`::warning title=member-host known gap::${g}`);
  process.exit(report.final.exitCode);
}

const o = parseArgs(process.argv.slice(2));
if (o.plan) {
  console.log(JSON.stringify({ passes: planPasses(o.passList) }, null, 2));
} else {
  realRun(o).catch(e => { console.error(`DRIVER-ERROR: ${e.message}`); process.exit(2); });
}
