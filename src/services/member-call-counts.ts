// Per-member kb_* / code_* tool call counts (in memory, this server process).
//
// Every kb_* and code_* call made from a MEMBER session (a session identified
// as a registered member by a member JWT or ?member=<uuid>) is counted against
// that member's uuid, aggregated across all of the member's sessions on this
// server. Calls from an ENGINE-ORIGIN session (one opened with origin=engine on
// the MCP URL -- only the engine's memberCall local adapter and the
// `apra-fleet call` verb set it) are NOT counted: those are the engine's own
// reads (including the session_stats snapshots themselves), not the member's
// agent using the tools. FULL (non-member) sessions are never counted.
//
// The counts are cumulative since COUNTS_SINCE (process start, or the last
// test reset). A reader takes before/after snapshots and diffs them; a change
// in `since` between two snapshots means the server restarted and the delta
// is not meaningful.

/** Tool-name prefixes whose calls are counted. */
export const COUNTED_TOOL_PREFIXES: readonly string[] = Object.freeze(['kb_', 'code_']);

interface MemberCounts {
  kb: number;
  code: number;
  tools: Map<string, number>;
}

const counts = new Map<string, MemberCounts>();
let since = new Date().toISOString();

export interface MemberCallStats {
  member_id: string;
  /** ISO time the counters started (server process start or last reset). */
  since: string;
  kb: number;
  code: number;
  total: number;
  /** Per-tool counts (only tools called at least once). */
  tools: Record<string, number>;
}

/** True when a call to `toolName` is a counted kb_ / code_ call. */
export function isCountedTool(toolName: string): boolean {
  return COUNTED_TOOL_PREFIXES.some(p => toolName.startsWith(p));
}

/**
 * Record one tool call from a member session. A no-op for an uncounted tool,
 * a missing member id, or an engine-origin session.
 */
export function recordMemberToolCall(memberId: string | undefined, toolName: string, engineOrigin: boolean): void {
  if (!memberId || engineOrigin || !isCountedTool(toolName)) return;
  let c = counts.get(memberId);
  if (!c) {
    c = { kb: 0, code: 0, tools: new Map() };
    counts.set(memberId, c);
  }
  if (toolName.startsWith('kb_')) c.kb++;
  else c.code++;
  c.tools.set(toolName, (c.tools.get(toolName) ?? 0) + 1);
}

/** The aggregated counts for one member (zeros when it made no counted call). */
export function getMemberCallStats(memberId: string): MemberCallStats {
  const c = counts.get(memberId);
  const tools: Record<string, number> = {};
  if (c) for (const [k, v] of [...c.tools.entries()].sort(([a], [b]) => a.localeCompare(b))) tools[k] = v;
  const kb = c?.kb ?? 0;
  const code = c?.code ?? 0;
  return { member_id: memberId, since, kb, code, total: kb + code, tools };
}

/** Test-only: clear every counter and restart `since`. */
export function resetMemberCallCounts(): void {
  counts.clear();
  since = new Date().toISOString();
}
