#!/usr/bin/env node
/**
 * spike-sea-import.mjs -- Phase 1 risk gate (apra-fleet-7pm.1, risk R1)
 *
 * Proves the load-bearing assumption of docs/workflow-subsystem-plan.md Section 1
 * option (c) ("import trampoline + on-disk runtime tree"): that a SEA binary's
 * injected main script can dynamic-`import()` an on-disk ESM file, and that the
 * imported file's own BARE specifier (`@scope/pkg`) resolves via Node's normal
 * upward node_modules walk from its on-disk location.
 *
 * It builds a throwaway SEA binary with the same pipeline shape as the real one
 * (scripts/gen-sea-config.mjs + scripts/package-sea.mjs): useCodeCache: true,
 * postject injection, macOS codesign dance, Windows shell:true.
 *
 * Fixture tree mirrors the real ~/.apra-fleet/ layout the installer will create:
 *
 *   <work>/runtime/node_modules/@spike/pkg/index.mjs   <- bare specifier target
 *   <work>/runtime/workflows/hello/main.mjs            <- on-disk ESM entry
 *
 * The upward walk from workflows/hello/ finds runtime/node_modules/ -- exactly as
 * ~/.apra-fleet/workflows/<name>/ will find ~/.apra-fleet/node_modules/.
 *
 * Usage:
 *   node scripts/spike-sea-import.mjs                 # useCodeCache: true (default)
 *   node scripts/spike-sea-import.mjs --no-code-cache # fallback (a) measurement
 *
 * Exit 0 = the spike PASSED on this OS. Exit 1 = FAILED (record the fallback).
 */

import { execSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const useCodeCache = !process.argv.includes('--no-code-cache');
const platform = process.platform;
const ext = platform === 'win32' ? '.exe' : '';

const work = join(root, 'dist', 'spike-sea');
const runtime = join(work, 'runtime');
const pkgDir = join(runtime, 'node_modules', '@spike', 'pkg');
const wfDir = join(runtime, 'workflows', 'hello');
const mainCjs = join(work, 'spike-main.cjs');
const configJson = join(work, 'spike-sea-config.json');
const blob = join(work, 'spike-sea-prep.blob');
const binary = join(work, `spike-fleet${ext}`);

console.log(`[spike] platform=${platform} arch=${process.arch} node=${process.version} useCodeCache=${useCodeCache}`);

// ---------------------------------------------------------------- fixture tree
rmSync(work, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });
mkdirSync(wfDir, { recursive: true });

// Bare-specifier package: pure ESM, exports map -- same shape as
// @apralabs/apra-fleet-workflow (type: module, "./engine" subpath export).
writeFileSync(
  join(pkgDir, 'package.json'),
  JSON.stringify(
    {
      name: '@spike/pkg',
      version: '1.0.0',
      type: 'module',
      main: 'index.mjs',
      exports: { '.': './index.mjs', './engine': './engine.mjs' },
    },
    null,
    2,
  ),
);
writeFileSync(join(pkgDir, 'index.mjs'), `export const MARKER = 'bare-specifier-resolved';\n`);
// Subpath export -- the real hello-world workflow imports
// '@apralabs/apra-fleet-workflow/engine', so prove subpath resolution too.
writeFileSync(join(pkgDir, 'engine.mjs'), `export class SpikeEngine {}\n`);

// On-disk ESM entry. Static bare import at module level: this is the exact thing
// that must resolve, and it resolves BEFORE any of this module's code runs.
writeFileSync(
  join(wfDir, 'main.mjs'),
  [
    `import { MARKER } from '@spike/pkg';`,
    `import { SpikeEngine } from '@spike/pkg/engine';`,
    ``,
    `const args = process.argv.slice(2);`,
    `console.log('[spike-entry] argv1=' + process.argv[1]);`,
    `console.log('[spike-entry] args=' + args.join(','));`,
    `console.log('[spike-entry] bare=' + MARKER);`,
    `console.log('[spike-entry] subpath=' + (typeof SpikeEngine === 'function' ? 'resolved' : 'missing'));`,
    `export const loaded = true;`,
    ``,
  ].join('\n'),
);

// -------------------------------------------------------------- SEA main script
// Plain CJS (the real one is an esbuild CJS bundle; the dynamic-import mechanism
// under test is identical). Mirrors the launcher's argv rewrite from Section 1
// step 3 so the spike also proves import.meta/argv behave as the design assumes.
writeFileSync(
  mainCjs,
  [
    `'use strict';`,
    `const { pathToFileURL } = require('node:url');`,
    `const sea = require('node:sea');`,
    ``,
    `(async () => {`,
    `  console.log('[spike-main] isSea=' + (sea.isSea ? sea.isSea() : 'n/a'));`,
    `  const entry = process.argv[2];`,
    `  const passthrough = process.argv.slice(3);`,
    `  // Launcher argv rewrite (plan Section 1, step 3).`,
    `  process.argv = [process.execPath, entry, ...passthrough];`,
    `  const t0 = Date.now();`,
    `  const mod = await import(pathToFileURL(entry).href);`,
    `  console.log('[spike-main] import-ms=' + (Date.now() - t0));`,
    `  console.log('[spike-main] loaded=' + (mod && mod.loaded === true));`,
    `  console.log('[spike-main] SPIKE_OK');`,
    `})().catch((err) => {`,
    `  console.error('[spike-main] SPIKE_FAIL ' + (err && err.code ? err.code + ': ' : '') + (err && err.message));`,
    `  console.error(err && err.stack);`,
    `  process.exit(1);`,
    `});`,
    ``,
  ].join('\n'),
);

// ----------------------------------------------------------------- build the SEA
writeFileSync(
  configJson,
  JSON.stringify(
    {
      main: mainCjs,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache,
      assets: {},
    },
    null,
    2,
  ),
);

console.log('[spike] generating blob...');
execSync(`node --experimental-sea-config "${configJson}"`, { cwd: root, stdio: 'inherit' });
if (!existsSync(blob)) {
  console.error('[spike] SPIKE_FAIL blob not generated');
  process.exit(1);
}

console.log('[spike] copying node binary...');
copyFileSync(process.execPath, binary);

if (platform === 'darwin') {
  execSync(`codesign --remove-signature "${binary}"`, { stdio: 'inherit' });
  execSync(`chmod u+w "${binary}"`, { stdio: 'inherit' });
}
if (platform === 'win32') {
  // Signed node.exe: postject can corrupt the Authenticode cert dir. CI strips it
  // (ci.yml "Strip node.exe signature before SEA injection"); best-effort here.
  try {
    execSync(`signtool remove /s "${binary}"`, { stdio: 'pipe' });
    console.log('[spike] stripped Authenticode signature');
  } catch {
    console.log('[spike] signtool not available / nothing to strip (non-fatal)');
  }
}

console.log('[spike] injecting blob with postject...');
const postjectArgs = [
  `"${binary}"`,
  'NODE_SEA_BLOB',
  `"${blob}"`,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
const npxCmd = platform === 'win32' ? 'npx.cmd' : 'npx';
execSync(`${npxCmd} --yes postject ${postjectArgs.join(' ')}`, {
  cwd: root,
  stdio: 'inherit',
  shell: platform === 'win32' ? true : undefined,
});
if (platform === 'darwin') {
  execSync(`codesign --sign - "${binary}"`, { stdio: 'inherit' });
}

// ------------------------------------------------------------------------- run
const entry = join(wfDir, 'main.mjs');
console.log(`[spike] running packaged binary: ${binary} ${entry} a b`);
const t0 = Date.now();
const res = spawnSync(binary, [entry, 'a', 'b'], { encoding: 'utf-8' });
const wallMs = Date.now() - t0;

const out = `${res.stdout || ''}${res.stderr || ''}`;
process.stdout.write(out);
console.log(`[spike] wall-ms=${wallMs} exit=${res.status}`);

const checks = [
  ['SEA main executed', out.includes('[spike-main] isSea=true')],
  ['dynamic import() of on-disk ESM succeeded', out.includes('[spike-main] loaded=true')],
  ['bare specifier resolved from sibling node_modules', out.includes('[spike-entry] bare=bare-specifier-resolved')],
  ['subpath export resolved', out.includes('[spike-entry] subpath=resolved')],
  ['pass-through args reached the entry', out.includes('[spike-entry] args=a,b')],
  ['exit code 0', res.status === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '[OK]  ' : '[FAIL]'} ${name}`);
  if (!pass) ok = false;
}

console.log(
  `\n[spike] RESULT=${ok ? 'PASS' : 'FAIL'} platform=${platform} arch=${process.arch} node=${process.version} useCodeCache=${useCodeCache} wall-ms=${wallMs}`,
);
process.exit(ok ? 0 : 1);
