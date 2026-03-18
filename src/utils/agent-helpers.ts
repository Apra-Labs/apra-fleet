/**
 * DRY helpers for common agent operations used across tool files.
 */
import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import { getAgent, updateAgent } from '../services/registry.js';

/**
 * Look up an agent by ID or return a formatted error string.
 * Eliminates the repeated pattern of getAgent() + "not found" check in every tool.
 */
export function getAgentOrFail(id: string): Agent | string {
  const agent = getAgent(id);
  if (!agent) {
    return `Member "${id}" not found.`;
  }
  return agent;
}

/**
 * Get the OS for an agent, defaulting to 'linux'.
 * Eliminates repeated `agent.os ?? 'linux'` casts.
 */
export function getAgentOS(agent: Agent): RemoteOS {
  return (agent.os ?? 'linux') as RemoteOS;
}

/**
 * Format a host label for display.
 * Local agents show "(local)", remote agents show "host:port".
 */
export function formatAgentHost(agent: Agent): string {
  return agent.agentType === 'local' ? '(local)' : `${agent.host}:${agent.port}`;
}

// T7: idle manager hook — registered by IdleManager.start() via setIdleTouchHook().
// Kept as a callback to avoid circular import:
//   idle-manager → activity → strategy → agent-helpers
let idleTouchHook: ((agentId: string) => void) | undefined;

/**
 * Register a callback invoked on every touchAgent call.
 * Called by IdleManager.start() to wire timer resets into tool calls.
 */
export function setIdleTouchHook(fn: (agentId: string) => void): void {
  idleTouchHook = fn;
}

/**
 * Touch an agent's lastUsed timestamp and optionally update its sessionId.
 */
export function touchAgent(agentId: string, sessionId?: string): void {
  const updates: Record<string, unknown> = { lastUsed: new Date().toISOString() };
  if (sessionId !== undefined) {
    updates.sessionId = sessionId;
  }
  updateAgent(agentId, updates);
  idleTouchHook?.(agentId); // T7: notify idle manager to reset idle timer
}
