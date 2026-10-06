import type { PermissionDenial, PermissionDenialItem } from './provider.js';

/**
 * Claude Code's headless result event reports every tool call it refused for
 * lack of a permission grant in `permission_denials`:
 *
 *   {"type":"result","subtype":"success","is_error":false,"result":"...",
 *    "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_...",
 *      "tool_input":{"command":"bd show x","description":"..."}}], ...}
 *
 * `is_error` stays false and the reply is otherwise complete (the refused
 * tool's output was "This command requires approval"), so without this the
 * refusal reached the caller as an ordinary answer -- e.g. a plan-reviewer
 * verdict whose notes were the refusal text.
 *
 * Decision (documented in docs/architecture.md, "Permission refusals during
 * a dispatch"): a NON-EMPTY permission_denials
 * is a permission failure for EVERY caller, whether or not the reply looks
 * complete. The reply was produced without the refused tool's real output,
 * so no role can trust it as its result; execute_prompt returns reason
 * 'permission_denied' (any partial reply kept in `response`) and the caller
 * heals via compose_permissions. This matches agy, whose headless denials are
 * failures regardless of the reply.
 */

const SHELL_CHAIN_RE = /[|;&`<>]|\$\(/;
const PLAIN_COMMAND_WORD_RE = /^[\w.+-]+$/;

/** Every result event's permission_denials entries found in a dispatch's stdout
 *  (single JSON object, JSON array of events, or JSONL), last result wins. */
function findDenialEntries(stdout: string): unknown[] | undefined {
  const raw = (stdout ?? '').trim();
  if (!raw) return undefined;
  const fromObj = (obj: any): unknown[] | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj.type !== undefined && obj.type !== 'result') return undefined;
    return Array.isArray(obj.permission_denials) ? obj.permission_denials : undefined;
  };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      let found: unknown[] | undefined;
      for (const obj of parsed) found = fromObj(obj) ?? found;
      return found;
    }
    return fromObj(parsed);
  } catch { /* JSONL below */ }
  let found: unknown[] | undefined;
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try { found = fromObj(JSON.parse(l)) ?? found; } catch { /* skip */ }
  }
  return found;
}

function targetOf(toolName: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command.trim() || undefined;
  for (const key of ['file_path', 'notebook_path', 'path', 'url', 'pattern']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
  }
  return undefined;
}

/** compose_permissions grants that allow one refused call, primary first. */
function suggestedGrantsFor(item: PermissionDenialItem): string[] {
  const t = item.target;
  if (item.action === 'Bash') {
    if (!t || SHELL_CHAIN_RE.test(t)) return [];
    const first = t.split(/\s+/)[0];
    const out: string[] = [];
    if (PLAIN_COMMAND_WORD_RE.test(first)) out.push(`Bash(${first}:*)`);
    if (t !== first) out.push(`Bash(${t})`);
    return out;
  }
  // Read/Write/Edit/MCP tools/WebFetch...: the tool name is a valid Claude
  // permission rule on its own and grants the tool as a whole.
  return /^[\w.-]+$/.test(item.action) ? [item.action] : [];
}

/**
 * The PermissionDenial for a Claude dispatch whose result event carries a
 * non-empty `permission_denials`, else undefined.
 */
export function detectClaudePermissionDenial(stdout: string): PermissionDenial | undefined {
  const entries = findDenialEntries(stdout);
  if (!entries || entries.length === 0) return undefined;
  const denials: PermissionDenialItem[] = [];
  const seen = new Set<string>();
  for (const e of entries as any[]) {
    const action = e && typeof e.tool_name === 'string' && e.tool_name.trim() ? e.tool_name.trim() : 'unknown';
    const target = targetOf(action, e?.tool_input);
    const key = `${action}\u0000${target ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    denials.push(target === undefined ? { action } : { action, target });
  }
  const actions = [...new Set(denials.map(d => d.action))];
  const perDenial = denials.map(d => suggestedGrantsFor(d));
  const primary = [...new Set(perDenial.map(g => g[0]).filter((g): g is string => !!g))];
  const narrow = [...new Set(perDenial.flatMap(g => g.slice(1)))].filter(g => !primary.includes(g));
  const suggestedGrants = [...primary, ...narrow];

  const what = denials.map(d => (d.target ? `${d.action} "${d.target}"` : d.action)).join(', ');
  let hint = `claude refused ${what} for lack of a permission grant (headless mode cannot prompt; the tool returned "requires approval").`;
  hint += suggestedGrants.length
    ? ` Re-compose the member with compose_permissions (its role restores a dropped config), or grant: ${JSON.stringify(primary)} and retry.`
    : ' Re-compose the member with compose_permissions; no grant maps to this call automatically, so grant it on the member by hand if the role needs it.';
  if (narrow.length) hint += ` Narrower alternative (this exact command line only): ${JSON.stringify(narrow)}.`;
  return { actions, denials, suggestedGrants, hint, signals: ['result_json'] };
}
