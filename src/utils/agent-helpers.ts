/**
 * DRY helpers for common agent operations used across tool files.
 */
import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import { getAgent, findAgentByName, updateAgent } from '../services/registry.js';

/**
 * Look up an agent by ID or return a formatted error string.
 * Eliminates the repeated pattern of getAgent() + "not found" check in every tool.
 */
export function getAgentOrFail(id: string): Agent | string {
  const agent = getAgent(id) ?? findAgentByName(id);
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

const EXPIRY_WARNING_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Check if an agent's VCS token is expired or expiring soon.
 * Returns a warning string if action is needed, or null if OK / no expiry tracked.
 */
export function checkVcsTokenExpiry(agent: Agent, now: Date = new Date()): string | null {
  if (!agent.vcsTokenExpiresAt) return null;
  const expiresAt = new Date(agent.vcsTokenExpiresAt);
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) {
    return `⚠️ VCS token expired at ${agent.vcsTokenExpiresAt} — re-run provision_vcs_auth to refresh.`;
  }
  if (remaining <= EXPIRY_WARNING_MS) {
    const mins = Math.ceil(remaining / 60000);
    return `⚠️ VCS token expires in ${mins} minute${mins === 1 ? '' : 's'} (${agent.vcsTokenExpiresAt}) — consider refreshing.`;
  }
  return null;
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
