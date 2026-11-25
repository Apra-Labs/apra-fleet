#!/usr/bin/env node
// Produce the publishable npm tarball from a STAGED COPY of the package whose
// shipped JavaScript has been comment-stripped (line-preserving, see
// scripts/lib/strip-comments.mjs). Repo files are never modified.
//
// Precondition: the build has run (npm run build, and npm run dist-pm as
// prepublishOnly does). The script fails loudly when dist/index.js is missing.
//
// Steps:
//   1. `npm pack --dry-run --json --ignore-scripts` in the package root gives
//      the exact file list (same parsing tolerance as check-pack-size's
//      parsePackJson: lifecycle-script stdout noise around the JSON is fine).
//   2. Those files (package.json is always among them) are copied into a fresh
//      temp staging dir.
//   3. Every .js/.mjs/.cjs file in staging is stripped, EXCEPT files under
//      packages/apra-fleet-client/ and packages/apra-fleet-workflow/ (their
//      JSDoc typedefs are the editor types for client and workflow authors).
//      Non-JS files are copied untouched. dist/ gets the same line-preserving
//      pass (NOT tsc removeComments, which would shift line numbers).
//   4. `npm pack --ignore-scripts` runs inside staging (the staged
//      package.json drops its pack/publish-time lifecycle scripts, which
//      point at scripts/ files that are not shipped; see PACK_TIME_SCRIPTS). The tarball is produced in a scratch dir and
//      copied to --out only after everything succeeded: no partial tarball.
//
// The SEA binary is unaffected by construction: scripts/build-sea.mjs bundles
// src/ and scripts/gen-sea-config.mjs reads repo sources, never the staging
// dir.
//
// Usage:
//   node scripts/pack-stripped.mjs --out <dir> [--keep-staging]
//        [--root <pkgDir>] [--require <relFile>] [--exempt <relPrefix>]...
// --root/--require/--exempt exist so the mechanics can be exercised on a tiny
// fixture package; the defaults describe this repo.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments, countLines } from './lib/strip-comments.mjs';
import { parsePackJson } from './check-pack-size.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_EXEMPT_PREFIXES = [
  'packages/apra-fleet-client/',
  'packages/apra-fleet-workflow/',
];

const JS_EXT = /\.(?:js|mjs|cjs)$/;

/** True when `relPath` (forward-slash, package-relative) must ship untouched. */
export function isExempt(relPath, exemptPrefixes = DEFAULT_EXEMPT_PREFIXES) {
  const p = relPath.replace(/\\/g, '/');
  return exemptPrefixes.some((prefix) => p.startsWith(prefix));
}

/** True when `relPath` is a JS file the stripper should process. */
export function shouldStrip(relPath, exemptPrefixes = DEFAULT_EXEMPT_PREFIXES) {
  return JS_EXT.test(relPath) && !isExempt(relPath, exemptPrefixes);
}

// npm 10.9.x runs a package's `prepare` (and prepack/postpack) from `npm pack`
// even under --ignore-scripts, and the staged package.json's scripts point at
// scripts/ files that are not shipped. Those hooks only fire when packing or
// publishing (never on a registry install), so the staged copy drops exactly
// them; every other package.json field, including install-time scripts, is kept.
const PACK_TIME_SCRIPTS = ['prepublish', 'prepare', 'prepublishOnly', 'prepack', 'postpack', 'publish', 'postpublish'];

function dropPackLifecycleScripts(pkgJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  if (pkg.scripts) {
    for (const k of PACK_TIME_SCRIPTS) delete pkg.scripts[k];
    if (Object.keys(pkg.scripts).length === 0) delete pkg.scripts;
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
}

function npm(args, cwd) {
  // shell:true resolves the npm.cmd shim on Windows; every argument here is
  // either a literal or a path we quote ourselves.
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return execFileSync('npm', quoted, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * List the files `npm pack` would ship from `root` (package-relative paths).
 * @returns {{ files: string[], unpackedSize: number }}
 */
export function listPackFiles(root) {
  const raw = npm(['pack', '--dry-run', '--json', '--ignore-scripts'], root);
  const entry = parsePackJson(raw);
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error('npm pack --dry-run --json returned no file list');
  }
  return { files: entry.files.map((f) => f.path), unpackedSize: entry.unpackedSize };
}

/**
 * Build the stripped tarball. Returns { tarball, beforeSize, afterSize,
 * strippedCount, stagingDir }. Throws on any failure; never leaves a tarball in
 * `outDir` unless the whole run succeeded.
 */
export function packStripped({
  root = repoRoot,
  outDir,
  keepStaging = false,
  requireFile = 'dist/index.js',
  exemptPrefixes = DEFAULT_EXEMPT_PREFIXES,
  log = () => {},
}) {
  if (!outDir) throw new Error('--out <dir> is required');
  if (!fs.existsSync(path.join(root, requireFile))) {
    throw new Error(`${requireFile} is missing under ${root}: run the build (npm run build && npm run dist-pm) first`);
  }

  const { files, unpackedSize: beforeSize } = listPackFiles(root);
  if (!files.includes('package.json')) files.push('package.json');

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-pack-stripped-'));
  const pkgDir = path.join(stagingDir, 'package');
  const tarDir = path.join(stagingDir, 'tarball');
  let strippedCount = 0;
  try {
    fs.mkdirSync(tarDir, { recursive: true });
    for (const rel of files) {
      const src = path.join(root, rel);
      const dest = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (shouldStrip(rel, exemptPrefixes)) {
        const text = fs.readFileSync(src, 'utf-8');
        const out = stripComments(text, { fileName: rel });
        if (countLines(out) !== countLines(text)) {
          throw new Error(`stripping changed the line count of ${rel} (${countLines(text)} -> ${countLines(out)})`);
        }
        fs.writeFileSync(dest, out);
        strippedCount++;
      } else {
        fs.copyFileSync(src, dest);
      }
      fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
    }
    dropPackLifecycleScripts(path.join(pkgDir, 'package.json'));

    const packRaw = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', tarDir], pkgDir);
    const packEntry = parsePackJson(packRaw);
    const produced = fs.readdirSync(tarDir).filter((n) => n.endsWith('.tgz'));
    if (produced.length !== 1) {
      throw new Error(`expected exactly one tarball from npm pack, found ${produced.length}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const tarball = path.resolve(outDir, produced[0]);
    fs.copyFileSync(path.join(tarDir, produced[0]), tarball);
    log(`stripped ${strippedCount} JS file(s)`);
    return { tarball, beforeSize, afterSize: packEntry.unpackedSize, strippedCount, stagingDir: keepStaging ? stagingDir : null };
  } finally {
    if (!keepStaging) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = { exempt: [], keepStaging: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--require') opts.require = argv[++i];
    else if (a === '--exempt') opts.exempt.push(argv[++i]);
    else if (a === '--keep-staging') opts.keepStaging = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.out) throw new Error('--out <dir> is required');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::pack-stripped: ${err.message}`);
    process.exit(1);
    return;
  }
  try {
    const res = packStripped({
      root: opts.root ? path.resolve(opts.root) : repoRoot,
      outDir: path.resolve(opts.out),
      keepStaging: opts.keepStaging,
      requireFile: opts.require ?? 'dist/index.js',
      exemptPrefixes: [...DEFAULT_EXEMPT_PREFIXES, ...opts.exempt],
      log: (m) => console.error(m),
    });
    console.log(`tarball: ${res.tarball}`);
    console.log(`unpacked size: before ${res.beforeSize} bytes, after ${res.afterSize} bytes (${res.strippedCount} JS files stripped)`);
    if (res.stagingDir) console.log(`staging kept: ${res.stagingDir}`);
  } catch (err) {
    console.error(`::error::pack-stripped failed: ${err.message}`);
    if (err.stderr) console.error(String(err.stderr).slice(0, 2000));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
