import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/log-helpers.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/log-helpers.js')>()),
  logWarn: warnSpy,
}));

import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../../src/paths.js';

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
