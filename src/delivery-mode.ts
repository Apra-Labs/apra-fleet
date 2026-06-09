import { isSea, isNpmGlobalInstall } from './cli/install.js';

export type DeliveryMode = 'sea' | 'npm' | 'dev';

/**
 * Returns the active delivery mode:
 *   'sea' -- running as a Node.js Single Executable Application
 *   'npm' -- installed globally via npm (node_modules-managed)
 *   'dev' -- running from a local dev build (node dist/index.js)
 */
export function getDeliveryMode(): DeliveryMode {
  if (isSea()) return 'sea';
  if (isNpmGlobalInstall()) return 'npm';
  return 'dev';
}

/**
 * Returns mode, binary/script path, and Node.js version for diagnostics.
 * binary: process.execPath for SEA (the compiled binary), process.argv[1] for
 *         npm and dev (the JS entry point run by node).
 */
export function getDeliveryInfo(): { mode: DeliveryMode; binary: string; nodeVersion: string } {
  const mode = getDeliveryMode();
  const binary = mode === 'sea' ? process.execPath : process.argv[1];
  const nodeVersion = process.version;
  return { mode, binary, nodeVersion };
}
