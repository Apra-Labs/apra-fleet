// @ts-expect-error -- plain .mjs helper, no type declarations
import { dropBeadsWorkspaceEnv } from '../../scripts/test-sandbox.mjs';

/**
 * Child env for a test that spawns the real `bd` CLI into a scratch directory.
 * bd resolves BEADS_DIR / BEADS_DB / BD_DB before cwd, so they are dropped:
 * the child must reach the directory the test built, never a workspace the
 * host exports globally.
 */
export function bdChildEnv(): NodeJS.ProcessEnv {
  return dropBeadsWorkspaceEnv({ ...process.env });
}
