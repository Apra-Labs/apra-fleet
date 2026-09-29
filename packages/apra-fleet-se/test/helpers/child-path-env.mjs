// Case-correct search-path manipulation for a SPAWNED CHILD's environment.
//
// apra-fleet-i9ag.19.32: this used to be the sole implementation, duplicated
// nowhere else. spawner.mjs's spawnSprint() now needs the same case-correct
// PATH-key logic in PRODUCTION code (to put the recorded node's directory on
// the sprint child's search path), and production code must never import
// from test/helpers -- so the implementation moved to
// src/supervisor/lib/child-path-env.mjs and this file re-exports it, keeping
// exactly one implementation for both test and production callers. See that
// module's doc comment for the full "why this exists" (the Windows
// `Path`-vs-`PATH` case trap) and the windows-latest regression it fixes.
//
// ASCII only.

export { pathEnvKey, prependToPathEnv } from '../../src/supervisor/lib/child-path-env.mjs';
