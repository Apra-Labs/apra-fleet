#!/usr/bin/env node
// Real-process harness for apra-fleet-eft.4.2's orphan-survival tests: plays
// the role of "the supervisor" in a separate OS process so a test can SIGKILL
// it and assert the sprint child it spawned (via the real createSpawner(),
// real detached spawn()) is still alive afterward -- a guarantee that cannot
// be proven with an in-process fake child_process.spawn.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpawner } from '../../../src/supervisor/spawner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleepForeverPath = path.join(__dirname, 'sleep-forever.mjs');

const basePort = Number(process.env.SPAWNER_TEST_BASE_PORT) || 18081;

const spawner = createSpawner({
    command: process.execPath,
    cliPath: sleepForeverPath,
    basePort,
});

const results = [];
const count = Number(process.env.SPAWNER_TEST_SPRINT_COUNT) || 1;
for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await spawner.spawnSprint({
        issue: `issue-${i}`,
        members: 'm1',
        branch: `branch-${i}`,
        base: 'main',
    });
    results.push(result);
}

// One line of JSON so the parent test can read pid/port for each launch.
process.stdout.write(`${JSON.stringify(results)}\n`);

// Keep this "supervisor" harness process alive until the test kills it, so
// the test can exercise SIGKILL-of-supervisor rather than a graceful exit.
setInterval(() => {}, 1000 * 60 * 60);
