/**
 * Process-wide relay connection context (apra-fleet-jfn). RelayStrategy
 * (relay-strategy.ts) needs access to THIS machine's own outbound hub
 * connection (workspace/machine identity, a way to submit an envelope, and
 * the PendingRelayRequests registry tracking in-flight requests) to
 * originate a relayed execute_command -- but getStrategy(agent) is a
 * synchronous, per-call factory with no dependency-injection point of its
 * own. Rather than thread hub connection details through every AgentStrategy
 * call site, the spoke-mode entrypoint (src/cli/spoke.ts) registers this
 * context once at startup; RelayStrategy reads it lazily per call.
 *
 * Not set (null) on a machine that isn't running in spoke mode -- calling
 * a RelayStrategy method then fails loudly (no relay connection configured)
 * rather than silently no-opping.
 */
import type { PendingRelayRequests, RelayRequestDeps } from './relay-request.js';

export interface RelayContext {
  deps: RelayRequestDeps;
  registry: PendingRelayRequests;
}

let current: RelayContext | null = null;

export function setRelayContext(ctx: RelayContext | null): void {
  current = ctx;
}

export function getRelayContext(): RelayContext | null {
  return current;
}
