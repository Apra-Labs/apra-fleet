// Short-lived fleet connections must end with transport.close(): stop() only
// aborts the local streams and leaves the server session and its McpServer
// open. The supervisor's sweeps open one connection per member per pass, so a
// single stop() here leaked thousands of sessions a day and the fleet server
// died of heap OOM.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHORT_LIVED_CALLERS = [
    'src/supervisor/fleet-members.mjs',
    'bin/cli.mjs',
    'scripts/dolt-settle-integration.mjs',
];

for (const rel of SHORT_LIVED_CALLERS) {
    test(`${rel} ends its fleet transport with close(), never stop()`, () => {
        const src = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        assert.doesNotMatch(code, /\btransport\.stop\(\)/, `${rel} calls transport.stop(); use await transport.close()`);
        assert.match(code, /transport\.close\(\)/, `${rel} no longer closes its transport`);
    });
}
