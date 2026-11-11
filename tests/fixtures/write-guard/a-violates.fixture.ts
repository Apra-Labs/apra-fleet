import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.env.WRITE_GUARD_FIXTURE_DIR as string;
const signal = process.env.WRITE_GUARD_FIXTURE_SIGNAL as string;

it('swallows its own refused write', async () => {
  // Waits for the other worker to be running, so it sees whatever leaks.
  for (let i = 0; i < 300 && !fs.existsSync(`${signal}.started`); i++) await new Promise((r) => setTimeout(r, 100));
  try { fs.writeFileSync(path.join(dir, 'a'), 'x'); } catch { /* swallowed, as a best-effort hook install would */ }
}, 60_000);

it('runs a child whose write is refused', () => {
  spawnSync(process.execPath, ['-e', `try { require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'b'))}, 'x') } catch {}`]);
});

it('writes nothing outside, after the others', () => {
  fs.writeFileSync(signal, 'done');
});
