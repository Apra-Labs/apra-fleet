#!/usr/bin/env node
// Fresh-install release harness entry point.
//
//   node tests/integration/fresh-install/run.mjs --binary <installer> [--platform windows|linux|macos]
//        [--driver sandbox|docker|host] [--i-am-disposable]
//        [--passes A,B,U,U2] [--informational A] [--baseline-version v0.4.3]
//        [--expect-version v0.4.4_78cefd] [--out <dir>] [--cache <dir>]
//        [--timeout-min 45] [--keep-docker] [--report-only]
//
// Drivers (default by platform: windows -> sandbox, linux -> docker, macos -> host):
//   sandbox  each pass in a fresh Windows Sandbox (windows)
//   docker   each pass in a fresh ubuntu:24.04 container (linux, no systemd)
//   host     ONE pass directly on this machine -- disposable CI VMs only;
//            refuses unless env CI=true AND --i-am-disposable (lib/host.mjs).
// The upgrade passes start from the newest pinned baseline (pins.json); when a
// newer GitHub release exists the run is INCONCLUSIVE, not PASS.
//
// Writes <out>/report.json + report.md. Exit: 0 PASS, 1 FAIL (a
// non-informational pass failed), 2 usage/refusal, 3 INCONCLUSIVE. A failed
// step never aborts the run.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePass, finalVerdict, parseResults, renderMarkdown } from './lib/verdict.mjs';
import { HOST_OPT_IN_FLAG, hostRefusal, platformOf, selectDriver } from './lib/host.mjs';
import { baselineAsset, baselineStaleness, newestBaselineTag, releaseAssetUrl, resolveLatestRelease } from './lib/baseline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOX_DIR = path.join(HERE, 'box');
const ALL_PASSES = ['A', 'B', 'U', 'U2'];
const DEFAULT_REPO = 'Apra-Labs/apra-fleet';

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`Usage: node tests/integration/fresh-install/run.mjs --binary <installer> [--platform windows|linux|macos] [--driver sandbox|docker|host] [${HOST_OPT_IN_FLAG}] [--passes A,B,U,U2] [--informational A] [--baseline-version <tag>] [--expect-version <v>] [--out <dir>] [--cache <dir>] [--timeout-min 45] [--keep-docker] [--report-only]`);
  process.exit(2);
}

function parseArgs(argv, pins) {
  const o = { passes: ALL_PASSES.join(','), informational: '', timeoutMin: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    switch (a) {
      case '--binary': o.binary = val(); break;
      case '--platform': o.platform = val(); break;
      case '--driver': o.driver = val(); break;
      case HOST_OPT_IN_FLAG: o.disposable = true; break;
      case '--passes': o.passes = val(); break;
      case '--informational': o.informational = val(); break;
      case '--baseline-version': o.baselineVersion = val(); break;
      case '--expect-version': o.expectVersion = val(); break;
      case '--out': o.out = val(); break;
      case '--cache': o.cache = val(); break;
      case '--timeout-min': o.timeoutMin = Number(val()); break;
      case '--keep-docker': o.keepDocker = true; break;
      case '--report-only': o.reportOnly = true; break;
      case '-h': case '--help': usage();
      default: usage(`unknown argument ${a}`);
    }
  }
  try {
    Object.assign(o, selectDriver({ driver: o.driver, platform: o.platform, hostPlatform: platformOf(process.platform) }));
  } catch (e) { usage(e.message); }
  if (!o.reportOnly && (!o.binary || !fs.existsSync(o.binary))) usage('--binary must point to an existing installer');
  const list = s => s.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  o.passList = list(o.passes);
  for (const p of o.passList) if (!ALL_PASSES.includes(p)) usage(`unknown pass ${p}`);
  o.informationalSet = new Set(list(o.informational));
  o.baselineVersion ??= newestBaselineTag(pins);
  o.cache = path.resolve(o.cache ?? path.join(HERE, '.cache'));
  o.out = path.resolve(o.out ?? path.join(HERE, 'results', `${o.platform}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  return o;
}

const log = m => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function sh(cmd, args, timeoutMs = 600000) {
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (!r.error || r.error.code === 'ETIMEDOUT') break;
  }
  return { code: r.error ? `ERR ${r.error.message}` : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Download url to dest; verify against `want` when pinned. Returns the file's sha256. */
async function fetchPinned(url, dest, want) {
  if (fs.existsSync(dest) && (!want || sha256(dest) === want)) return sha256(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  const got = sha256(`${dest}.part`);
  if (want && got !== want) { fs.rmSync(`${dest}.part`); throw new Error(`sha256 mismatch for ${url}: got ${got}, pinned ${want}`); }
  fs.renameSync(`${dest}.part`, dest);
  return got;
}

/** Prepare cached, checksum-verified inputs. Returns paths relative to the cache dir. */
async function prepareCache(o, pins, notes) {
  const out = {};
  const needNode = o.passList.some(p => p !== 'A');
  const needBase = o.passList.some(p => p === 'U' || p === 'U2');
  if (needNode) {
    const n = pins.node[o.platform];
    if (!n) throw new Error(`pins.json has no node entry for ${o.platform}`);
    await fetchPinned(n.url, path.join(o.cache, 'node', n.file), n.sha256);
    out.nodeRel = `node/${n.file}`; out.nodeSha = n.sha256;
  }
  if (needBase) {
    const b = pins.baselines[o.baselineVersion];
    const asset = b?.[o.platform]?.asset ?? baselineAsset(o.platform);
    const want = b?.[o.platform]?.sha256;
    const url = releaseAssetUrl(b?.repo ?? DEFAULT_REPO, o.baselineVersion, asset);
    const got = await fetchPinned(url, path.join(o.cache, 'baseline', o.baselineVersion, asset), want);
    if (!want) notes.push(`Baseline ${o.baselineVersion} (${o.platform}) is not pinned in pins.json; used unverified sha256 ${got}.`);
    out.baseRel = `baseline/${o.baselineVersion}/${asset}`;
  }
  return out;
}

function runWindowsSandboxPass(o, pass, inputs, outDir) {
  const needBase = pass === 'U' || pass === 'U2';
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'drivers', 'windows-sandbox.ps1'),
    '-Pass', pass, '-BoxDir', BOX_DIR, '-CandPath', path.resolve(o.binary), '-CacheDir', o.cache, '-OutDir', outDir,
    '-TimeoutMin', String(o.timeoutMin)];
  if (needBase) args.push('-BaseRel', inputs.baseRel.replace(/\//g, '\\'));
  if (pass !== 'A') args.push('-NodeRel', inputs.nodeRel.replace(/\//g, '\\'), '-NodeSha', inputs.nodeSha);
  const r = sh('powershell.exe', args, (o.timeoutMin + 10) * 60000);
  fs.writeFileSync(path.join(path.dirname(outDir), `driver-${pass}.log`), r.out);
  const err = /DRIVER-ERROR: (.*)/.exec(r.out);
  return { driverError: r.code === 0 ? null : (err ? err[1].trim() : `driver exit ${r.code}`) };
}

function readRecords(outDir) {
  const f = path.join(outDir, 'results.jsonl');
  if (!fs.existsSync(f)) return { records: [], errors: ['results.jsonl missing'] };
  return parseResults(fs.readFileSync(f, 'utf8'));
}

/** Stale-pin check for the upgrade passes. Returns the report's baseline block. */
async function checkBaseline(o, pins) {
  const repo = pins.baselines[o.baselineVersion]?.repo ?? DEFAULT_REPO;
  const latest = await resolveLatestRelease(repo);
  const s = baselineStaleness({ usedTag: o.baselineVersion, latestTag: latest.tag, lookupError: latest.error });
  log(`baseline: ${s.note}`);
  return { repo, usedTag: o.baselineVersion, latestTag: latest.tag, source: latest.source ?? null, status: s.status, note: s.note };
}

async function main() {
  const pins = JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8'));
  const o = parseArgs(process.argv.slice(2), pins);
  if (o.driver === 'host' && !o.reportOnly) {
    const fleetHome = path.join(os.homedir(), '.apra-fleet');
    const refusal = hostRefusal({ env: process.env, optInFlag: !!o.disposable, passes: o.passList, fleetHomeExists: fs.existsSync(fleetHome), fleetHome });
    if (refusal) { console.error(refusal); process.exit(2); }
  }
  const checklist = JSON.parse(fs.readFileSync(path.join(HERE, 'checklist.json'), 'utf8'));
  fs.mkdirSync(o.out, { recursive: true });
  const notes = [];
  const inconclusive = [];
  const startedAt = new Date().toISOString();
  const needBase = o.passList.some(p => p === 'U' || p === 'U2');
  const vars = { expectVersion: o.expectVersion ?? null, baselineVersion: needBase ? (pins.baselines[o.baselineVersion]?.version ?? null) : null };
  const driverErrors = {};
  let baseline = null;
  if (needBase) {
    baseline = await checkBaseline(o, pins);
    if (baseline.status !== 'current') inconclusive.push(baseline.note);
  }

  if (!o.reportOnly) {
    let linuxDocker = null;
    let host = null;
    let docker = null;
    try {
      const inputs = await prepareCache(o, pins, notes);
      if (o.driver === 'docker') linuxDocker = await import('./drivers/linux-docker.mjs');
      if (o.driver === 'host') host = await import('./drivers/host.mjs');
      if (o.driver === 'docker') docker = linuxDocker.ensureDocker(log);
      if (!vars.expectVersion) {
        vars.expectVersion = o.driver === 'docker'
          ? linuxDocker.probeVersion(path.resolve(o.binary))
          : (/v\d+\.\d+\.\d+_[0-9a-f]+/.exec(sh(path.resolve(o.binary), ['--version'], 60000).out)?.[0] ?? null);
        notes.push(`Expected version derived from the candidate's own --version: ${vars.expectVersion ?? 'UNKNOWN'} (pass --expect-version to pin it).`);
      }
      if (host) {
        const { dropped } = host.boxEnv(() => {});
        notes.push(`Host driver: ran on this disposable machine with its real home (no HOME redirect: the service managers use the account's real home). CI markers removed from the box env; PATH entries holding node/npm dropped: ${dropped.join(path.delimiter) || 'none'}.`);
      }
      for (const pass of o.passList) {
        const outDir = path.join(o.out, `${o.platform}-${pass}`);
        log(`${o.platform}/${o.driver} pass ${pass}: start`);
        const t0 = Date.now();
        const passBase = pass === 'U' || pass === 'U2';
        const common = {
          pass, boxDir: BOX_DIR, candPath: path.resolve(o.binary), cacheDir: o.cache, outDir,
          baseRel: passBase ? inputs.baseRel : '', nodeRel: pass !== 'A' ? inputs.nodeRel : '', nodeSha: inputs.nodeSha ?? '',
          timeoutMin: o.timeoutMin, log,
        };
        let r;
        if (o.driver === 'sandbox') r = runWindowsSandboxPass(o, pass, inputs, outDir);
        else if (o.driver === 'docker') r = linuxDocker.runLinuxPass(common);
        else r = host.runHostPass({ ...common, platform: o.platform });
        if (r.driverError) driverErrors[pass] = r.driverError;
        log(`${o.platform} pass ${pass}: box finished in ${Math.round((Date.now() - t0) / 1000)}s${r.driverError ? ` (driver error: ${r.driverError})` : ''}`);
      }
    } catch (e) {
      notes.push(`Harness error: ${e.message}`);
      for (const p of o.passList) if (!fs.existsSync(path.join(o.out, `${o.platform}-${p}`, 'results.jsonl'))) driverErrors[p] ??= e.message;
    } finally {
      if (docker?.startedByUs && !o.keepDocker) linuxDocker.stopDocker(log);
    }
  }

  if (o.driver === 'docker') {
    notes.push('Linux runs in an ubuntu:24.04 container without systemd: service steps are N/A and the server is started by hand (setsid apra-fleet run) where the installer could not register a service; ENV-LIMITED marks failures explained only by that.');
  }
  const passes = o.passList.map(pass => {
    const outDir = path.join(o.out, `${o.platform}-${pass}`);
    const { records, errors } = readRecords(outDir);
    if (errors.length && fs.existsSync(path.join(outDir, 'results.jsonl'))) notes.push(`${o.platform}/${pass}: unparsable result lines: ${errors.join('; ')}`);
    return evaluatePass({ checklist, pass, platform: o.platform, driver: o.driver, records, vars, informational: o.informationalSet.has(pass), driverError: driverErrors[pass] ?? null });
  });
  const summary = finalVerdict(passes, inconclusive);
  const report = {
    platform: o.platform,
    driver: o.driver,
    candidate: o.binary ? { path: path.resolve(o.binary), sha256: sha256(o.binary) } : null,
    vars, baseline, startedAt, finishedAt: new Date().toISOString(),
    informational: [...o.informationalSet], passes, summary, notes,
  };
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(o.out, 'report.md'), renderMarkdown(report) + '\n');
  for (const p of passes) log(`${p.platform}/${p.pass}: ${p.verdict}${p.informational ? ' (informational)' : ''} ${JSON.stringify(p.counts)}`);
  log(`overall: ${summary.verdict}${summary.inconclusive.length ? ` (${summary.inconclusive.join('; ')})` : ''}`);
  log(`report: ${path.join(o.out, 'report.md')}`);
  process.exit(summary.exitCode);
}

main().catch(e => { console.error(e); process.exit(2); });
