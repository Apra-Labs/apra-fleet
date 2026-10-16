import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// npm runs `prepare` (scripts/install-hooks.mjs) on `npm pack` and
// `npm publish` too -- even with --ignore-scripts (npm 10). A test that packs
// the repo (tests/helpers/pack-install-undici.ts) must not write into the
// checkout's git hooks, so the script skips under those commands. Only the
// skip path is exercised: it never touches .git/hooks.
const script = path.join(__dirname, '..', 'scripts', 'install-hooks.mjs');

describe('install-hooks', () => {
  for (const command of ['pack', 'publish']) {
    it(`skips under npm ${command}`, () => {
      // Windows env names are case-insensitive: drop every spelling of the
      // npm_command that `npm test` itself set, or it can win over ours.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'npm_command'));
      const r = spawnSync(process.execPath, [script], {
        env: { ...env, npm_command: command },
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`install-hooks: npm ${command}, skipping`);
      expect(r.stdout).not.toContain('installed');
    });
  }
});
