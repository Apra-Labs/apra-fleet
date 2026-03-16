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

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');
const seaConfig = join(distDir, 'sea-config.json');
const blob = join(distDir, 'sea-prep.blob');

mkdirSync(distDir, { recursive: true });

// Determine output binary name
const platform = process.platform;
const arch = process.arch;
const platformMap = { win32: 'win', darwin: 'darwin', linux: 'linux' };
const ext = platform === 'win32' ? '.exe' : '';
const binaryName = `apra-fleet-${platformMap[platform] || platform}-${arch}${ext}`;
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

// macOS: strip existing signature before postject
if (platform === 'darwin') {
  console.log('  [2.5/3] Stripping macOS codesign...');
  execSync(`codesign --remove-signature "${outputBinary}"`, { stdio: 'inherit' });
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

execSync(postjectCmd, {
  cwd: root,
  stdio: 'inherit',
  shell: platform === 'win32' ? true : undefined,
});

// macOS: re-sign with ad-hoc signature
if (platform === 'darwin') {
  console.log('  Re-signing macOS binary...');
  execSync(`codesign --sign - "${outputBinary}"`, { stdio: 'inherit' });
}

console.log(`\nSEA binary ready: dist/${binaryName}`);
