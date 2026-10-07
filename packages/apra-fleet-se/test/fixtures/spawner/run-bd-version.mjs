#!/usr/bin/env node
// Stand-in for `bin/cli.mjs` (apra-fleet-hap8.2): does what the real sprint child
// does first -- shells out to a bare `bd` through its OWN inherited PATH -- and
// reports the outcome on stdout (the per-sprint log the spawner tees), then exits.
import { execFileSync } from 'node:child_process';

try {
    const out = execFileSync('bd', ['--version'], { encoding: 'utf-8' });
    console.log('BD OK ' + out.trim());
} catch (err) {
    console.log('BD FAILED ' + (err && err.message ? err.message.split('\n')[0] : String(err)));
}
