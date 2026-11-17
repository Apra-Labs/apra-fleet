/**
 * apra-fleet-uob4: the Windows stall commands really executed on this host
 * through the REAL registry -> getStrategy -> LocalStrategy path (no mocks).
 * A raw `powershell -c "..."` one-liner was re-parsed by the outer
 * powershell.exe that LocalStrategy spawns, so `$c` expanded to empty and the
 * log tail silently returned nothing; a `'` in the path broke the quoting.
 * Windows-only: the POSIX branch is untouched by that fix.
 *
 * Isolation: registry lives in the per-run APRA_FLEET_DATA_DIR from
 * tests/setup.ts; fixtures live in a fresh temp dir. No real user data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addAgent } from '../src/services/registry.js';
import { pollLogFile } from '../src/services/stall/stall-poller.js';
import { readLogTail } from '../src/services/stall/read-log-tail.js';
import { backupAndResetRegistry, restoreRegistry, makeTestLocalAgent } from './test-helpers.js';

const LAST_TS = '2026-09-29T10:00:05.000Z';
const FIXTURE = [
  { type: 'user', timestamp: '2026-09-29T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', timestamp: '2026-09-29T10:00:01.000Z', message: { content: [{ type: 'text', text: 'ok' }] } },
  { type: 'assistant', timestamp: LAST_TS, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 500', timeout: 600000 } }] } },
].map(l => JSON.stringify(l)).join('\n') + '\n';

describe.runIf(process.platform === 'win32')('Windows stall commands, real local execution', () => {
  const agentId = `uob4-win-${process.pid}`;
  let root: string;
  let normalLog: string;
  let quotedLog: string;

  beforeAll(() => {
    backupAndResetRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uob4-'));
    const normalDir = path.join(root, 'normal');
    const quotedDir = path.join(root, "it's dir");
    fs.mkdirSync(normalDir, { recursive: true });
    fs.mkdirSync(quotedDir, { recursive: true });
    normalLog = path.join(normalDir, 'session.jsonl');
    quotedLog = path.join(quotedDir, 'session.jsonl');
    fs.writeFileSync(normalLog, FIXTURE);
    fs.writeFileSync(quotedLog, FIXTURE);
    addAgent(makeTestLocalAgent({ id: agentId, friendlyName: agentId, os: 'windows', workFolder: root, llmProvider: 'claude' }));
  });

  afterAll(() => {
    restoreRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['normal path', () => normalLog],
    ["path with a single quote and a space", () => quotedLog],
  ])('pollLogFile returns the last timestamp and pending tool timeout (%s)', async (_label, logPath) => {
    const result = await pollLogFile(agentId, logPath());
    expect(result.error).toBeUndefined();
    expect(result.lastTimestamp).toBe(LAST_TS);
    expect(result.pendingToolTimeoutMs).toBe(600000);
  }, 60_000);

  // The encoded run reports a missing file as wrapped CLIXML on stderr; it
  // must still classify as "not created yet", not as a read failure.
  it('pollLogFile treats a not-yet-created log (quoted path) as no activity, not an error', async () => {
    const result = await pollLogFile(agentId, path.join(path.dirname(quotedLog), 'missing.jsonl'));
    expect(result.error).toBeUndefined();
    expect(result.lastTimestamp).toBeNull();
  }, 60_000);

  it('readLogTail returns the last timestamp for a path with a single quote', async () => {
    const result = await readLogTail(agentId, quotedLog);
    expect(result.error).toBeUndefined();
    expect(result.lastTimestamp).toBe(LAST_TS);
  }, 60_000);
});
