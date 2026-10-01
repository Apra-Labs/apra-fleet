// Per-session tool scope for the fleet MCP server.
//
// Every MCP session gets its own McpServer, and registerAllTools registers
// only the tools in that session's scope (deny by omission: an out-of-scope
// tool never appears in tools/list and calling it fails as an unknown tool).
//
//   FULL   -- no member identity (the local orchestrator/PM/tool session).
//             Every tool, unchanged.
//   MEMBER -- a session identified as a registered fleet member, by a valid
//             member JWT or by ?member=<uuid>. The base member allowlist
//             (src/services/member-tool-allowlist.ts), plus
//             MEMBER_CHANNEL_TOOLS when the client declared the claude/channel
//             capability at initialize (an interactive session that answers
//             execute_prompt via respond_to_message).
//
// The calling session's member id is also made available to tool handlers
// while they run (getSessionMemberId), so handlers do not have to guess it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { isMemberAllowedTool, MEMBER_CHANNEL_TOOLS } from './member-tool-allowlist.js';

export type ToolScope =
  | { kind: 'full' }
  | { kind: 'member'; memberId: string; channelCapable: boolean };

export const FULL_TOOL_SCOPE: ToolScope = Object.freeze({ kind: 'full' as const });

export function memberToolScope(memberId: string, channelCapable: boolean): ToolScope {
  return { kind: 'member', memberId, channelCapable };
}

/** True when `name` may be registered on a session with the given scope. */
export function isToolInScope(name: string, scope: ToolScope): boolean {
  if (scope.kind === 'full') return true;
  if (isMemberAllowedTool(name)) return true;
  return scope.channelCapable && MEMBER_CHANNEL_TOOLS.includes(name);
}

/** The member id of the session a scope belongs to (undefined for FULL). */
export function scopeMemberId(scope: ToolScope): string | undefined {
  return scope.kind === 'member' ? scope.memberId : undefined;
}

interface ToolCallContext {
  sessionMemberId: string | undefined;
}

const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

/** Run a tool handler with the calling session's member id in context. */
export function runWithSessionMember<T>(sessionMemberId: string | undefined, fn: () => T): T {
  return toolCallContext.run({ sessionMemberId }, fn);
}

/**
 * The member id of the MCP session whose tool call is currently executing,
 * or undefined for a FULL (non-member) session or outside any tool call.
 */
export function getSessionMemberId(): string | undefined {
  return toolCallContext.getStore()?.sessionMemberId;
}
