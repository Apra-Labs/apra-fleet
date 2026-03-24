#!/usr/bin/env node
/**
 * gen-sea-config.mjs — Generate SEA config with asset manifest
 *
 * Scans hooks/, scripts/, skills/pm/ and builds:
 * 1. dist/sea-manifest.json — asset index for install.ts
 * 2. dist/sea-config.json   — Node.js SEA configuration
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

mkdirSync(distDir, { recursive: true });

// Collect files recursively
function collectFiles(dir, base, rootBase) {
  const effectiveRootBase = rootBase ?? base;
  const results = {};
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(results, collectFiles(fullPath, relPath, effectiveRootBase));
    } else {
      results[relative(effectiveRootBase, relPath).replace(/\\/g, '/')] = relPath;
    }
  }
  return results;
}

// Build manifest — use collectFiles for all three (handles subdirectories)
const hooks = collectFiles(join(root, 'hooks'), 'hooks');

const allScripts = collectFiles(join(root, 'scripts'), 'scripts');
// Filter out build scripts — only include runtime scripts
const scripts = {};
for (const [name, assetPath] of Object.entries(allScripts)) {
  if (!name.endsWith('.mjs')) scripts[name] = assetPath;
}

const skills = collectFiles(join(root, 'skills', 'pm'), 'skills/pm');

const versionFile = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8'));

const manifest = {
  version: versionFile.version,
  hooks,
  scripts,
  skills,
};

writeFileSync(join(distDir, 'sea-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Generated dist/sea-manifest.json');
console.log(`  Hooks:   ${Object.keys(hooks).length} files`);
console.log(`  Scripts: ${Object.keys(scripts).length} files`);
console.log(`  Skills:  ${Object.keys(skills).length} files`);

// Build SEA config with assets
const assets = {};

// Add manifest itself
assets['manifest.json'] = join(distDir, 'sea-manifest.json');

// Add all hook files
for (const [, relPath] of Object.entries(hooks)) {
  assets[relPath] = join(root, relPath);
}

// Add all script files
for (const [, relPath] of Object.entries(scripts)) {
  assets[relPath] = join(root, relPath);
}

// Add all skill files
for (const [, relPath] of Object.entries(skills)) {
  assets[relPath] = join(root, relPath);
}

const seaConfig = {
  main: join(distDir, 'sea-bundle.cjs'),
  output: join(distDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
};

writeFileSync(join(distDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
console.log('Generated dist/sea-config.json');
console.log(`  Total assets: ${Object.keys(assets).length}`);
