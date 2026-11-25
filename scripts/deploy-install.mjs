#!/usr/bin/env node
// Deploy helper: resolve this platform's SEA installer under ./dist and run
// `install --force` with inherited stdio, exit code propagated. One command
// replaces the old multi-step uname/case shell block in deploy.md, so the
// deployer never needs command substitution, loops, or a POSIX shell.
//
// Usage:
//   node scripts/deploy-install.mjs [--launchagent] [--print-path] [-- <extra install args>]
//
//   --print-path    print the resolved installer path and exit 0 (no install).
//   --launchagent   macOS only: launchctl bootout (|| true), install, then
//                   launchctl kickstart -k when the installer reports
//                   "registration skipped". Hard-fails on any other platform.
//   --member-host-check   print MEMBER-HOST when <data dir>/member-install.json exists,
//                   else FULL-HOST; exit 0 (no install). Data dir resolved in JS
//                   (APRA_FLEET_DATA_DIR, else <home>/.apra-fleet/data).
//   --verify-member-host  after a member-host install: marker version must equal the
//                   installed binary's --version and /health must answer on the
//                   marker-recorded port (7523 if none); exit 1 on any mismatch.
//   --llm <name>    appended to `install --force` (no bare `--` needed; PowerShell
//                   may drop it).
//   anything after `--` is appended to `install --force` (e.g. `-- --llm agy`).
//
// Exit codes: the installer's own exit code; 2 on usage / platform errors.

import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// install refuses (E-FLEET-SE-RUNNING) while a fleet-sprint supervisor or
// sprint runs for this user -- and a deploy dispatched by a sprint always has
// its own sprint and supervisor running. deploy.md's active-sprints gate has
// already admitted only that own sprint, and replacing the server under it is
// the documented deploy contract, so the refusal is overridden -- but ONLY when
// <data dir>/member-access.key already exists: then the installed fleet is
// 0.4.4+ and every supervisor/sprint started from it reads that key per
// connection and survives the restart. Without it (the 0.4.3 -> 0.4.4 hop)
// the running supervisor/sprint is old code that would get HTTP 401, so the
// guard stays on and its refusal, with the exact stop steps, is surfaced.
export const IGNORE_RUNNING_SPRINTS = '--ignore-running-sprints';

/** Mirrors src/paths.ts FLEET_DIR + member-access-secret.ts MEMBER_ACCESS_SECRET_FILE. */
export function memberAccessKeyPath(env = process.env, home = os.homedir()) {
  return path.join(env.APRA_FLEET_DATA_DIR ?? path.join(home, '.apra-fleet', 'data'), 'member-access.key');
}

/** Mirrors src/paths.ts FLEET_DIR + member-install marker file name. */
export function memberMarkerPath(env = process.env, home = os.homedir()) {
  return path.join(env.APRA_FLEET_DATA_DIR ?? path.join(home, '.apra-fleet', 'data'), 'member-install.json');
}

export function installedBinaryPath(platform = process.platform, home = os.homedir()) {
  return path.join(home, '.apra-fleet', 'bin', platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet');
}

export function memberHostCheck(exists = (f) => fs.existsSync(f), env = process.env, home = os.homedir()) {
  return exists(memberMarkerPath(env, home)) ? 'MEMBER-HOST' : 'FULL-HOST';
}

/** Returns { ok, lines }. Every dependency is injectable for tests. */
export async function verifyMemberHost({
  env = process.env, home = os.homedir(), platform = process.platform,
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  binaryVersion = (bin) => {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() : null;
  },
  health = async (port) => {
    try { return (await fetch(`http://localhost:${port}/health`)).ok; } catch { return false; }
  },
} = {}) {
  const lines = [];
  const markerFile = memberMarkerPath(env, home);
  let marker;
  try { marker = JSON.parse(readFile(markerFile)); } catch {
    return { ok: false, lines: [`FAIL: member-install.json missing or unreadable at ${markerFile}`] };
  }
  const rawVersion = binaryVersion(installedBinaryPath(platform, home));
  // `--version` prints 3 lines: "apra-fleet <ver>", "  Mode: ...", "  Binary: ...".
  const installed = rawVersion === null ? null
    : (String(rawVersion).split(/\r?\n/)[0] ?? '').trim().replace(/^apra-fleet\s+/i, '').trim();
  const port = Number.isInteger(marker?.port) ? marker.port : 7523;
  let ok = true;
  if (installed === null) { ok = false; lines.push('FAIL: installed apra-fleet --version did not run'); }
  else if (installed.replace(/^v/, '') !== String(marker?.version ?? '').replace(/^v/, '')) {
    ok = false; lines.push(`FAIL: marker version ${marker?.version} != installed ${installed}`);
  } else lines.push(`OK: marker version ${marker.version} == installed ${installed}`);
  if (await health(port)) lines.push(`OK: /health answers on port ${port}`);
  else { ok = false; lines.push(`FAIL: no /health answer on port ${port}`); }
  return { ok, lines };
}

export function installArgs(extra, memberKeyExists) {
  if (!memberKeyExists || extra.includes(IGNORE_RUNNING_SPRINTS)) return extra;
  return [...extra, IGNORE_RUNNING_SPRINTS];
}

export const LAUNCHD_LABEL = 'com.apra-fleet.server';

export class DeployInstallError extends Error {}

/** Same mapping the old shell case blocks used: Darwin->darwin, Linux->linux, else win. */
export function platformName(platform) {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'win';
}

/** x86_64 -> x64, arm64/aarch64 -> arm64, anything else passes through. */
export function archName(arch) {
  if (arch === 'x64' || arch === 'x86_64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return arch;
}

export function installerName(platform, arch) {
  const p = platformName(platform);
  return `apra-fleet-installer-${p}-${archName(arch)}${p === 'win' ? '.exe' : ''}`;
}

export function installerPath(platform, arch) {
  return `dist/${installerName(platform, arch)}`;
}

export function launchdTarget(uid) {
  return `gui/${uid}/${LAUNCHD_LABEL}`;
}

export function assertMacOS(platform) {
  if (platform !== 'darwin') {
    throw new DeployInstallError(
      `--launchagent is macOS only (launchd); this platform is "${platform}". Run without --launchagent.`,
    );
  }
}

export function parseArgs(argv) {
  const out = { launchagent: false, printPath: false, memberHostCheck: false, verifyMemberHost: false, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.extra = argv.slice(i + 1); break; }
    if (a === '--launchagent') out.launchagent = true;
    else if (a === '--print-path') out.printPath = true;
    else if (a === '--member-host-check') out.memberHostCheck = true;
    else if (a === '--verify-member-host') out.verifyMemberHost = true;
    else if (a === '--llm') {
      const v = argv[++i];
      if (v === undefined) throw new DeployInstallError('--llm requires a value');
      out.extra.push('--llm', v);
    } else throw new DeployInstallError(`unknown argument: ${a}`);
  }
  return out;
}

function runInstaller(installer, extra) {
  return new Promise((resolve) => {
    let seen = '';
    const child = spawn(installer, ['install', '--force', ...extra], { stdio: ['inherit', 'pipe', 'pipe'] });
    const tee = (stream, sink) => stream.on('data', (d) => { seen += d.toString(); sink.write(d); });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('error', (e) => { process.stderr.write(`failed to run ${installer}: ${e.message}\n`); resolve({ code: 1, seen }); });
    child.on('close', (code) => resolve({ code: code ?? 1, seen }));
  });
}

export async function main(argv, {
  platform = process.platform, arch = process.arch, getuid = () => process.getuid?.(),
  memberKeyExists = () => fs.existsSync(memberAccessKeyPath()),
  run = runInstaller,
} = {}) {
  const args = parseArgs(argv);
  if (args.memberHostCheck) { process.stdout.write(`${memberHostCheck()}\n`); return 0; }
  if (args.verifyMemberHost) {
    const r = await verifyMemberHost();
    process.stdout.write(`${r.lines.join('\n')}\n`);
    return r.ok ? 0 : 1;
  }
  const installer = installerPath(platform, arch);
  if (args.printPath) { process.stdout.write(`${installer}\n`); return 0; }
  if (args.launchagent) assertMacOS(platform);

  let target;
  if (args.launchagent) {
    const uid = getuid();
    if (typeof uid !== 'number') throw new DeployInstallError('cannot resolve the current uid');
    target = launchdTarget(uid);
    // Mirrors `launchctl bootout ... || true`: a failure here is not fatal.
    spawnSync('launchctl', ['bootout', target], { stdio: 'inherit' });
  }

  const keyExists = memberKeyExists();
  if (!keyExists) {
    process.stderr.write('deploy-install: no member access key yet (first 0.4.4+ install here): if a fleet-sprint '
      + 'supervisor or sprint is running it is old code and install refuses -- stop it as the installer says, then rerun.\n');
  }
  const { code, seen } = await run(installer, installArgs(args.extra, keyExists));
  if (code !== 0) return code;

  if (args.launchagent && /registration skipped/i.test(seen)) {
    const k = spawnSync('launchctl', ['kickstart', '-k', target], { stdio: 'inherit' });
    return k.status ?? 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`deploy-install: ${err.message}\n`);
      process.exit(err instanceof DeployInstallError ? 2 : 1);
    },
  );
}
