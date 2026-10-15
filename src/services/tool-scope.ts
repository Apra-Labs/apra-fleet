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
//             execute_prompt via respond_to_message), plus
//             MEMBER_MAINTAINER_TOOLS (kb_promote, kb_resolve_contradiction,
//             kb_reconcile_prefilter) when the session carries the
//             kb_maintainer grant.
//
// The calling session's member id, and whether it carries the kb_maintainer
// grant, are also made available to tool handlers while they run
// (getSessionMemberId, getSessionKbMaintainer), so handlers do not have to
// guess them.

import { AsyncLocalStorage } from 'node:async_hooks';
import { isMemberAllowedTool, isMemberMaintainerTool, MEMBER_CHANNEL_TOOLS } from './member-tool-allowlist.js';

export type ToolScope =
  | { kind: 'full' }
  | { kind: 'member'; memberId: string; channelCapable: boolean; engineOrigin?: boolean; kbMaintainer?: boolean };

export const FULL_TOOL_SCOPE: ToolScope = Object.freeze({ kind: 'full' as const });

/**
 * `engineOrigin` marks a session the ENGINE opened as the member (origin=engine
 * on the MCP URL: the memberCall local adapter and the `apra-fleet call` verb).
 * Same tool surface; its kb_/code_ calls are excluded from the member's
 * session_stats counts (src/services/member-call-counts.ts).
 *
 * `kbMaintainer` is the engine's kb_maintainer grant (kb_maintainer=1 on an
 * origin=engine member URL): the engine opens it only for the member it chose
 * as a repository's kb_maintainer, to apply promotions there. It adds
 * MEMBER_MAINTAINER_TOOLS. It is honoured only together with engineOrigin --
 * the per-folder ?member= entry an agent session uses never carries it. Like
 * ?member= and origin=engine it is an unauthenticated loopback URL parameter:
 * a routing guard that keeps agent sessions off CONFIRMED-minting tools, not a
 * security boundary against a local process (which can open a FULL session).
 */
export function memberToolScope(
  memberId: string,
  channelCapable: boolean,
  engineOrigin = false,
  kbMaintainer = false,
): ToolScope {
  const scope: { kind: 'member'; memberId: string; channelCapable: boolean; engineOrigin?: boolean; kbMaintainer?: boolean } =
    { kind: 'member', memberId, channelCapable };
  if (engineOrigin) scope.engineOrigin = true;
  if (engineOrigin && kbMaintainer) scope.kbMaintainer = true;
  return scope;
}

/** True for a member scope whose session was opened with origin=engine. */
export function scopeIsEngineOrigin(scope: ToolScope): boolean {
  return scope.kind === 'member' && scope.engineOrigin === true;
}

/** True when `name` may be registered on a session with the given scope. */
export function isToolInScope(name: string, scope: ToolScope): boolean {
  if (scope.kind === 'full') return true;
  if (isMemberAllowedTool(name)) return true;
  if (scope.kbMaintainer === true && isMemberMaintainerTool(name)) return true;
  return scope.channelCapable && MEMBER_CHANNEL_TOOLS.includes(name);
}

/** The member id of the session a scope belongs to (undefined for FULL). */
export function scopeMemberId(scope: ToolScope): string | undefined {
  return scope.kind === 'member' ? scope.memberId : undefined;
}

/**
 * True for a member scope carrying the kb_maintainer grant (which
 * memberToolScope only sets together with engineOrigin). False for FULL: a
 * FULL session is not a member session and is not gated by the grant at all.
 */
export function scopeHasKbMaintainer(scope: ToolScope): boolean {
  return scope.kind === 'member' && scope.kbMaintainer === true;
}

interface ToolCallContext {
  sessionMemberId: string | undefined;
  kbMaintainer: boolean;
}

const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

/**
 * Run a tool handler with the calling session's member id (and whether that
 * member session carries the kb_maintainer grant) in context.
 */
export function runWithSessionMember<T>(
  sessionMemberId: string | undefined,
  fn: () => T,
  opts: { kbMaintainer?: boolean } = {},
): T {
  return toolCallContext.run({ sessionMemberId, kbMaintainer: opts.kbMaintainer === true }, fn);
}

/**
 * The member id of the MCP session whose tool call is currently executing,
 * or undefined for a FULL (non-member) session or outside any tool call.
 */
export function getSessionMemberId(): string | undefined {
  return toolCallContext.getStore()?.sessionMemberId;
}

/**
 * Whether the MEMBER session whose tool call is currently executing carries
 * the kb_maintainer grant. False for a member session without it, for a FULL
 * session (which the grant does not gate) and outside any tool call -- callers
 * gating a member-only path check getSessionMemberId() first.
 */
export function getSessionKbMaintainer(): boolean {
  return toolCallContext.getStore()?.kbMaintainer === true;
}
