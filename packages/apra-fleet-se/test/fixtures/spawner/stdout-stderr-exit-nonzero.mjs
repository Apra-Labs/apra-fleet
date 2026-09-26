#!/usr/bin/env node
// apra-fleet-ou7.3: stand-in for a real sprint child (bin/cli.mjs) that
// writes a marker line to BOTH stdout and stderr, then exits nonzero. Used
// to prove end-to-end that the spawner's single-fd tee (apra-fleet-ou7.1,
// stdio: ['ignore', fd, fd]) captures output from both streams into the
// SAME per-sprint raw log file, including the last thing a child wrote
// right before it exited/crashed.
process.stdout.write('SPRINT STDOUT LINE\n');
process.stderr.write('SPRINT STDERR LINE\n');
process.exitCode = 3;
