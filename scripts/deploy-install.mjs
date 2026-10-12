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
//   anything after `--` is appended to `install --force` (e.g. `-- --llm agy`).
//
// Exit codes: the installer's own exit code; 2 on usage / platform errors.

import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  const out = { launchagent: false, printPath: false, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.extra = argv.slice(i + 1); break; }
    if (a === '--launchagent') out.launchagent = true;
    else if (a === '--print-path') out.printPath = true;
    else throw new DeployInstallError(`unknown argument: ${a}`);
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

export async function main(argv, { platform = process.platform, arch = process.arch, getuid = () => process.getuid?.() } = {}) {
  const args = parseArgs(argv);
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

  const { code, seen } = await runInstaller(installer, args.extra);
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
