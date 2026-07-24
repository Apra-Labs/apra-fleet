#!/usr/bin/env node
// bundle-se.mjs — bundles packages/apra-fleet-se's CLI into the root
// @apralabs/apra-fleet package (apra-fleet-3ns.2), so `npm install -g
// @apralabs/apra-fleet` also gets a working `auto-sprint` binary with zero
// extra packages to publish/version-lock.
//
// Produces dist/ artifacts:
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
//   - dist/contracts.mjs, dist/errors.mjs, dist/viewer-extensions.mjs
//                                verbatim copies of runner.js's own sibling
//                                modules. runner.js imports these via
//                                relative specifiers ('./contracts.mjs' etc)
//                                which esbuild cannot rewrite for us since
//                                runner.js itself is never bundled (see
//                                above) -- it is read from disk as text by
//                                engine.executeFile(). Without these siblings
//                                also present next to dist/auto-sprint-
//                                runner.mjs, a clean global npm install could
//                                never satisfy these relative imports
//                                (apra-fleet-7pm.12).
//   - dist/node_modules/@apralabs/apra-fleet-workflow/,
//     dist/node_modules/@apralabs/apra-fleet-client/
//                                verbatim vendor copies of the two private
//                                (never-published) workspace packages.
//                                runner.js and its copied siblings above
//                                statically import '@apralabs/apra-fleet-
//                                workflow' (and, transitively via
//                                viewer-extensions.mjs, '@apralabs/apra-
//                                fleet-workflow/viewer/html-utils'). In a
//                                monorepo checkout or a bundled dev tree
//                                these resolve via the workspace's hoisted
//                                node_modules; in a CLEAN global npm install
//                                (no monorepo ancestor, `@apralabs/apra-
//                                fleet-workflow` never published to the
//                                registry) there is nothing for Node's
//                                module resolution to find. Vendoring a
//                                verbatim copy into dist/node_modules/ here
//                                gives Node's upward node_modules walk
//                                (starting from dist/auto-sprint-runner.mjs)
//                                somewhere to land, with zero runtime
//                                behavior change from the workspace source
//                                (apra-fleet-7pm.12).
//
// Schemas: dist/agents/schemas/ (the source contracts.mjs's
// resolveSchemasDir() resolves in this bundled layout) is NOT produced
// here -- it is already populated by scripts/dist-pm.mjs's existing
// prepublishOnly step (cpSync of packages/apra-fleet-se/apra-pm/agents -> dist/agents,
// which includes its schemas/ subdir). See apra-fleet-3ns.2.1: no new copy
// step needed for that artifact, only the build-order dependency on
// dist-pm.mjs running (before or independently of this script, both
// before pack/publish) documented here.
//
// ajv (apra-fleet-se's only third-party runtime dependency used by
// contracts.mjs) is bundled inline for dist/auto-sprint.mjs -- no dynamic
// require, safe to inline. The COPY of contracts.mjs at dist/contracts.mjs
// (loaded unbundled by the runner, see above) still does a real bare-
// specifier `import Ajv from 'ajv'`. An earlier revision of this fix relied
// on declaring `ajv` as a real root package.json dependency so a consumer's
// `npm install -g` would place it in their own node_modules -- but that only
// helps when the *installer* actually runs `npm install` against this
// package's own package.json (which a real `npm install -g` does, but which
// CI's clean-prefix smoke test deliberately does NOT, to test the packed
// tarball's own self-sufficiency -- see .github/workflows/ci.yml's "Pack +
// install into a clean temp prefix" step). Vendoring ajv (and its own
// transitive deps, hoisted flat in this repo's node_modules/) directly into
// dist/node_modules/ here removes that reliance on host npm install
// altogether, matching the same self-contained strategy already used for
// the two @apralabs/* workspace packages below (apra-fleet-7pm.12).

import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sePackageRoot = join(root, 'packages', 'apra-fleet-se');
const distDir = join(root, 'dist');

/**
 * Vendors a private (unpublished) workspace package into
 * dist/node_modules/@apralabs/<name>/, copying only what its package.json
 * `exports` map can point at (package.json + src/) -- not test/, docs/, etc.
 * @param {string} pkgDir absolute path to the workspace package root
 * @param {string} pkgName the bare `@apralabs/<name>` package name
 */
function vendorWorkspacePackage(pkgDir, pkgName) {
  const destDir = join(distDir, 'node_modules', pkgName);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(join(pkgDir, 'package.json'), join(destDir, 'package.json'));
  cpSync(join(pkgDir, 'src'), join(destDir, 'src'), { recursive: true });
  console.log(`Vendored ${pkgName} -> dist/node_modules/${pkgName}`);
}

/**
 * Vendors a real npm package (and, recursively, its own `dependencies`)
 * from this repo's root node_modules/ into dist/node_modules/, so bare
 * specifiers like `import Ajv from 'ajv'` in unbundled files (e.g. the
 * copied dist/contracts.mjs) resolve via Node's upward node_modules walk
 * from dist/auto-sprint-runner.mjs with no dependency on a consumer's own
 * `npm install` step.
 * @param {string} pkgName the bare npm package name (no scope subpaths)
 * @param {Set<string>} seen internal recursion guard against cycles/dupes
 */
function vendorNpmPackage(pkgName, seen = new Set()) {
  if (seen.has(pkgName)) return;
  seen.add(pkgName);

  const srcDir = join(root, 'node_modules', pkgName);
  if (!existsSync(srcDir)) {
    throw new Error(
      `vendorNpmPackage: ${pkgName} not found in ${srcDir} -- run 'npm install' at the repo root first.`,
    );
  }
  const destDir = join(distDir, 'node_modules', pkgName);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
  console.log(`Vendored ${pkgName} -> dist/node_modules/${pkgName}`);

  const pkgJson = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf-8'));
  for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
    vendorNpmPackage(dep, seen);
  }
}

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

for (const name of ['contracts.mjs', 'errors.mjs', 'viewer-extensions.mjs']) {
  copyFileSync(join(sePackageRoot, 'auto-sprint', name), join(distDir, name));
  console.log(`Copied auto-sprint/${name} -> dist/${name}`);
}

vendorWorkspacePackage(join(root, 'packages', 'apra-fleet-workflow'), '@apralabs/apra-fleet-workflow');
vendorWorkspacePackage(join(root, 'packages', 'apra-fleet-client'), '@apralabs/apra-fleet-client');
vendorNpmPackage('ajv');

console.log('Bundle written to dist/auto-sprint.mjs');
