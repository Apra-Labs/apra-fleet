// Preloaded (NODE_OPTIONS=--import) into every node process started inside the
// test sandbox (scripts/test-sandbox.mjs): fail fast before any module can
// resolve a path in the real user profile, and refuse node:fs writes into a
// protected dir (scripts/test-sandbox-write-guard.mjs).
import { assertNotRealProfile } from './test-sandbox.mjs';
import { installWriteGuard } from './test-sandbox-write-guard.mjs';

assertNotRealProfile();
installWriteGuard();
