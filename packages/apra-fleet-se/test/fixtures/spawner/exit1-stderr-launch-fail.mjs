#!/usr/bin/env node
// apra-fleet-gey.3: stand-in for a sprint child (bin/cli.mjs) that fails
// immediately -- exactly the "five sprint incarnations died in 39ms-to-
// seconds before any dispatch" symptom apra-fleet-gey's own description
// describes (an Arg Contract violation, a missing member beads DB, etc.).
// Writes one recognizable diagnostic line to stderr, then exits 1, well
// under apra-fleet-gey.1's launch-failed window -- used to prove the
// watchdog's LAUNCH_FAILED classification carries a REAL stderr tail read
// back from the apra-fleet-ou7.1 per-sprint log file, not a fake/injected
// one.
process.stderr.write('gey3-fixture: fatal: missing member beads DB\n');
process.exitCode = 1;
