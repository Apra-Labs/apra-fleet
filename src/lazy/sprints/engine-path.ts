/** Where the sprint engine lives, for the launcher and the design checker. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/apra-fleet-se/bin/cli.mjs, found from this file's location. */
export function engineCli(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'packages', 'apra-fleet-se', 'bin', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('sprint engine not found (packages/apra-fleet-se/bin/cli.mjs)');
}
