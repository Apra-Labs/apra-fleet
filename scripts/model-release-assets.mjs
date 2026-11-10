#!/usr/bin/env node
// Fetch the pinned files of a built-in KB embedding model (default: the
// default profile), verify each against its pinned sha256, and write them
// under the release asset names the model store's GitHub release source
// requests (modelReleaseAssets / modelReleaseAssetName in
// src/services/knowledge/embedding/profiles.ts). The release workflow
// (.github/workflows/ci.yml, release and prerelease jobs) runs this and
// uploads the written files as release assets.
//
// The asset list comes from profiles.ts itself, imported as TypeScript source
// (no build needed): run with node --experimental-strip-types on Node 22
// (type stripping is on by default from Node 23.6). profiles.ts has no
// imports and only erasable TypeScript syntax, which keeps this working.
//
// Usage:
//   node --experimental-strip-types scripts/model-release-assets.mjs --dry-run [--model <name>]
//       print "<asset name> <sha256> <path>" per file; no network, nothing written
//   node --experimental-strip-types scripts/model-release-assets.mjs --out <dir> [--model <name>]
//       download from HF_ENDPOINT (default https://huggingface.co), verify, write <dir>/<asset name>
//
// Exit codes: 0 ok, 1 download or sha256 failure, 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILES_SOURCE = path.join(REPO_ROOT, 'src', 'services', 'knowledge', 'embedding', 'profiles.ts');

/** Load profiles.ts (needs type stripping in the running node). */
export async function loadProfiles(file = PROFILES_SOURCE) {
  return import(pathToFileURL(file).href);
}

/**
 * The asset plan of one built-in model: [{ name, path, sha256, url }], url
 * being the Hugging Face download of the file at the pinned revision.
 */
export function assetPlan(profiles, modelName, hubEndpoint = 'https://huggingface.co') {
  const name = modelName ?? profiles.DEFAULT_EMBEDDING_PROFILE;
  if (!Object.prototype.hasOwnProperty.call(profiles.BUILTIN_EMBEDDING_PROFILES, name)) {
    throw new Error(`unknown built-in model "${name}"; valid: ${Object.keys(profiles.BUILTIN_EMBEDDING_PROFILES).join(', ')}`);
  }
  const profile = profiles.BUILTIN_EMBEDDING_PROFILES[name];
  const { repo, revision } = profile.source;
  const hub = hubEndpoint.replace(/\/+$/, '');
  return profiles.modelReleaseAssets(profile).map((a) => ({
    ...a,
    url: `${hub}/${repo}/resolve/${encodeURIComponent(revision)}/${a.path}`,
  }));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const out = { dryRun: false, out: null, model: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out') out.out = argv[++i] ?? null;
    else if (a === '--model') out.model = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.dryRun && !out.out) throw new Error('give --dry-run or --out <dir>');
  return out;
}

export async function main(argv = process.argv.slice(2), log = console.log, error = console.error) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(`model-release-assets: ${err.message}`);
    return 2;
  }
  let plan;
  try {
    plan = assetPlan(await loadProfiles(), args.model, process.env.HF_ENDPOINT || 'https://huggingface.co');
  } catch (err) {
    error(`model-release-assets: ${err.message}`);
    return 2;
  }
  if (args.dryRun) {
    for (const a of plan) log(`${a.name} ${a.sha256} ${a.path}`);
    return 0;
  }
  fs.mkdirSync(args.out, { recursive: true });
  for (const a of plan) {
    let body;
    try {
      const res = await fetch(a.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      error(`model-release-assets: download of ${a.url} failed: ${err.message}`);
      return 1;
    }
    const actual = sha256(body);
    if (actual !== a.sha256) {
      error(`model-release-assets: sha256 mismatch for ${a.path}: expected ${a.sha256}, got ${actual}`);
      return 1;
    }
    fs.writeFileSync(path.join(args.out, a.name), body);
    log(`${a.name} ${a.sha256} ${a.path}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`model-release-assets: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
