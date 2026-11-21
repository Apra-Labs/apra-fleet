import { describe, it, expect, vi, beforeEach, afterEach, afterAll, inject } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/log-helpers.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/log-helpers.js')>()),
  logWarn: warnSpy,
}));

import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../../src/paths.js';
import { releaseFileDataDir, fileDataDirViolations } from '../helpers/file-kb-data-dir.js';
import { FLEET_DIR as ISOLATED_FLEET_DIR } from '../../src/paths.js';
import { KB_CONFIG_PATH as ISOLATED_KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

// This file's OWN fleet data dir, claimed before any src module loads
// (src/paths.ts fixes FLEET_DIR at import). The per-run data dir tests/setup.ts
// provides is shared by every file of the run, and so is the KB config file
// in it (<data dir>/knowledge/config.json), which this file writes and the
// code under test reads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-providers-config-log'));
afterAll(() => releaseFileDataDir(fileDataDir));

// ISOLATION GUARD: fails if this suite reads the run-shared data dir again --
// the hoisted claim removed, moved below the imports (FLEET_DIR is then fixed
// to the shared dir), or the dir not unique to this file.
describe('isolation guard', () => {
  it('this suite reads its own fleet data dir and KB config file, not the run-shared ones', () => {
    expect(fileDataDirViolations({
      label: 'kb-providers-config-log', claimed: fileDataDir, fleetDir: ISOLATED_FLEET_DIR,
      kbConfigPath: ISOLATED_KB_CONFIG_PATH, runSharedDir: inject('APRA_FLEET_TEST_DATA_DIR'),
    })).toEqual([]);
  });
});

// The warning logged for a malformed KB config must not quote file content
// (a JSON.parse message can contain a token).

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

beforeEach(() => { warnSpy.mockClear(); resetKbProviders(); });
afterEach(() => { fs.rmSync(KB_CONFIG_PATH, { force: true }); resetKbProviders(); });

describe('malformed KB config warning', () => {
  it('names the path and a fixed reason, never the file content', async () => {
    const secret = 'sk-SECRETLOOKING-9f8e7d6c';
    fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, `{"provider": "http", "token": ${secret}`);

    await getKbProviders(KB_CONFIG_DIR);

    const lines = warnSpy.mock.calls.map(c => String(c[1]));
    const line = lines.find(l => l.includes('KB config error'));
    expect(line).toBeDefined();
    expect(line).toContain(KB_CONFIG_PATH);
    expect(line).toContain('not valid JSON');
    for (const l of lines) expect(l).not.toContain(secret);
  });
});
