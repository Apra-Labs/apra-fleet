// Preloaded (NODE_OPTIONS=--import) into every node process started inside the
// test sandbox (scripts/test-sandbox.mjs): fail fast before any module can
// resolve a path in the real user profile.
import { assertNotRealProfile } from './test-sandbox.mjs';

assertNotRealProfile();
