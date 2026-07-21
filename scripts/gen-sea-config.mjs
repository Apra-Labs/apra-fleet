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

// Directory names excluded (recursively) when collecting package trees for the
// workflow-runtime / built-in-workflow asset sections (test fixtures, docs,
// build scripts, and standalone examples are never needed at runtime).
const PACKAGE_TREE_EXCLUDE_DIRS = new Set(['test', 'docs', 'scripts', 'examples']);

// Same as collectFiles, but skips any directory whose name is in excludeDirs
// (checked at every depth, not just the top level). `base` here is always the
// REAL path relative to root (so the returned values remain valid `join(root,
// value)` disk paths) -- unlike collectFiles's other call sites, `base` is
// never a synthetic manifest namespace.
function collectFilesFiltered(dir, base, rootBase, excludeDirs = PACKAGE_TREE_EXCLUDE_DIRS) {
  const effectiveRootBase = rootBase ?? base;
  const results = {};
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    const relPath = join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(results, collectFilesFiltered(fullPath, relPath, effectiveRootBase, excludeDirs));
    } else {
      results[relative(effectiveRootBase, relPath).replace(/\\/g, '/')] = relPath;
    }
  }
  return results;
}

// Collects a package/module tree using its REAL root-relative path (so values
// stay valid disk paths for `join(root, value)`), then re-keys the result
// under `manifestPrefix` so multiple trees can be merged into one manifest
// section (e.g. workflowRuntime) without key collisions between packages that
// each have their own package.json / src / etc.
function collectPackageTree(sourceDir, manifestPrefix) {
  const rootRelBase = relative(root, sourceDir).replace(/\\/g, '/');
  const raw = collectFilesFiltered(sourceDir, rootRelBase, rootRelBase);
  const results = {};
  for (const [shortKey, diskPath] of Object.entries(raw)) {
    results[`${manifestPrefix}/${shortKey}`] = diskPath;
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

const skills = collectFiles(join(root, 'vendor', 'apra-pm', 'skills', 'pm'), 'vendor/apra-pm/skills/pm', 'vendor/apra-pm/skills/pm');
const fleetSkills = collectFiles(join(root, 'skills', 'fleet'), 'skills/fleet');
// Sourced straight from the submodule, same as agentSchemas below -- no dist/agents
// copy step required. (Used to read from dist/agents so scripts/vendor-pm.mjs could
// inline a `<!-- GRAPH-SEMANTICS -->` marker into each agent file first; apra-pm
// PR#29 replaced that marker with an explicit prose pointer to
// vendor/apra-pm/agents/_shared/GRAPH-SEMANTICS.md in every agent file, so there is
// nothing left for vendor-pm.mjs to resolve here.)
const agentsDir = join(root, 'vendor', 'apra-pm', 'agents');
const agents = collectFiles(agentsDir, 'vendor/apra-pm/agents', 'vendor/apra-pm/agents');
const autoSprintArgsSkill = collectFiles(
  join(root, 'vendor', 'apra-pm', '.claude', 'skills', 'auto-sprint-args'),
  'vendor/apra-pm/.claude/skills/auto-sprint-args',
  'vendor/apra-pm/.claude/skills/auto-sprint-args'
);

if (Object.keys(skills).length === 0) {
  console.error('Error: vendor/apra-pm submodule is not initialized (skills/pm is empty).');
  console.error('Run: git submodule update --init');
  process.exit(1);
}
if (Object.keys(agents).length === 0) {
  console.error('Error: vendor/apra-pm submodule is not initialized (agents is empty).');
  console.error('Run: git submodule update --init');
  process.exit(1);
}

// Workflows: vendor source preferred, dist/ fallback (from vendor-pm.mjs copy)
const workflowsVendorDir = join(root, 'vendor', 'apra-pm', '.claude', 'workflows');
const workflowsDistDir = join(root, 'dist', 'workflows');
const workflowsSrcDir = existsSync(workflowsVendorDir) ? workflowsVendorDir : workflowsDistDir;
const workflows = {};
if (existsSync(workflowsSrcDir)) {
  for (const [name, assetPath] of Object.entries(collectFiles(workflowsSrcDir, workflowsSrcDir.replace(/\\/g, '/'), workflowsSrcDir.replace(/\\/g, '/')))) {
    if (name.endsWith('.js')) workflows[name] = assetPath;
  }
}

// Workflow runtime: the two @apralabs packages (workflow engine + client) plus
// the ajv validator subtree and its 4 runtime deps. Shipped as verbatim files
// (never bundled into sea-bundle.cjs) so the on-disk workflow packages can
// `import()` them at runtime with zero source changes. Hard-fail if the ajv
// dependency tree is missing -- mirrors the vendor submodule guard above.
const ajvDir = join(root, 'node_modules', 'ajv');
if (!existsSync(ajvDir)) {
  console.error('Error: node_modules/ajv is missing (required for the workflow-runtime SEA assets).');
  console.error('Run: npm install');
  process.exit(1);
}

const workflowRuntime = {
  ...collectPackageTree(join(root, 'packages', 'apra-fleet-workflow'), '@apralabs/apra-fleet-workflow'),
  ...collectPackageTree(join(root, 'packages', 'apra-fleet-client'), '@apralabs/apra-fleet-client'),
  ...collectPackageTree(ajvDir, 'ajv'),
  ...collectPackageTree(join(root, 'node_modules', 'fast-deep-equal'), 'fast-deep-equal'),
  ...collectPackageTree(join(root, 'node_modules', 'fast-uri'), 'fast-uri'),
  ...collectPackageTree(join(root, 'node_modules', 'json-schema-traverse'), 'json-schema-traverse'),
  ...collectPackageTree(join(root, 'node_modules', 'require-from-string'), 'require-from-string'),
  // undici: direct runtime dep of @apralabs/apra-fleet-client (transport.mjs
  // imports it). Absent from this list, every CI-built binary died at first
  // workflow import inside the extracted runtime with ERR_MODULE_NOT_FOUND
  // (all 3 platforms, run 29867644753) -- local builds masked it because the
  // workspace node_modules was still resolvable next to dist/. undici has no
  // runtime dependencies of its own, so the single tree suffices.
  ...collectPackageTree(join(root, 'node_modules', 'undici'), 'undici'),
};

// Guard against this list silently drifting from apra-fleet-client's real
// dependency set again: every dependency the client package declares must be
// shipped in the runtime tree above (or be one of the @apralabs packages).
const clientPkg = JSON.parse(readFileSync(join(root, 'packages', 'apra-fleet-client', 'package.json'), 'utf-8'));
for (const dep of Object.keys(clientPkg.dependencies ?? {})) {
  if (dep.startsWith('@apralabs/')) continue;
  // collectPackageTree keys assets as '<manifestPrefix>/<pathInPackage>', so a
  // shipped dependency appears as 'undici/package.json', 'ajv/dist/...', etc.
  const shipped = Object.keys(workflowRuntime).some((assetName) => assetName === dep || assetName.startsWith(`${dep}/`));
  if (!shipped) {
    console.error(`Error: @apralabs/apra-fleet-client depends on '${dep}' but gen-sea-config.mjs does not ship it in the workflow runtime tree.`);
    console.error('Add a collectPackageTree(...) entry for it above.');
    process.exit(1);
  }
}

// Agent role schemas: the glob over vendor/apra-pm/agents/schemas is
// authoritative for the file count -- do not hardcode it. Hard-fail if the
// submodule directory is missing (same guard pattern as the skills/agents
// check above).
const agentSchemasDir = join(root, 'vendor', 'apra-pm', 'agents', 'schemas');
if (!existsSync(agentSchemasDir)) {
  console.error('Error: vendor/apra-pm/agents/schemas is missing (vendor/apra-pm submodule not initialized).');
  console.error('Run: git submodule update --init');
  process.exit(1);
}
const agentSchemas = collectPackageTree(agentSchemasDir, 'agentSchemas');

// Built-in workflows: verbatim copy of the auto-sprint package tree (minus
// test/docs/scripts) plus the hello-world example authored in-repo.
const builtinWorkflows = {
  ...collectPackageTree(join(root, 'packages', 'apra-fleet-se'), 'auto-sprint'),
  ...collectPackageTree(join(root, 'examples', 'workflows', 'hello-world'), 'hello-world'),
};

const versionFile = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8'));

const manifest = {
  version: versionFile.version,
  hooks,
  scripts,
  skills,
  fleetSkills,
  agents,
  workflows,
  workflowRuntime,
  agentSchemas,
  builtinWorkflows,
  autoSprintArgsSkill,
};

writeFileSync(join(distDir, 'sea-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Generated dist/sea-manifest.json');
console.log(`  Hooks:        ${Object.keys(hooks).length} files`);
console.log(`  Scripts:      ${Object.keys(scripts).length} files`);
console.log(`  Skills (pm):  ${Object.keys(skills).length} files`);
console.log(`  Skills (fleet): ${Object.keys(fleetSkills).length} files`);
console.log(`  Agents:       ${Object.keys(agents).length} files`);
console.log(`  Workflows:    ${Object.keys(workflows).length} files`);
console.log(`  Workflow runtime:   ${Object.keys(workflowRuntime).length} files`);
console.log(`  Agent schemas:      ${Object.keys(agentSchemas).length} files`);
console.log(`  Built-in workflows: ${Object.keys(builtinWorkflows).length} files`);
console.log(`  Skill (auto-sprint-args): ${Object.keys(autoSprintArgsSkill).length} files`);

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

// Add all fleet skill files
for (const [, relPath] of Object.entries(fleetSkills)) {
  assets[relPath] = join(root, relPath);
}

// Add all agent files
for (const [, relPath] of Object.entries(agents)) {
  assets[relPath] = join(root, relPath);
}

// Add auto-sprint.js workflow as a named asset for SEA extraction
for (const [name, relPath] of Object.entries(workflows)) {
  assets[name] = existsSync(relPath) ? relPath : join(root, relPath);
}

// Add workflow-runtime, agent-schema, and built-in-workflow files
for (const [, relPath] of Object.entries(workflowRuntime)) {
  assets[relPath] = join(root, relPath);
}
for (const [, relPath] of Object.entries(agentSchemas)) {
  assets[relPath] = join(root, relPath);
}
for (const [, relPath] of Object.entries(builtinWorkflows)) {
  assets[relPath] = join(root, relPath);
}
// Add auto-sprint-args skill files
for (const [, relPath] of Object.entries(autoSprintArgsSkill)) {
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

// Blob-size delta line: total bytes of all asset files (excluding the main
// script itself), for CI to eyeball binary-size growth across builds.
let totalAssetBytes = 0;
for (const assetPath of Object.values(assets)) {
  try {
    totalAssetBytes += statSync(assetPath).size;
  } catch {
    // Asset path missing on disk (e.g. an inline-generated manifest entry) --
    // skip rather than fail the byte total.
  }
}
console.log(`  Total asset bytes: ${totalAssetBytes} (${(totalAssetBytes / (1024 * 1024)).toFixed(2)} MB)`);
