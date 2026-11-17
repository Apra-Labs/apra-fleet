// Fresh-install harness: Linux (Docker Desktop, ubuntu:24.04) driver.
// One fresh container per pass; box scripts, candidate and cache are mounted
// read-only, results dir read-write; the pass runs as a normal user with HOME
// set and no systemd. No ports are published, so nothing reaches the host's
// own apra-fleet (7523/8787). Docker Desktop is stopped afterwards if this
// run started it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IMAGE = 'ubuntu:24.04';
const DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// This host sometimes fails process creation ("Not enough memory resources");
// retry a failed spawn once before reporting it.
function sh(cmd, args, { timeoutMs = 120000, input } = {}) {
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (!r.error || r.error.code === 'ETIMEDOUT') break;
    sleep(5000);
  }
  return { code: r.error ? `ERR ${r.error.code ?? r.error.message}` : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function dockerUp() { return sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 }).code === 0; }

/** Ensure the Docker daemon answers; returns { startedByUs } or throws. */
export function ensureDocker(log) {
  if (dockerUp()) return { startedByUs: false };
  if (process.platform !== 'win32' || !fs.existsSync(DESKTOP_EXE)) throw new Error('docker daemon not reachable and Docker Desktop not found');
  log(`starting Docker Desktop`);
  const r = spawnSync('cmd.exe', ['/c', 'start', '""', DESKTOP_EXE], { windowsHide: true });
  if (r.error) throw new Error(`could not start Docker Desktop: ${r.error.message}`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (dockerUp()) { log('docker daemon ready'); return { startedByUs: true }; }
    sleep(5000);
  }
  throw new Error('Docker Desktop did not become ready within 5 minutes');
}

export function stopDocker(log) {
  if (process.platform !== 'win32') return;
  log('stopping Docker Desktop (started by this run)');
  // Graceful first (Docker Desktop 4.37+ CLI), then force.
  if (sh('docker', ['desktop', 'stop'], { timeoutMs: 180000 }).code === 0) return;
  for (const im of ['Docker Desktop.exe', 'com.docker.backend.exe', 'com.docker.build.exe']) {
    sh('taskkill', ['/IM', im, '/F', '/T'], { timeoutMs: 60000 });
  }
  sh('wsl.exe', ['--terminate', 'docker-desktop'], { timeoutMs: 60000 });
}

function mountArg(host, guest, ro) { return ['-v', `${path.resolve(host)}:${guest}${ro ? ':ro' : ''}`]; }

/** Print the candidate's --version from a throwaway container. */
export function probeVersion(candPath) {
  const leaf = path.basename(candPath);
  const r = sh('docker', ['run', '--rm', ...mountArg(candPath, `/fi/cand/${leaf}`, true), IMAGE,
    'sh', '-c', `cp /fi/cand/${leaf} /tmp/c && chmod +x /tmp/c && /tmp/c --version`], { timeoutMs: 300000 });
  const m = /v\d+\.\d+\.\d+_[0-9a-f]+/.exec(r.out);
  return m ? m[0] : null;
}

/**
 * Run one pass in a fresh container. Returns { driverError: string|null, log }.
 */
export function runLinuxPass({ pass, boxDir, candPath, cacheDir, outDir, baseRel, nodeRel, nodeSha, timeoutMin = 45, log }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const name = `fi-${pass.toLowerCase()}-${Date.now()}`;
  const leaf = path.basename(candPath);
  const lines = [];
  const step = (label, r) => { lines.push(`$ ${label}\n[exit ${r.code}]\n${r.out.trim()}`); return r; };
  let driverError = null;
  try {
    const run = step('docker run', sh('docker', ['run', '-d', '--name', name,
      ...mountArg(boxDir, '/fi/in', true),
      ...mountArg(candPath, `/fi/cand/${leaf}`, true),
      ...mountArg(cacheDir, '/fi/cache', true),
      ...mountArg(outDir, '/fi/out', false),
      IMAGE, 'sleep', 'infinity'], { timeoutMs: 600000 }));
    if (run.code !== 0) throw new Error(`docker run failed: ${run.out.trim().split('\n').pop()}`);
    const prep = step('prep (root)', sh('docker', ['exec', name, 'bash', '-c',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq > /fi/out/apt.log 2>&1 && apt-get install -y -qq curl ca-certificates git procps >> /fi/out/apt.log 2>&1 && useradd -m tester'],
      { timeoutMs: 600000 }));
    if (prep.code !== 0) throw new Error('container prep (apt-get/useradd) failed; see apt.log');
    const env = ['-e', 'HOME=/home/tester', '-e', `CAND=/fi/cand/${leaf}`, '-e', 'OUT=/fi/out'];
    if (baseRel) env.push('-e', `BASE=/fi/cache/${baseRel}`);
    if (nodeRel) env.push('-e', `NODE_TGZ=/fi/cache/${nodeRel}`, '-e', `NODE_SHA=${nodeSha}`);
    log(`linux pass ${pass}: running box script in ${name}`);
    const box = step(`pass.sh ${pass} (as tester)`, sh('docker', ['exec', '-u', 'tester', '-w', '/home/tester', ...env, name, 'bash', '/fi/in/pass.sh', pass],
      { timeoutMs: timeoutMin * 60000 }));
    if (!fs.existsSync(path.join(outDir, 'done.txt'))) driverError = `box script did not finish (exit ${box.code})`;
  } catch (e) {
    driverError = e.message;
  } finally {
    step('docker rm -f', sh('docker', ['rm', '-f', name], { timeoutMs: 120000 }));
    fs.writeFileSync(path.join(outDir, 'driver.log'), lines.join('\n\n') + '\n');
  }
  return { driverError };
}
