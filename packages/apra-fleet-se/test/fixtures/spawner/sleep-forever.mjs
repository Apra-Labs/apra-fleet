#!/usr/bin/env node
// Stand-in for `bin/cli.mjs` in real-process spawner tests (apra-fleet-eft.4.2):
// a long-lived process that ignores its argv and just stays alive until
// killed, so tests can assert real OS-level detached-orphan survival without
// needing a full fleet/beads/member setup.
setInterval(() => {}, 1000 * 60 * 60);
