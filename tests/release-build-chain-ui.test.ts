/**
 * apra-fleet-i9ag.1.2: verifies the release build chain (build:binary,
 * prepublishOnly) actually reaches build:ui, that build:binary uses strict
 * gen-sea-config, and that the build:ui wrapper (scripts/build-ui-checked.mjs,
 * apra-fleet-i9ag.1.1) fails loudly -- naming packages/apra-fleet-shell-ui/dist
 * -- for both shell-build failure modes.
 *
 * Scoped deliberately NOT to duplicate:
 *  - tests/pack-shell-dist.test.ts (packed index.html/assets, apra-fleet-v6t7.11)
 *  - tests/gen-sea-config.test.ts's ui-section branches (gen-sea-config's own
 *    strict/default/present behaviour, apra-fleet-v6t7.3.2)
 *  - tests/sea-http-verify.test.ts's binary smoke (apra-fleet-v6t7.3.2)
 *
 * This file never runs the real (slow) vite build and never touches the live
 * packages/apra-fleet-shell-ui/dist or packages/apra-fleet-shell-ui/src trees
 * -- the failure-path cases below drive scripts/build-ui-checked.mjs through
 * its two test-only env hooks (APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE,
 * APRA_FLEET_SHELL_INDEX_HTML_OVERRIDE), never a real build.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const wrapperScript = path.join(root, 'scripts', 'build-ui-checked.mjs');

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { scripts: Record<string, string> };
  return pkg.scripts;
}

// A script "reaches" build:ui if it invokes it directly (`npm run build:ui`)
// or through the named wrapper (`npm run build:ui:checked`, which itself
// runs `npm run build:ui` -- see scripts/build-ui-checked.mjs).
function reachesBuildUi(scripts: Record<string, string>, scriptName: string): boolean {
  const line = scripts[scriptName] ?? '';
  if (/\bnpm run build:ui\b/.test(line)) return true;
  if (/\bnpm run build:ui:checked\b/.test(line)) {
    return /\bnpm run build:ui\b/.test(scripts['build:ui:checked'] ?? '');
  }
  return false;
}

describe('release build chain invokes build:ui (apra-fleet-i9ag.1.2)', () => {
  it('build:binary reaches build:ui', () => {
    const scripts = readScripts();
    expect(reachesBuildUi(scripts, 'build:binary')).toBe(true);
  });

  it('prepublishOnly reaches build:ui', () => {
    const scripts = readScripts();
    expect(reachesBuildUi(scripts, 'prepublishOnly')).toBe(true);
  });

  it('build:binary runs gen-sea-config in strict (--require-ui) mode', () => {
    const scripts = readScripts();
    expect(scripts['build:binary']).toMatch(/gen-sea-config\.mjs[^&|]*--require-ui/);
  });

  // Regression pin, demonstrated directly (no exported function to unit test
  // -- package.json 'scripts' has no build step of its own): a package.json
  // with build:ui removed from these two scripts must fail the assertions
  // above, proving they are not vacuously true.
  it('regression pin: removing build:ui from build:binary/prepublishOnly would fail the reachesBuildUi checks', () => {
    const scripts = readScripts();
    const strippedBinary = scripts['build:binary'].replace(/&&\s*npm run build:ui(:checked)?\s*/, '&& ');
    const strippedPublish = scripts['prepublishOnly'].replace(/&&\s*npm run build:ui(:checked)?\s*/, '');
    expect(reachesBuildUi({ ...scripts, 'build:binary': strippedBinary }, 'build:binary')).toBe(false);
    expect(reachesBuildUi({ ...scripts, prepublishOnly: strippedPublish }, 'prepublishOnly')).toBe(false);
  });
});

describe('scripts/build-ui-checked.mjs failure paths (apra-fleet-i9ag.1.2)', () => {
  const shellIndexHtml = path.join(root, 'packages', 'apra-fleet-shell-ui', 'dist', 'index.html');
  let beforeState: { existed: boolean; mtimeMs?: number };

  beforeAll(() => {
    beforeState = fs.existsSync(shellIndexHtml)
      ? { existed: true, mtimeMs: fs.statSync(shellIndexHtml).mtimeMs }
      : { existed: false };
  });

  afterAll(() => {
    // Neither failure-path run below ever touches the real
    // packages/apra-fleet-shell-ui/dist tree -- both use command/path test
    // hooks that redirect the wrapper at a no-op command and/or a scratch
    // path instead.
    const afterState = fs.existsSync(shellIndexHtml)
      ? { existed: true, mtimeMs: fs.statSync(shellIndexHtml).mtimeMs }
      : { existed: false };
    expect(afterState).toEqual(beforeState);
  });

  it('names packages/apra-fleet-shell-ui/dist and exits non-zero when the shell build itself fails', () => {
    const result = spawnSync('node', [wrapperScript], {
      cwd: root,
      encoding: 'utf-8',
      env: {
        ...process.env,
        APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE: JSON.stringify(['node', '-e', 'process.exit(1)']),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('packages/apra-fleet-shell-ui/dist');
  });

  it('names packages/apra-fleet-shell-ui/dist and exits non-zero when the shell build exits 0 but leaves no index.html', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-ui-checked-noop-'));
    try {
      const missingIndexHtml = path.join(scratchDir, 'index.html'); // deliberately never created
      const result = spawnSync('node', [wrapperScript], {
        cwd: root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          APRA_FLEET_BUILD_UI_COMMAND_OVERRIDE: JSON.stringify(['node', '-e', 'process.exit(0)']),
          APRA_FLEET_SHELL_INDEX_HTML_OVERRIDE: missingIndexHtml,
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('packages/apra-fleet-shell-ui/dist');
      expect(fs.existsSync(missingIndexHtml)).toBe(false); // the no-op build genuinely created nothing
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

});
