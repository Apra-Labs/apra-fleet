#!/usr/bin/env node
/**
 * package-sea.mjs — Generate SEA blob and inject into Node binary
 *
 * Steps:
 * 1. Run `node --experimental-sea-config` to generate blob
 * 2. Copy node binary
 * 3. Inject blob with postject
 * 4. Platform-specific: macOS codesign dance, Windows shell:true
 */

import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// apra-fleet-eft.57: postject repeats a KNOWN-BENIGN warning ~10x per Linux
// build against Node 22's ELF sections; injection still succeeds. Upstream:
// https://github.com/nodejs/postject/issues/83 ("single executable
// applications with warning", closed as expected/non-fatal). This is an
// explicit allowlist of exact benign patterns only -- everything else must
// pass through verbatim, and a nonzero postject exit must still fail the
// build. NEVER widen this to a blanket stderr suppression (e.g. 2>/dev/null).
export const POSTJECT_BENIGN_STDERR_PATTERNS = [
  /^warning: Can't find string offset for section name '\.note(\.\d+)?'$/,
];

export function isBenignPostjectStderrLine(line) {
  return POSTJECT_BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

export function filterPostjectStderr(stderrText) {
  if (!stderrText) return '';
  return stderrText
    .split('\n')
    .filter((line) => line.length > 0 && !isBenignPostjectStderrLine(line))
    .join('\n');
}

// Runs the postject injection command through a shell (mirrors the previous
// execSync behavior), captures stderr instead of inheriting it so the known-
// benign lines above can be dropped, and prints everything else verbatim.
// `deps.spawnSync` is injectable so tests can simulate postject's exit
// behavior without invoking the real binary. Returns {status, error,
// filteredStderr} rather than throwing/exiting itself, so callers decide how
// to fail -- see reportAndCheckPostjectResult() below for the CLI behavior.
export function runPostjectFiltered(command, options = {}, deps = {}) {
  const spawn = deps.spawnSync ?? spawnSync;
  const result = spawn(command, { ...options, shell: true, stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf-8' });
  const filteredStderr = filterPostjectStderr(result.stderr ?? '');
  return { status: result.status, error: result.error, filteredStderr };
}

function reportAndCheckPostjectResult(result) {
  if (result.filteredStderr) {
    process.stderr.write(result.filteredStderr.endsWith('\n') ? result.filteredStderr : `${result.filteredStderr}\n`);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(`Error: postject exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const distDir = join(root, 'dist');
  const seaConfig = join(distDir, 'sea-config.json');
  const blob = join(distDir, 'sea-prep.blob');

  mkdirSync(distDir, { recursive: true });

  // Determine output binary name
  const platform = process.platform;
  const arch = process.arch;
  const platformMap = { win32: 'win', darwin: 'darwin', linux: 'linux' };
  const ext = platform === 'win32' ? '.exe' : '';
  const binaryName = `apra-fleet-installer-${platformMap[platform] || platform}-${arch}${ext}`;
  const outputBinary = join(distDir, binaryName);

  console.log(`Packaging SEA binary: ${binaryName}`);

  // Step 1: Generate blob
  if (!existsSync(seaConfig)) {
    console.error('Error: dist/sea-config.json not found. Run gen-sea-config.mjs first.');
    process.exit(1);
  }

  console.log('  [1/3] Generating SEA blob...');
  execSync(`node --experimental-sea-config "${seaConfig}"`, {
    cwd: root,
    stdio: 'inherit',
  });

  if (!existsSync(blob)) {
    console.error('Error: SEA blob not generated.');
    process.exit(1);
  }

  // Step 2: Copy node binary
  console.log('  [2/3] Copying Node.js binary...');
  copyFileSync(process.execPath, outputBinary);

  // Windows: apply custom icon BEFORE postject (postject corrupts PE resources)
  if (platform === 'win32') {
    const icoPath = join(root, 'assets', 'icons', 'apra-fleet.ico');
    if (existsSync(icoPath)) {
      console.log('  [2.5/3] Applying Apra Labs icon...');
      // Find rcedit: try PATH, .cmd, npm global root
      let rcedit = '';
      try { execSync('rcedit --help', { stdio: 'pipe' }); rcedit = 'rcedit'; } catch {}
      if (!rcedit) try { execSync('rcedit.cmd --help', { stdio: 'pipe' }); rcedit = 'rcedit.cmd'; } catch {}
      if (!rcedit) try { execSync('rcedit.exe --help', { stdio: 'pipe' }); rcedit = 'rcedit.exe'; } catch {}
      if (!rcedit) {
        // npm global root
        try {
          const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
          const candidate = join(npmRoot, 'rcedit', 'bin', 'rcedit.exe');
          if (existsSync(candidate)) rcedit = candidate;
        } catch {}
      }
      if (rcedit) {
        execSync(`"${rcedit}" "${outputBinary}" --set-icon "${icoPath}"`, { stdio: 'inherit', shell: true });
        console.log('  Icon injection succeeded');
      } else {
        console.error('WARNING: rcedit not found — icon not replaced. Install with: npm install -g rcedit');
      }
    }
  }

  // macOS: strip existing signature before postject, then ensure writable.
  // apra-fleet-eft.57: this is EXPECTED and by-design, not a failure --
  // postject cannot inject into an already-signed Mach-O binary, so the
  // ad-hoc signature Node's own build left in place has to come off first.
  // The binary is re-signed ad-hoc again after injection (see below).
  if (platform === 'darwin') {
    console.log('  [2.5/3] Stripping macOS codesign (expected/by-design: postject requires an unsigned binary; re-signed ad-hoc after injection)...');
    execSync(`codesign --remove-signature "${outputBinary}"`, { stdio: 'inherit' });
    execSync(`chmod u+w "${outputBinary}"`, { stdio: 'inherit' });
  }

  // Step 3: Inject blob with postject
  console.log('  [3/3] Injecting SEA blob with postject...');
  const postjectArgs = [
    `"${outputBinary}"`,
    'NODE_SEA_BLOB',
    `"${blob}"`,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];

  if (platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  const npxCmd = platform === 'win32' ? 'npx.cmd' : 'npx';
  const postjectCmd = `${npxCmd} --yes postject ${postjectArgs.join(' ')}`;

  const postjectResult = runPostjectFiltered(postjectCmd, { cwd: root });
  reportAndCheckPostjectResult(postjectResult);

  // macOS: re-sign with ad-hoc signature
  if (platform === 'darwin') {
    console.log('  Re-signing macOS binary...');
    execSync(`codesign --sign - "${outputBinary}"`, { stdio: 'inherit' });
  }

  console.log(`\nSEA binary ready: dist/${binaryName}`);
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
