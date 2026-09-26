#!/usr/bin/env node
/**
 * build-ui-checked.mjs (apra-fleet-i9ag.1.1) -- runs `npm run build:ui`, then
 * verifies packages/apra-fleet-shell-ui/dist/index.html actually exists.
 *
 * Why this wrapper exists: a raw vite build failure (or a build:ui that
 * silently no-ops) does not, on its own, name
 * packages/apra-fleet-shell-ui/dist in its output -- the release build
 * chain (npm run build:binary, npm run prepublishOnly) must never ship
 * without the console shell, and must fail with a message an operator can
 * act on immediately, not a downstream 404 discovered later. The check is
 * plain JS (not shell syntax) so it behaves identically under PowerShell
 * and POSIX shells -- see CLAUDE.md's "never rely on shell-level variable
 * expansion in npm scripts" rule.
 *
 * Usage: node scripts/build-ui-checked.mjs
 * Exit 0: build:ui succeeded and the shell dist's index.html exists.
 * Exit 1: build:ui itself failed (its own output is passed through), or it
 *   exited 0 but left packages/apra-fleet-shell-ui/dist/index.html missing.
 *
 * Test hooks (apra-fleet-i9ag.1.2) -- unset in every real build invocation:
 *   APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE: JSON array, e.g. '["node","-e","process.exit(1)"]',
 *     replacing the spawned `npm run build:ui` command/args entirely. Lets a
 *     test exercise the "build itself failed" and "build exited 0 but did
 *     nothing" failure paths without invoking (or breaking) the real vite
 *     build.
 *   APRA_FLEET_SHELL_INDEX_HTML_OVERRIDE: absolute path, replacing the
 *     packages/apra-fleet-shell-ui/dist/index.html existence check. Lets a
 *     test exercise the "exited 0 but index.html still missing" path against
 *     a scratch directory instead of the live shell dist.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const shellIndexHtml = process.env.APRA_FLEET_SHELL_INDEX_HTML_OVERRIDE
  ? process.env.APRA_FLEET_SHELL_INDEX_HTML_OVERRIDE
  : join(root, 'packages', 'apra-fleet-shell-ui', 'dist', 'index.html');

const commandOverride = process.env.APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE
  ? JSON.parse(process.env.APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE)
  : null;
const [spawnCmd, ...spawnArgs] = commandOverride ?? ['npm', 'run', 'build:ui'];

// shell: true resolves the npm.cmd shim on Windows (mirrors
// scripts/check-pack-size.mjs's getRawInput) -- 'build:ui' is a static
// literal, never caller-controlled; the test-only override above is only
// ever set by this repo's own tests, never external input.
const result = spawnSync(spawnCmd, spawnArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

if (result.status !== 0) {
  console.error('Error: "npm run build:ui" failed -- packages/apra-fleet-shell-ui/dist was not (re)built.');
  process.exit(typeof result.status === 'number' && result.status !== 0 ? result.status : 1);
}

if (!existsSync(shellIndexHtml)) {
  console.error(
    `Error: "npm run build:ui" exited 0 but packages/apra-fleet-shell-ui/dist/index.html is still missing ` +
      `(expected at ${shellIndexHtml}). The release build must not continue without the console shell.`,
  );
  process.exit(1);
}

console.log(`OK: packages/apra-fleet-shell-ui/dist/index.html present (${shellIndexHtml}).`);
