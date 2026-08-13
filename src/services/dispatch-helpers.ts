import type { LogScope } from '../utils/log-helpers.js';

/**
 * Attach a log-only MCP disconnect handler to an abort signal.
 *
 * apra-fleet-d64.1: MCP transport drops must NOT kill the remote process.
 * The handler only logs the disconnection -- the remote session continues
 * working independently. Explicit kills go through stop_prompt; stall
 * kills go through the stall detector's onStall callback.
 *
 * Returns a cleanup function that removes the event listener. Call it in
 * a finally block to avoid leaking listeners on the signal.
 */
export function attachMcpDisconnectHandler(
  signal: AbortSignal | undefined,
  scope: LogScope,
): () => void {
  if (!signal) return () => {};
  const handler = () => {
    scope.abort('MCP client disconnected -- remote session continues');
  };
  signal.addEventListener('abort', handler);
  return () => signal.removeEventListener('abort', handler);
}
