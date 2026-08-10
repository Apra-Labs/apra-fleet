#!/usr/bin/env node
// Stand-in for `bin/cli.mjs` in real-process spawner tests (apra-fleet-eft.4.2):
// a long-lived process that ignores its argv and just stays alive until
// killed, so tests can assert real OS-level detached-orphan survival without
// needing a full fleet/beads/member setup.
//
// apra-fleet-ou7.1: this one line of stdout is what lets the real-process
// spawner tests assert the per-sprint log file actually has content -- it
// goes to the log fd createSpawner() gave this process's stdout/stderr, NOT
// to the harness's own stdout (the harness only pipes its OWN stdout, see
// harness.mjs's `stdio: ['ignore', 'pipe', 'ignore']` -- this child's fd 1/2
// are the log file, not inherited from the harness), so it never disturbs
// the harness's single-line JSON-results parsing.
console.log('SPRINT CHILD STARTED');
setInterval(() => {}, 1000 * 60 * 60);
