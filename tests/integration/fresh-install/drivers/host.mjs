// Fresh-install harness: host driver. Runs ONE pass directly on this machine
// (box/pass.sh on linux/macos, box/pass.ps1 on windows) -- for disposable CI
// VMs only. run.mjs enforces the opt-in (lib/host.mjs hostRefusal) before this
// module does anything.
//
// HOME/USERPROFILE are deliberately NOT redirected to a temp dir: the product's
// service managers (systemd --user, launchd gui/<uid>, the schtasks onlogon
// task) start the server with the account's real home, so a redirected home
// would split install and server state and fail the upgrade checks on a
// harness artifact. The VM is the disposable unit instead.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostPassEnv, scrubNodeFromPath } from '../lib/host.mjs';

/** Env for the box: Node scrubbed from PATH, CI markers removed. */
export function boxEnv(log) {
  const pathKey = Object.keys(process.env).find(k => /^path$/i.test(k)) ?? 'PATH';
  const { path: scrubbed, dropped } = scrubNodeFromPath(process.env[pathKey], {
    sep: path.delimiter, join: path.join, exists: f => { try { return fs.statSync(f).isFile(); } catch { return false; } },
  });
  if (dropped.length) log(`host: dropped PATH entries holding node/npm: ${dropped.join(path.delimiter)}`);
  return { env: hostPassEnv(process.env, scrubbed), dropped };
}

/** Run one pass on this machine. Returns { driverError: string|null }. */
export function runHostPass({ platform, pass, boxDir, candPath, cacheDir, outDir, baseRel, nodeRel, nodeSha, timeoutMin = 45, log }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { env } = boxEnv(log);
  let cmd;
  let args;
  if (platform === 'windows') {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `fi-work-${pass}-`));
    // Absolute path: the scrubbed PATH must not decide which shell runs the box.
    cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(boxDir, 'pass.ps1'),
      '-Pass', pass, '-Cand', candPath, '-Out', outDir, '-Work', work];
    if (baseRel) args.push('-Base', path.join(cacheDir, baseRel));
    if (nodeRel) args.push('-NodeMsi', path.join(cacheDir, nodeRel), '-NodeSha', nodeSha);
  } else {
    cmd = '/bin/bash';
    args = [path.join(boxDir, 'pass.sh'), pass];
    env.OUT = outDir;
    env.CAND = candPath;
    if (baseRel) env.BASE = path.join(cacheDir, baseRel);
    if (nodeRel) { env.NODE_TGZ = path.join(cacheDir, nodeRel); env.NODE_SHA = nodeSha; }
  }
  log(`host pass ${pass}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    env, cwd: os.homedir(), encoding: 'utf8', timeout: timeoutMin * 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(path.join(outDir, 'driver.log'),
    `$ ${cmd} ${args.join(' ')}\n[exit ${r.error ? `ERR ${r.error.code ?? r.error.message}` : r.status}]\n${out.trim()}\n`);
  if (fs.existsSync(path.join(outDir, 'done.txt'))) return { driverError: null };
  return { driverError: r.error ? `box script did not finish: ${r.error.code ?? r.error.message}` : `box script did not finish (exit ${r.status})` };
}

/** Candidate --version straight from the binary (the host can run it). */
export function probeVersionHost(candPath) {
  const r = spawnSync(candPath, ['--version'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  return /v\d+\.\d+\.\d+_[0-9a-f]+/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`)?.[0] ?? null;
}
