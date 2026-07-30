#!/usr/bin/env node
// Stand-in for `bin/cli.mjs` in the apra-fleet-k7b.7 real-process integration
// test: a short-lived process that ignores its argv and exits nonzero almost
// immediately, so the test can assert the spawner's real Node 'exit' event
// (pid/exitCode/signal/time) flows all the way through onChildExit ->
// ledger.recordExit()/history.record(CHILD_EXITED) -> the watchdog's
// formatExitDetail()/classifySprint(), using a REAL OS child process rather
// than a fake child_process.spawn.
process.exitCode = 1;
