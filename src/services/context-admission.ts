import type { LlmProvider } from '../types.js';
import { loadUserConfig } from './user-config.js';

/**
 * Context-headroom admission control (apra-fleet-eft.81.1). A dispatch that
 * lands in a session with too little context headroom gets compacted
 * mid-task -- prior context (the very thing a resumed delta prompt depends
 * on) is summarized away, and quality collapses silently. This module lets
 * execute_prompt reject a dispatch BEFORE spawning the LLM when the caller's
 * declared demand would blow the session's remaining window, and attach a
 * non-fatal warning when the demand still fits but eats into the reserved
 * safety margin.
 *
 * Three-band decision (see checkContextAdmission):
 *   1. demand <= headroom (window - cumulative - margin)      -> ALLOW, no warning.
 *   2. headroom < demand <= (window - cumulative)              -> ALLOW, structured warning
 *      ("near-margin": still fits inside the raw window, but eats into or past
 *      the reserved safety margin, so a follow-up dispatch in this same
 *      session is at real risk of compaction).
 *   3. demand > (window - cumulative)                          -> REJECT
 *      (reason: 'insufficient_context_headroom') -- does not fit at all, no
 *      LLM call is made.
 */

export type ContextSizeBucket = 'S' | 'M' | 'L';

/** Fleet defaults for the S/M/L size-bucket shorthand (execute_prompt's
 *  `context_size` param) -- overridable via config.json's
 *  `contextAdmission.sizeBucketTokens`. */
export const DEFAULT_SIZE_BUCKET_TOKENS: Record<ContextSizeBucket, number> = {
  S: 4_000,
  M: 20_000,
  L: 60_000,
};

/** Tokens reserved as a buffer below the raw window before a dispatch is
 *  considered "comfortably" clear of compaction risk -- overridable via
 *  config.json's `contextAdmission.safetyMarginTokens`. */
export const DEFAULT_SAFETY_MARGIN_TOKENS = 20_000;

/**
 * Known context windows (tokens) per provider, sourced from
 * docs/provider-matrix.md's "Context window" row (2026-07 snapshot):
 * Claude 200K (Sonnet)/1M (Opus 4.7), Codex 192K, Copilot 64K, AGY 1M.
 * `opencode`/`none` have no published figure in that survey -- default to
 * Codex's documented 192K as a conservative (not optimistic) fallback
 * rather than inventing a number. Overridable via config.json's
 * `contextAdmission.contextWindows`. Partial (rather than an exhaustive
 * Record<LlmProvider, number>) so an unlisted provider falls through to the
 * codex-default lookup below instead of requiring every LlmProvider member
 * to carry an entry here.
 */
const DEFAULT_PROVIDER_WINDOW_TOKENS: Partial<Record<LlmProvider, number>> = {
  claude: 200_000,
  codex: 192_000,
  copilot: 64_000,
  agy: 1_000_000,
  opencode: 192_000,
  none: 0,
};

/** Claude model names whose context window is the larger Opus figure rather
 *  than the 200K Sonnet/Haiku default (docs/provider-matrix.md). Matched by
 *  substring so dated model ids (e.g. "claude-opus-4-7-20260615") still hit. */
const CLAUDE_OPUS_MODEL_RE = /opus/i;

function sizeBucketTokens(): Record<ContextSizeBucket, number> {
  const overrides = loadUserConfig().contextAdmission?.sizeBucketTokens;
  return { ...DEFAULT_SIZE_BUCKET_TOKENS, ...overrides };
}

function safetyMarginTokens(): number {
  return loadUserConfig().contextAdmission?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
}

/** 'enforce' (default): band 3 above rejects the dispatch outright.
 *  'warn': admission is never rejected -- band 3 downgrades to an ALLOW with
 *  the same structured warning band 2 uses, i.e. the whole mechanism becomes
 *  observational only. Set via config.json's `contextAdmission.mode`. */
export function admissionMode(): 'enforce' | 'warn' {
  return loadUserConfig().contextAdmission?.mode ?? 'enforce';
}

/** The context window (tokens) for a resolved model on a given provider. */
export function contextWindowTokens(provider: LlmProvider, resolvedModel: string): number {
  const overrides = loadUserConfig().contextAdmission?.contextWindows;
  if (overrides && overrides[provider] !== undefined) return overrides[provider]!;
  if (provider === 'claude' && CLAUDE_OPUS_MODEL_RE.test(resolvedModel)) return 1_000_000;
  return DEFAULT_PROVIDER_WINDOW_TOKENS[provider] ?? DEFAULT_PROVIDER_WINDOW_TOKENS.codex ?? 192_000;
}

/**
 * Resolves a dispatch's declared context demand: an explicit token count wins
 * over the S/M/L bucket shorthand when both are supplied. Returns undefined
 * when the caller declared neither -- callers must treat undefined as "no
 * admission check, back-compat unchanged" rather than defaulting to 0.
 */
export function resolveExpectedDemand(expectedContextTokens: number | undefined, contextSize: ContextSizeBucket | undefined): number | undefined {
  if (typeof expectedContextTokens === 'number') return expectedContextTokens;
  if (contextSize) return sizeBucketTokens()[contextSize];
  return undefined;
}

// Per-session (mintedId/resumed sessionId) cumulative input+output token
// tracking (apra-fleet-eft.81.1). Deliberately separate from Agent.tokenUsage
// (registry.ts), which is a per-MEMBER lifetime total, not per-session --
// headroom must be computed against what THIS session has actually consumed,
// not the member's all-time usage across many past/rotated sessions.
const sessionCumulativeTokens = new Map<string, { input: number; output: number }>();

/** Adds a dispatch's parsed usage to a session's running total. No-op when
 *  sessionId is undefined (e.g. a provider that never returns/accepts a
 *  session id). */
export function recordSessionUsage(sessionId: string | undefined, usage: { input_tokens: number; output_tokens: number }): void {
  if (!sessionId) return;
  const prev = sessionCumulativeTokens.get(sessionId) ?? { input: 0, output: 0 };
  sessionCumulativeTokens.set(sessionId, {
    input: prev.input + usage.input_tokens,
    output: prev.output + usage.output_tokens,
  });
}

/** A session's cumulative input+output tokens tracked so far; 0 for an
 *  untracked or fresh session id (including undefined). */
export function sessionCumulativeTotal(sessionId: string | undefined): number {
  if (!sessionId) return 0;
  const u = sessionCumulativeTokens.get(sessionId);
  return u ? u.input + u.output : 0;
}

/** Test-only: clear all tracked per-session cumulative usage. */
export function _resetSessionUsage(): void {
  sessionCumulativeTokens.clear();
}

export interface ContextAdmissionDetail {
  demand: number;
  headroom: number;
  window: number;
}

export interface ContextAdmissionResult {
  allowed: boolean;
  detail: ContextAdmissionDetail;
  /** Present when allowed=true but the dispatch lands inside the safety
   *  margin (band 2), or when mode='warn' downgraded what would otherwise
   *  have been a band-3 rejection. Absent when the dispatch comfortably
   *  fits (band 1). */
  warning?: string;
}

/**
 * The admission decision for a single dispatch. Callers should only invoke
 * this when resolveExpectedDemand() returned a defined demand -- an
 * undeclared demand means "no check" and must never reach this function.
 */
export function checkContextAdmission(opts: {
  provider: LlmProvider;
  resolvedModel: string;
  sessionId: string | undefined;
  demand: number;
}): ContextAdmissionResult {
  const window = contextWindowTokens(opts.provider, opts.resolvedModel);
  const cumulative = sessionCumulativeTotal(opts.sessionId);
  const margin = safetyMarginTokens();
  const rawRemaining = window - cumulative;
  const headroom = rawRemaining - margin;
  const detail: ContextAdmissionDetail = { demand: opts.demand, headroom, window };

  if (opts.demand > rawRemaining) {
    // Band 3: does not fit at all.
    if (admissionMode() === 'warn') {
      return {
        allowed: true,
        detail,
        warning: `demand (${opts.demand}) exceeds this session's remaining context window (window=${window}, cumulative=${cumulative}) -- admission is in warn-only mode so the dispatch proceeded anyway, but it is at high risk of mid-task compaction.`,
      };
    }
    return { allowed: false, detail };
  }

  if (opts.demand > headroom) {
    // Band 2: fits, but eats into the reserved safety margin.
    return {
      allowed: true,
      detail,
      warning: `demand (${opts.demand}) lands inside this session's ${margin}-token safety margin (window=${window}, cumulative=${cumulative}) -- consider a fresh session for the next dispatch to avoid mid-task compaction.`,
    };
  }

  // Band 1: comfortably fits.
  return { allowed: true, detail };
}
