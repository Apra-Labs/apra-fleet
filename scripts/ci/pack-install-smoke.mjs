#!/usr/bin/env node
// Clean-prefix install smoke for a packed apra-fleet tarball. Shared by the
// ci.yml `package` and `npm-publish` jobs and runnable locally:
//
//   node scripts/ci/pack-install-smoke.mjs --tarball <file.tgz> [--keep]
//
// Installs the tarball into a fresh non-monorepo prefix, with HOME,
// USERPROFILE and APRA_FLEET_DATA_DIR pointing into a throwaway directory
// (no real credentials or user state are touched), then proves:
//   - dist/agents/schemas/*.json shipped in the tarball;
//   - `apra-fleet install --skill none --workflows all --transport stdio` works
//     (cli.mjs's bare-specifier imports only land on disk via this extraction
//     step, not via plain `npm install`);
//   - `apra-fleet --version` works;
//   - `apra-fleet workflow fleet-sprint --help` prints the usage text and does
//     NOT fall back to the monorepo dev path (which would warn 'Using the local
//     apra-pm copy'), i.e. schemas resolve from the co-packaged dist/agents/schemas/.
// Any failure exits nonzero with a clear message.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG_NAME = '@apralabs/apra-fleet';

function fail(msg) {
  throw new Error(msg);
}

export function runSmoke({ tarball, keep = false, log = console.log }) {
  if (!tarball) fail('--tarball <file.tgz> is required');
  const tgz = path.resolve(tarball);
  if (!fs.existsSync(tgz)) fail(`tarball not found: ${tgz}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-pack-smoke-'));
  try {
    const prefix = path.join(work, 'prefix');
    const fakeHome = path.join(work, 'home');
    fs.mkdirSync(prefix, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    log(`installing ${tgz} into a clean prefix`);
    const inst = spawnSync('npm', ['install', '--prefix', prefix, tgz, '--no-save', '--no-audit', '--no-fund'], {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inst.status !== 0) fail(`npm install of the tarball failed:\n${inst.stdout}\n${inst.stderr}`);

    const pkgDir = path.join(prefix, 'node_modules', ...PKG_NAME.split('/'));
    const entry = path.join(pkgDir, 'dist', 'index.js');
    if (!fs.existsSync(entry)) fail(`installed package has no dist/index.js at ${entry}`);

    const schemasDir = path.join(pkgDir, 'dist', 'agents', 'schemas');
    if (!fs.existsSync(schemasDir)) fail('dist/agents/schemas/ missing from the packed tarball.');
    const schemaCount = fs.readdirSync(schemasDir).filter((n) => n.endsWith('.json')).length;
    if (schemaCount === 0) fail('dist/agents/schemas/ is present but contains no *.json files.');

    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APRA_FLEET_DATA_DIR: path.join(fakeHome, 'data'),
    };
    const fleet = (args) =>
      spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

    // --ignore-running-sprints: the install guard refuses while a real sprint or
    // supervisor runs on this machine (a developer running the smoke locally,
    // mid-sprint). Nothing real is replaced here -- HOME and the data dir are the
    // throwaway fake -- so the guard is irrelevant to this sandboxed install.
    const install = fleet(['install', '--skill', 'none', '--workflows', 'all', '--transport', 'stdio', '--ignore-running-sprints']);
    if (install.status !== 0) fail(`apra-fleet install failed (exit ${install.status}):\n${install.stdout}\n${install.stderr}`);

    const version = fleet(['--version']);
    if (version.status !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)) {
      fail(`apra-fleet --version failed (exit ${version.status}):\n${version.stdout}\n${version.stderr}`);
    }
    log(`apra-fleet --version: ${version.stdout.trim()}`);

    const help = fleet(['workflow', 'fleet-sprint', '--help']);
    if (help.status !== 0) fail(`fleet-sprint --help exited ${help.status}:\n${help.stdout}\n${help.stderr}`);
    if (!help.stdout.includes('Usage: fleet-se sprint')) {
      fail(`fleet-sprint --help did not produce the expected usage text:\n${help.stdout}`);
    }
    if (help.stderr.includes('Using the local apra-pm copy')) {
      fail(
        'apra-fleet workflow fleet-sprint fell back to the local apra-pm dev path instead of resolving the packaged ' +
          `dist/agents/schemas/ -- the tarball's schema bundling is broken.\n${help.stderr}`,
      );
    }
    log('Clean install smoke test passed: install, --version, and fleet-sprint --help (no dev-fallback warning)');
    return { version: version.stdout.trim(), schemaCount };
  } finally {
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
    else log(`kept smoke workspace: ${work}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let tarball;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tarball') tarball = argv[++i];
    else if (argv[i].startsWith('--tarball=')) tarball = argv[i].slice('--tarball='.length);
    else if (argv[i] === '--keep') keep = true;
    else {
      console.error(`::error::pack-install-smoke: unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  try {
    runSmoke({ tarball, keep });
  } catch (err) {
    console.error(`::error::pack-install-smoke failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
