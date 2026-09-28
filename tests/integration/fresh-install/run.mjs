#!/usr/bin/env node
// Fresh-install release harness entry point.
//
//   node tests/integration/fresh-install/run.mjs --binary <installer> --platform windows|linux
//        [--passes A,B,U,U2] [--informational A] [--baseline-version v0.4.2]
//        [--expect-version v0.4.3_78cefd] [--out <dir>] [--cache <dir>]
//        [--timeout-min 45] [--keep-docker] [--report-only]
//
// Each pass runs in its own fresh Windows Sandbox or ubuntu:24.04 container,
// sequentially. Writes <out>/report.json + report.md; exits 1 if any
// non-informational pass failed. A failed step never aborts the run.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePass, parseResults, renderMarkdown, summarize } from './lib/verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOX_DIR = path.join(HERE, 'box');
const ALL_PASSES = ['A', 'B', 'U', 'U2'];

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node tests/integration/fresh-install/run.mjs --binary <installer> --platform windows|linux [--passes A,B,U,U2] [--informational A] [--baseline-version v0.4.2] [--expect-version <v>] [--out <dir>] [--cache <dir>] [--timeout-min 45] [--keep-docker] [--report-only]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { passes: ALL_PASSES.join(','), informational: '', baselineVersion: 'v0.4.2', timeoutMin: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    switch (a) {
      case '--binary': o.binary = val(); break;
      case '--platform': o.platform = val(); break;
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
  if (!['windows', 'linux'].includes(o.platform)) usage('--platform must be windows or linux');
  if (!o.reportOnly && (!o.binary || !fs.existsSync(o.binary))) usage('--binary must point to an existing installer');
  const list = s => s.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  o.passList = list(o.passes);
  for (const p of o.passList) if (!ALL_PASSES.includes(p)) usage(`unknown pass ${p}`);
  o.informationalSet = new Set(list(o.informational));
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

async function fetchPinned(url, dest, want) {
  if (fs.existsSync(dest) && sha256(dest) === want) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  const got = sha256(`${dest}.part`);
  if (got !== want) { fs.rmSync(`${dest}.part`); throw new Error(`sha256 mismatch for ${url}: got ${got}, pinned ${want}`); }
  fs.renameSync(`${dest}.part`, dest);
}

/** Prepare cached, checksum-verified inputs. Returns paths relative to the cache dir. */
async function prepareCache(o, pins, notes) {
  const out = {};
  const needNode = o.passList.some(p => p !== 'A');
  const needBase = o.passList.some(p => p === 'U' || p === 'U2');
  if (needNode) {
    const n = pins.node[o.platform];
    await fetchPinned(n.url, path.join(o.cache, 'node', n.file), n.sha256);
    out.nodeRel = `node/${n.file}`; out.nodeSha = n.sha256;
  }
  if (needBase) {
    const b = pins.baselines[o.baselineVersion];
    const asset = b?.[o.platform]?.asset ?? (o.platform === 'windows' ? 'apra-fleet-installer-win-x64.exe' : 'apra-fleet-installer-linux-x64');
    const dir = path.join(o.cache, 'baseline', o.baselineVersion);
    const dest = path.join(dir, asset);
    const want = b?.[o.platform]?.sha256;
    if (!fs.existsSync(dest) || (want && sha256(dest) !== want)) {
      log(`downloading baseline ${o.baselineVersion} ${asset} via gh`);
      fs.mkdirSync(dir, { recursive: true });
      const r = sh('gh', ['release', 'download', o.baselineVersion, '-R', b?.repo ?? 'Apra-Labs/apra-fleet', '-p', asset, '-D', dir, '--clobber']);
      if (r.code !== 0) throw new Error(`gh release download failed: ${r.out.trim()}`);
    }
    const got = sha256(dest);
    if (want && got !== want) throw new Error(`baseline sha256 mismatch: got ${got}, pinned ${want}`);
    if (!want) notes.push(`Baseline ${o.baselineVersion} is not pinned in pins.json; used unverified sha256 ${got}.`);
    out.baseRel = `baseline/${o.baselineVersion}/${asset}`;
    out.baselineVersion = b?.version ?? null;
  }
  return out;
}

function runWindowsPass(o, pass, inputs, outDir) {
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

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const checklist = JSON.parse(fs.readFileSync(path.join(HERE, 'checklist.json'), 'utf8'));
  const pins = JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8'));
  fs.mkdirSync(o.out, { recursive: true });
  const notes = [];
  const startedAt = new Date().toISOString();
  const vars = { expectVersion: o.expectVersion ?? null, baselineVersion: pins.baselines[o.baselineVersion]?.version ?? null };
  const driverErrors = {};
  let linuxDocker = null;

  if (!o.reportOnly) {
    const inputs = await prepareCache(o, pins, notes);
    if (o.platform === 'linux') {
      linuxDocker = await import('./drivers/linux-docker.mjs');
    }
    let docker = null;
    try {
      if (o.platform === 'linux') docker = linuxDocker.ensureDocker(log);
      if (!vars.expectVersion) {
        vars.expectVersion = o.platform === 'windows'
          ? (/v\d+\.\d+\.\d+_[0-9a-f]+/.exec(sh(path.resolve(o.binary), ['--version'], 60000).out)?.[0] ?? null)
          : linuxDocker.probeVersion(path.resolve(o.binary));
        notes.push(`Expected version derived from the candidate's own --version: ${vars.expectVersion ?? 'UNKNOWN'} (pass --expect-version to pin it).`);
      }
      for (const pass of o.passList) {
        const outDir = path.join(o.out, `${o.platform}-${pass}`);
        log(`${o.platform} pass ${pass}: start`);
        const t0 = Date.now();
        const needBase = pass === 'U' || pass === 'U2';
        const r = o.platform === 'windows'
          ? runWindowsPass(o, pass, inputs, outDir)
          : linuxDocker.runLinuxPass({
            pass, boxDir: BOX_DIR, candPath: path.resolve(o.binary), cacheDir: o.cache, outDir,
            baseRel: needBase ? inputs.baseRel : '', nodeRel: pass !== 'A' ? inputs.nodeRel : '', nodeSha: inputs.nodeSha ?? '',
            timeoutMin: o.timeoutMin, log,
          });
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

  if (o.platform === 'linux') {
    notes.push('Linux runs in an ubuntu:24.04 container without systemd: service steps are N/A and the server is started by hand (setsid apra-fleet run) where the installer could not register a service; ENV-LIMITED marks failures explained only by that.');
  }
  const passes = o.passList.map(pass => {
    const outDir = path.join(o.out, `${o.platform}-${pass}`);
    const { records, errors } = readRecords(outDir);
    if (errors.length && fs.existsSync(path.join(outDir, 'results.jsonl'))) notes.push(`${o.platform}/${pass}: unparsable result lines: ${errors.join('; ')}`);
    return evaluatePass({ checklist, pass, platform: o.platform, records, vars, informational: o.informationalSet.has(pass), driverError: driverErrors[pass] ?? null });
  });
  const summary = summarize(passes);
  const report = {
    platform: o.platform,
    candidate: o.binary ? { path: path.resolve(o.binary), sha256: sha256(o.binary) } : null,
    vars, startedAt, finishedAt: new Date().toISOString(),
    informational: [...o.informationalSet], passes, summary, notes,
  };
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(o.out, 'report.md'), renderMarkdown(report) + '\n');
  for (const p of passes) log(`${p.platform}/${p.pass}: ${p.verdict}${p.informational ? ' (informational)' : ''} ${JSON.stringify(p.counts)}`);
  log(`report: ${path.join(o.out, 'report.md')}`);
  process.exit(summary.exitCode);
}

main().catch(e => { console.error(e); process.exit(2); });
