#!/usr/bin/env node
// bundle-se.mjs — bundles packages/apra-fleet-se's CLI into the root
// @apralabs/apra-fleet package (apra-fleet-3ns.2), so `npm install -g
// @apralabs/apra-fleet` also gets a working `auto-sprint` binary with zero
// extra packages to publish/version-lock.
//
// Produces two dist/ artifacts:
//   - dist/auto-sprint.mjs      esbuild bundle of packages/apra-fleet-se/bin/cli.mjs
//                                and its @apralabs/apra-fleet-workflow +
//                                @apralabs/apra-fleet-client workspace deps.
//   - dist/auto-sprint-runner.mjs  a COPY (not bundled) of
//                                packages/apra-fleet-se/auto-sprint/runner.js
//                                -- loaded at runtime via engine.executeFile()
//                                (read from disk and fed to the workflow
//                                engine as text, not imported), so esbuild
//                                cannot inline it; bin/cli.mjs's
//                                resolveRunnerScriptPath() (apra-fleet-3ns.1)
//                                expects it at this sibling path in the
//                                bundled layout.
//
// Schemas: dist/agents/schemas/ (the source contracts.mjs's
// resolveSchemasDir() resolves in this bundled layout) is NOT produced
// here -- it is already populated by scripts/vendor-pm.mjs's existing
// prepublishOnly step (cpSync of vendor/apra-pm/agents -> dist/agents,
// which includes its schemas/ subdir). See apra-fleet-3ns.2.1: no new copy
// step needed for that artifact, only the build-order dependency on
// vendor-pm.mjs running (before or independently of this script, both
// before pack/publish) documented here.
//
// ajv (apra-fleet-se's only third-party runtime dependency used by
// contracts.mjs) is bundled inline -- no dynamic require, safe to inline.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sePackageRoot = join(root, 'packages', 'apra-fleet-se');
const distDir = join(root, 'dist');

console.log('Bundling apra-fleet-se CLI -> dist/auto-sprint.mjs');

await build({
  entryPoints: [join(sePackageRoot, 'bin', 'cli.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(distDir, 'auto-sprint.mjs'),
  sourcemap: false,
  minify: false, // keep readable for debugging
  // cli.mjs's own shebang (#!/usr/bin/env node) is preserved by esbuild
  // automatically when it is the first line of the entry point.
  metafile: true,
});

mkdirSync(distDir, { recursive: true });
copyFileSync(
  join(sePackageRoot, 'auto-sprint', 'runner.js'),
  join(distDir, 'auto-sprint-runner.mjs'),
);
console.log('Copied auto-sprint/runner.js -> dist/auto-sprint-runner.mjs');

console.log('Bundle written to dist/auto-sprint.mjs');
