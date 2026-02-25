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
    return `Agent "${id}" not found.`;
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

/**
 * Touch an agent's lastUsed timestamp and optionally update its sessionId.
 */
export function touchAgent(agentId: string, sessionId?: string): void {
  const updates: Record<string, unknown> = { lastUsed: new Date().toISOString() };
  if (sessionId !== undefined) {
    updates.sessionId = sessionId;
  }
  updateAgent(agentId, updates);
}
