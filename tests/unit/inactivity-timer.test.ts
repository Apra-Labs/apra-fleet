import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { getStrategy } from '../../src/services/strategy.js';
import { makeTestLocalAgent } from '../test-helpers.js';

// Use the system tmpdir as workFolder so we don't need per-test cleanup
const WORK_DIR = os.tmpdir();

describe('LocalStrategy inactivity timer', () => {
  it('command with regular output completes before inactivity timeout', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);

    // Prints 3 times every 100ms — inactivity gap is always <3000ms even with slow PS startup
    const cmd = process.platform === 'win32'
      ? 'for ($i=0; $i -lt 3; $i++) { Start-Sleep -Milliseconds 100; Write-Output "tick" }'
      : 'for i in 1 2 3; do sleep 0.1; echo tick; done';

    const result = await strategy.execCommand(cmd, 3000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tick');
  }, 15000);

  it('silent command is killed after inactivity timeout', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);

    const cmd = process.platform === 'win32'
      ? 'Start-Sleep -Seconds 10'
      : 'sleep 10';

    await expect(strategy.execCommand(cmd, 300)).rejects.toThrow(/inactivity/);
  }, 5000);

  it('max_total_ms kills command even when output is regular', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);

    // Prints every 50ms — would never hit the 5000ms inactivity timeout
    const cmd = process.platform === 'win32'
      ? 'while ($true) { Start-Sleep -Milliseconds 50; Write-Output "ping" }'
      : 'while true; do sleep 0.05; echo ping; done';

    await expect(strategy.execCommand(cmd, 5000, 400)).rejects.toThrow(/max total time/);
  }, 5000);
});
