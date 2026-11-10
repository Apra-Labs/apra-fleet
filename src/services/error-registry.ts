// The error registry: one bounded, in-memory record of tool-call failures per
// fleet server, so a caller can learn which fleet tools failed inside an LLM
// conversation it dispatched (only the LLM CLI sees those results).
//
// Every tool call goes through wrapTool (src/services/tool-registry.ts), which
// records each thrown error here and rethrows it unchanged. An entry carries
// only {at, member, source, tool, code, reason}: never the call's arguments
// and never the error's message text, which can quote either.
//
// Bounds: at most MAX_ERROR_ENTRIES entries, none older than MAX_ERROR_AGE_MS;
// both are applied on every insert and read. Reads never remove an entry.

/** Where an entry came from. Only tool calls today. */
export type ErrorSource = 'tool-call';

export interface ErrorEntry {
  /** ISO 8601 time the error was recorded (this server's clock). */
  at: string;
  /** Member uuid of the calling session; null for a non-member session. */
  member: string | null;
  source: ErrorSource;
  tool: string;
  /** The error's typed E-* code, or E-UNTYPED for anything else thrown. */
  code: string;
  /** The typed error's short reason token (e.g. E-KB-HTTP-AUTH's "expired"), else null. */
  reason: string | null;
}

export const MAX_ERROR_ENTRIES = 1000;
export const MAX_ERROR_AGE_MS = 24 * 60 * 60 * 1000;
export const UNTYPED_ERROR_CODE = 'E-UNTYPED';

const TYPED_CODE_RE = /^E-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
// A reason is kept only when it is a short token, so no free text rides in.
const REASON_TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

interface StoredEntry extends Omit<ErrorEntry, 'at'> { atMs: number }

let entries: StoredEntry[] = [];
let clock: () => number = () => Date.now();
// Errors already recorded, so one error seen at two catch sites counts once.
let recorded = new WeakSet<object>();

/** The code and reason recorded for a thrown value. Never reads the message. */
export function classifyError(err: unknown): { code: string; reason: string | null } {
  const e = (err !== null && typeof err === 'object') ? err as { code?: unknown; reason?: unknown } : undefined;
  if (e && typeof e.code === 'string' && TYPED_CODE_RE.test(e.code)) {
    const reason = typeof e.reason === 'string' && REASON_TOKEN_RE.test(e.reason) ? e.reason : null;
    return { code: e.code, reason };
  }
  return { code: UNTYPED_ERROR_CODE, reason: null };
}

function prune(now: number): void {
  const oldest = now - MAX_ERROR_AGE_MS;
  let drop = 0;
  while (drop < entries.length && entries[drop].atMs < oldest) drop++;
  const over = entries.length - drop - MAX_ERROR_ENTRIES;
  if (over > 0) drop += over;
  if (drop > 0) entries = entries.slice(drop);
}

/** Record one failed tool call. Never throws. */
export function recordToolError(member: string | undefined | null, tool: string, err: unknown): void {
  try {
    if (err !== null && typeof err === 'object') {
      if (recorded.has(err)) return;
      recorded.add(err);
    }
    const now = clock();
    const { code, reason } = classifyError(err);
    entries.push({ atMs: now, member: member ?? null, source: 'tool-call', tool, code, reason });
    prune(now);
  } catch {
    // The registry must never change what the tool call returns or throws.
  }
}

export interface ErrorQuery {
  member: string;
  sinceSeconds: number;
  code?: string;
  tool?: string;
  limit?: number;
}

export interface ErrorQueryResult {
  /** Matching entries within the window, oldest first; the most recent `limit` when more matched. */
  entries: ErrorEntry[];
  /** How many entries matched before `limit` was applied. */
  total: number;
}

export const DEFAULT_ERROR_QUERY_LIMIT = 100;

/** Entries for `member` recorded in the last `sinceSeconds` seconds. Removes nothing. */
export function queryErrorEntries(q: ErrorQuery): ErrorQueryResult {
  const now = clock();
  prune(now);
  const from = now - q.sinceSeconds * 1000;
  const matched = entries.filter(e =>
    e.member === q.member && e.atMs >= from
    && (q.code === undefined || e.code === q.code)
    && (q.tool === undefined || e.tool === q.tool));
  const limit = q.limit ?? DEFAULT_ERROR_QUERY_LIMIT;
  const kept = matched.length > limit ? matched.slice(matched.length - limit) : matched;
  return {
    total: matched.length,
    entries: kept.map(({ atMs, ...rest }) => ({ at: new Date(atMs).toISOString(), ...rest })),
  };
}

/** Test-only: empty the registry and optionally replace its clock. */
export function __resetErrorRegistry(now?: () => number): void {
  entries = [];
  recorded = new WeakSet<object>();
  clock = now ?? (() => Date.now());
}
