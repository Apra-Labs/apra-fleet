/**
 * apra-fleet-i9ag.1.2 item 3: end-to-end verification that an npm-INSTALLED
 * apra-fleet (as a real dependency in a throwaway consumer project, not a
 * repo checkout) serves GET /ui.
 *
 * Reuses tests/helpers/pack-install-undici.ts's packAndInstall() /
 * isNpmAvailable() (the same pack+install approach tests/undici-pack-install
 * .test.ts already uses) rather than inventing a new one. Kept in its own
 * file (not appended to undici-pack-install.test.ts) since the two guard
 * unrelated regressions (undici resolution vs. the console shell); both
 * still run under the plain `npm test` default suite -- this is not gated
 * behind an opt-in flag, matching the acceptance criteria's "must actually
 * run under npm test, not be skipped by default".
 *
 * Isolation (planner addendum on this bead): points HOME, USERPROFILE,
 * HOMEDRIVE/HOMEPATH (win32) and APRA_FLEET_DATA_DIR at a temp dir before
 * spawning the installed server, and restores nothing in-process (the
 * server is a child process with its own env, so the parent's env is never
 * touched) -- no file under the real user home or real fleet data dir is
 * created or modified by this test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNpmAvailable, packAndInstall, type PackInstallResult } from './helpers/pack-install-undici.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForUi(port: number, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/ui`);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`installed apra-fleet never answered GET /ui on port ${port} within ${timeoutMs}ms: ${String(lastErr)}`);
}

describe('npm-installed apra-fleet serves GET /ui (apra-fleet-i9ag.1.2)', () => {
  if (!isNpmAvailable()) {
    it.skip('npm is unavailable in this environment -- skipping pack/install verification', () => {});
    return;
  }

  let result: PackInstallResult | undefined;

  afterAll(() => {
    result?.cleanup();
  }, 30_000);

  it(
    'installs the packed tarball into a fresh consumer project and GET /ui answers 200 with the shell html',
    async () => {
      result = packAndInstall(repoRoot);
      const { installedRoot, scratchDir } = result;
      expect(fs.existsSync(installedRoot), `installed package root should exist at ${installedRoot}`).toBe(true);

      const installedIndexJs = path.join(installedRoot, 'dist', 'index.js');
      expect(fs.existsSync(installedIndexJs), `installed dist/index.js should exist at ${installedIndexJs}`).toBe(true);
      const installedShellIndexHtml = path.join(installedRoot, 'packages', 'apra-fleet-shell-ui', 'dist', 'index.html');
      expect(
        fs.existsSync(installedShellIndexHtml),
        `installed shell dist should exist at ${installedShellIndexHtml} (apra-fleet-v6t7.11's 'files' entry)`,
      ).toBe(true);

      const isolatedHome = path.join(scratchDir, 'isolated-home');
      fs.mkdirSync(isolatedHome, { recursive: true });
      const dataDir = path.join(isolatedHome, 'data');

      let child: ChildProcess | undefined;
      try {
        const port = await getFreePort();
        expect(port).not.toBe(7601);
        expect(port).not.toBe(8801);

        child = spawn(process.execPath, [installedIndexJs, 'run'], {
          cwd: path.join(scratchDir, 'consumer'),
          env: {
            ...process.env,
            HOME: isolatedHome,
            USERPROFILE: isolatedHome,
            HOMEDRIVE: isolatedHome.slice(0, 2), // win32 os.homedir() fallback (drive letter, e.g. "C:")
            HOMEPATH: isolatedHome.slice(2),
            APRA_FLEET_DATA_DIR: dataDir,
            APRA_FLEET_PORT: String(port),
            APRA_FLEET_HOST: '127.0.0.1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderrBuf = '';
        child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

        const exitedEarly = new Promise<never>((_, reject) => {
          child!.once('exit', (code) => reject(new Error(`installed apra-fleet exited early with code ${code}. stderr:\n${stderrBuf}`)));
        });

        const uiResp = await Promise.race([waitForUi(port, 20000), exitedEarly]);
        expect(uiResp.status).toBe(200);
        const uiHtml = await uiResp.text();
        expect(uiHtml.toLowerCase()).toContain('<html');
      } finally {
        if (child && !child.killed) child.kill();
      }

      // No file under the real user home or real fleet data dir was touched
      // (planner addendum): fleet.key must have been created under the
      // ISOLATED home, never the real one.
      expect(fs.existsSync(path.join(isolatedHome, '.apra-fleet', 'fleet.key'))).toBe(true);
    },
    5 * 60 * 1000,
  );
});
