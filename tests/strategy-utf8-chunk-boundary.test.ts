import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';

// Proves apra-fleet-grq: LocalStrategy.execCommand's stdout handler decodes
// each Buffer chunk independently via `.toString()` (src/services/strategy.ts,
// child.stdout.on('data', ...)), with no carry-over state across chunks. If a
// multi-byte UTF-8 sequence is split across two separate 'data' events, each
// half is decoded on its own and Node substitutes U+FFFD on both sides --
// corrupting a character that was never actually malformed on the wire.
//
// This test forces exactly that split: a child process writes the first 3
// bytes of the 4-byte UTF-8 encoding of U+1F4CB (the emoji seen mangled in
// the apra-fleet-fih sprint log), waits past a tick, then writes the 4th
// byte plus trailing text. The delay reliably produces two separate
// stdout 'data' events on the parent side (verified empirically -- a single
// synchronous write does not split, but a `setTimeout` between writes does).
describe('LocalStrategy stdout UTF-8 chunk-boundary handling (apra-fleet-grq)', () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // U+1F4CB (clipboard emoji) UTF-8 bytes: F0 9F 93 8B.
    // Write bytes 0-2 immediately, then byte 3 + trailing ASCII after a delay
    // long enough to force a separate OS-level flush / 'data' event.
    scriptPath = path.join(tmpDir, 'split-emoji.mjs');
    fs.writeFileSync(
      scriptPath,
      [
        "process.stdout.write(Buffer.from([0xF0, 0x9F, 0x93]));",
        'setTimeout(() => {',
        "  process.stdout.write(Buffer.from([0x8B]));",
        "  process.stdout.write(' Response from fleet-reorg: done');",
        '}, 50);',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not corrupt a multi-byte UTF-8 character split across two stdout chunks', async () => {
    const member = makeTestLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    const result = await strategy.execCommand(`node "${scriptPath}"`);

    expect(result.code).toBe(0);
    // Fails today: the split write decodes to U+FFFD U+FFFD (or similar)
    // instead of the intended single U+1F4CB emoji, because each chunk is
    // decoded independently (see strategy.ts stdout 'data' handler).
    expect(result.stdout).not.toContain('�');
    expect(result.stdout).toContain('\u{1F4CB} Response from fleet-reorg: done');
  });
});
