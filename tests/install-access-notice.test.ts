/**
 * An install that changed an MCP registration persists the restart-every-LLM-
 * session text as a pending service notice, so users who upgrade with
 * `apra-fleet update` (install runs detached, stdio ignored) still see it on the
 * next status / start / update -- exactly once. Sandboxed FLEET_DIR only.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { sandbox, mockCheckRunning } = vi.hoisted(() => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'apra-access-notice-'));
  process.env.APRA_FLEET_DATA_DIR = dir;
  return { sandbox: dir as string, mockCheckRunning: vi.fn() };
});

// status/start reach the notice call first; stopping at checkRunningInstance
// keeps them from touching the service, the network or spawning a server.
vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
}));
vi.mock('../src/cli/install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cli/install.js')>()),
  isSea: vi.fn(() => false),
  isNpmGlobalInstall: vi.fn(() => true),
}));

import { ACCESS_RESTART_NOTE, recordAccessRestartNotice } from '../src/cli/install.js';
import { SERVICE_NOTICE_PATH, writeServiceNotice } from '../src/services/service-notice.js';
import { runStatus } from '../src/cli/status.js';
import { runStart } from '../src/cli/start.js';
import { runUpdate } from '../src/cli/update.js';

let errSpy: ReturnType<typeof vi.spyOn>;

function noticePrints(): number {
  return errSpy.mock.calls.filter(c => String(c[0]).includes(ACCESS_RESTART_NOTE)).length;
}
async function runVerb(verb: 'status' | 'start' | 'update'): Promise<void> {
  try {
    if (verb === 'status') await runStatus([]);
    else if (verb === 'start') await runStart([]);
    else await runUpdate();
  } catch { /* the verb body after the notice is out of scope here */ }
}

beforeEach(() => {
  mockCheckRunning.mockRejectedValue(new Error('stop here'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  fs.rmSync(SERVICE_NOTICE_PATH, { force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('restart-sessions access notice persisted by a detached install', () => {
  it('the notice file lives in the sandboxed FLEET_DIR', () => {
    expect(path.dirname(SERVICE_NOTICE_PATH).startsWith(sandbox)).toBe(true);
    expect(ACCESS_RESTART_NOTE).toMatch(/^[\x20-\x7e]+$/);
  });

  for (const verb of ['status', 'start', 'update'] as const) {
    it(`${verb}: first call prints the restart text once, the second prints nothing`, async () => {
      recordAccessRestartNotice(true, false);
      await runVerb(verb);
      expect(noticePrints()).toBe(1);
      await runVerb(verb);
      expect(noticePrints()).toBe(1);
    });
  }

  it('shown once across verbs: status prints it, then start and update do not', async () => {
    recordAccessRestartNotice(true, false);
    await runVerb('status');
    await runVerb('start');
    await runVerb('update');
    expect(noticePrints()).toBe(1);
  });

  it('an install that changed no registration leaves no notice', async () => {
    recordAccessRestartNotice(false, false);
    expect(fs.existsSync(SERVICE_NOTICE_PATH)).toBe(false);
    for (const v of ['status', 'start', 'update'] as const) await runVerb(v);
    expect(noticePrints()).toBe(0);
  });

  it('an interactive install already printed it inline, so no verb repeats it', async () => {
    recordAccessRestartNotice(true, true);
    for (const v of ['status', 'start', 'update'] as const) await runVerb(v);
    expect(noticePrints()).toBe(0);
  });

  it('keeps a pending unshown legacy-task notice: both texts print once', async () => {
    const LEGACY = 'LEGACY-TASK-GUIDANCE fix the elevated task by hand';
    writeServiceNotice(LEGACY);
    recordAccessRestartNotice(true, false);
    await runVerb('status');
    const printed = errSpy.mock.calls.map(c => String(c[0])).filter(s => s.includes(ACCESS_RESTART_NOTE));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(LEGACY);
    await runVerb('start');
    await runVerb('update');
    expect(noticePrints()).toBe(1);
  });

  it('an inline-shown access note does not clobber or re-add to a pending notice', async () => {
    const LEGACY = 'LEGACY-TASK-GUIDANCE fix the elevated task by hand';
    writeServiceNotice(LEGACY);
    recordAccessRestartNotice(true, true);
    await runVerb('status');
    const printed = errSpy.mock.calls.map(c => String(c[0]));
    expect(printed.some(s => s.includes(LEGACY))).toBe(true);
    expect(noticePrints()).toBe(0);
  });

  it('runInstall records the notice only for a changed, non-member registration', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'install.ts'), 'utf8');
    expect(src).toContain('recordAccessRestartNotice(registrationChanged && !memberMode,');
  });

  it('the sandbox is the only place written', () => {
    recordAccessRestartNotice(true, false);
    expect(fs.readdirSync(sandbox)).toEqual(['service-notice.json']);
    expect(os.tmpdir()).toBeTruthy();
  });
});
