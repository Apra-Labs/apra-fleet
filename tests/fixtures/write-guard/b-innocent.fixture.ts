import { it } from 'vitest';
import fs from 'node:fs';

const signal = process.env.WRITE_GUARD_FIXTURE_SIGNAL as string;

it('writes nothing outside, in another worker, while the other file violates', async () => {
  // Starts before the other worker's violations and ends after them, so a
  // report leaking across workers would land here.
  fs.writeFileSync(`${signal}.started`, 'b');
  for (let i = 0; i < 300 && !fs.existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
}, 60_000);
