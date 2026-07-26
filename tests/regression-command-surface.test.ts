/**
 * Phase 4 task 13 regression guard (apra-fleet-7pm.14): the `--version` and
 * `run --transport stdio` command surfaces must stay unchanged versus their
 * fixtures after this epic's install.ts/uninstall.ts/update.ts/index.ts edits.
 *
 * Unlike the install --help and uninstall --dry-run surfaces (tested in
 * tests/install-multi-provider.test.ts and tests/uninstall.test.ts by calling
 * the CLI functions in-process), these two surfaces are exercised by spawning
 * the actual built dist/index.js entry point -- the thing that changed in
 * Phase 2 task 5 (src/index.ts dispatch case) -- so the guard covers real CLI
 * argv dispatch, not just the underlying helper functions. This mirrors the
 * project's `npm run build` -> `npm test` CI ordering (dist/ is always built
 * before tests run there); dist/index.js is expected to already exist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverVersion } from '../src/version.js';
import {
  normalizeCommandSurfaceOutput,
  readCommandSurfaceFixture,
  fillFixturePlaceholders,
  fixtureToRegex,
} from './helpers/regression-command-surface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');

describe('command-surface regression: --version and run --transport stdio (apra-fleet-7pm.14)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_INDEX)) {
      throw new Error(
        `dist/index.js not found at ${DIST_INDEX}. Run "npm run build" before "npm test" ` +
        `(this matches the CI job ordering in .github/workflows/ci.yml).`
      );
    }
  });

  it('--version output is byte-for-byte unchanged versus its fixture', () => {
    const raw = execFileSync(process.execPath, [DIST_INDEX, '--version'], { encoding: 'utf8' });
    const actual = normalizeCommandSurfaceOutput(raw);

    // VERSION is filled with the real serverVersion (deterministic within this
    // checkout); MODE and BINARY are inherently environment-dependent (delivery
    // mode + node version, absolute path to dist/index.js) so they are matched
    // as wildcards via fixtureToRegex rather than pinned to a literal value.
    const partiallyFilled = fillFixturePlaceholders(readCommandSurfaceFixture('version-output.txt'), {
      VERSION: serverVersion,
    });
    const expectedPattern = fixtureToRegex(partiallyFilled);

    expect(actual).toMatch(expectedPattern);
  });

  it('run --transport stdio handshake is unchanged versus its fixture', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-regression-stdio-'));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX, 'run', '--transport', 'stdio'],
      env: {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        APRA_FLEET_DATA_DIR: path.join(tmp, 'data'),
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'apra-fleet-regression-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const fixtureRaw = readCommandSurfaceFixture('stdio-handshake.json');
      const filled = fillFixturePlaceholders(fixtureRaw, {
        VERSION: serverVersion,
        VERSION_NO_V: serverVersion.replace(/^v/, ''),
      });
      const expected = JSON.parse(filled);

      const serverInfo = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      const tools = await client.listTools();
      const versionResult: any = await client.callTool({ name: 'version', arguments: {} });

      expect(serverInfo?.name).toBe(expected.serverInfo.name);
      expect(serverInfo?.version).toBe(expected.serverInfo.version);
      expect(!!capabilities?.logging).toBe(expected.capabilitiesHasLogging);
      expect(tools.tools.some(t => t.name === 'version')).toBe(expected.hasVersionTool);
      expect(versionResult.content[0].text).toBe(expected.versionToolResultText);
    } finally {
      await client.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);
});
