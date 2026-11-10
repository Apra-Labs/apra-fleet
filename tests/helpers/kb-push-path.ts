import fs from 'node:fs';
import path from 'node:path';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { QueryOptions } from '../../src/services/knowledge/types.js';
// @ts-expect-error plain .mjs (fleet-sprint engine)
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
// @ts-expect-error plain .mjs (fleet-sprint engine hints)
import { roleHints } from '../../packages/apra-fleet-se/fleet-sprint/kb-hints.mjs';

// The engine push path against a real SqliteProvider: the real fleet-sprint
// knowledgeFor (createKbWorkClient, kb.mjs) and roleHints (kb-hints.mjs),
// with memberCall answering kb_query from the provider using the same
// QueryOptions src/tools/kb-query.ts builds for a CONFIRMED-only read
// (limit, confidence, exclude_disputed, l1_only, files/symbols/error_text as
// anchors and error text, relevant_only) and related_claims from
// provider.relatedClaims on the top 5, as kb_query does. Used by the
// push-path relevance measurement (docs/kb-recall-measurements.md) and
// tests/knowledge/kb-push-relevance-cutoff.test.ts.

export const PUSH_EVAL_DIR = path.resolve(__dirname, '../fixtures/kb-push-eval');

export interface PushBead { id: string; title: string; description: string; acceptance_criteria: string }

/** The 24 pinned real beads of the push-path measurement set. */
export function loadPushBeads(): PushBead[] {
  return JSON.parse(fs.readFileSync(path.join(PUSH_EVAL_DIR, 'beads.json'), 'utf-8')).beads;
}

/** bead id -> the bible entry ids judged relevant to it. */
export function loadPushLabels(): Record<string, string[]> {
  return JSON.parse(fs.readFileSync(path.join(PUSH_EVAL_DIR, 'labels.json'), 'utf-8')).relevant;
}

export interface KbQueryArgs {
  query?: string; files?: string[]; symbols?: string[]; error_text?: string; limit?: number;
  expand_related?: boolean; confidence?: QueryOptions['confidence']; exclude_disputed?: boolean; relevant_only?: boolean;
}

/** The provider read kb_query makes for these arguments (the CONFIRMED-only branch). */
export function kbQueryOptions(args: KbQueryArgs): QueryOptions {
  const confidence = args.confidence?.length ? args.confidence : ['CONFIRMED' as const];
  return {
    query: args.query,
    limit: args.limit ?? 20,
    l1_only: true,
    include_stale: false,
    include_superseded: false,
    confidence,
    exclude_disputed: args.exclude_disputed ?? !args.confidence?.length,
    ...(args.files?.length ? { anchor_files: args.files } : {}),
    ...(args.symbols?.length ? { anchor_symbols: args.symbols } : {}),
    ...(args.error_text ? { error_text: args.error_text } : {}),
    ...(args.relevant_only === true ? { relevant_only: true } : {}),
  };
}

export interface PushPathOptions {
  /** Drop relevant_only from every kb_query: the push path as it was before the cutoff. */
  withoutCutoff?: boolean;
  /** Every kb_query is recorded here (the arguments as the engine sent them). */
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

/** A fleet-sprint memberCall answering kb_query / kb_session_prime from `provider`. */
export function providerMemberCall(provider: SqliteProvider, opts: PushPathOptions = {}) {
  return async (_member: unknown, name: string, args: KbQueryArgs & Record<string, unknown>) => {
    opts.calls?.push({ name, args: { ...args } });
    if (name === 'kb_query') {
      const sent = opts.withoutCutoff ? { ...args, relevant_only: undefined } : args;
      const qo = kbQueryOptions(sent);
      const l1 = (await provider.query(qo)).results;
      const related = sent.expand_related && l1.length > 0
        ? await provider.relatedClaims(l1.slice(0, 5).map(e => e.id), undefined, { confidence: qo.confidence, exclude_disputed: qo.exclude_disputed })
        : [];
      return { content: [{ type: 'text', text: JSON.stringify({ l1_results: l1, l2_expanded: [], ...(sent.expand_related ? { related_claims: related } : {}) }) }] };
    }
    if (name === 'kb_session_prime') {
      const r = await provider.prime({ hint_symbols: args.hint_symbols as string[] | undefined, hint_modules: args.hint_modules as string[] | undefined, confidence: ['CONFIRMED'], exclude_disputed: true });
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  };
}

/** The real engine knowledgeFor for one doer dispatch on `bead`, served by `provider`. */
export async function pushBlockFor(provider: SqliteProvider, bead: Pick<PushBead, 'title' | 'description' | 'acceptance_criteria'>, opts: PushPathOptions = {}): Promise<{ ids: string[]; source: string }> {
  const client = createKbWorkClient({ memberCall: providerMemberCall(provider, opts), log: () => {} });
  const hints = roleHints('doer', { beadTitles: [bead] });
  const { entries, source } = await client.knowledgeFor({ id: 'member-1', name: 'member-1', type: 'local' }, hints);
  return { ids: (entries as Array<{ id: string }>).map(e => e.id), source };
}

export interface PushMeasurement {
  blocks: number;
  rows: number;
  relevant: number;
  irrelevant: number;
  empty: number;
  /** relevant / rows (0 when no rows). */
  relevantShare: number;
  perBead: Array<{ id: string; ids: string[]; relevant: number; irrelevant: number }>;
}

/** Relevant vs irrelevant rows per pushed block over the labelled bead set. */
export async function measurePushBlocks(
  provider: SqliteProvider, beads: PushBead[], labels: Record<string, string[]>, opts: PushPathOptions = {},
): Promise<PushMeasurement> {
  const perBead: PushMeasurement['perBead'] = [];
  for (const b of beads) {
    const { ids } = await pushBlockFor(provider, b, opts);
    const lab = new Set(labels[b.id] ?? []);
    const relevant = ids.filter(id => lab.has(id)).length;
    perBead.push({ id: b.id, ids, relevant, irrelevant: ids.length - relevant });
  }
  const relevant = perBead.reduce((s, p) => s + p.relevant, 0);
  const irrelevant = perBead.reduce((s, p) => s + p.irrelevant, 0);
  const rows = relevant + irrelevant;
  return { blocks: beads.length, rows, relevant, irrelevant, empty: perBead.filter(p => p.ids.length === 0).length, relevantShare: rows ? relevant / rows : 0, perBead };
}

export function formatPushMeasurement(label: string, m: PushMeasurement): string {
  return `[kb-push-path] ${label}: blocks=${m.blocks} rows=${m.rows} relevant=${m.relevant} irrelevant=${m.irrelevant} `
    + `relevant/block=${(m.relevant / m.blocks).toFixed(2)} irrelevant/block=${(m.irrelevant / m.blocks).toFixed(2)} `
    + `relevant share=${m.relevantShare.toFixed(3)} empty blocks=${m.empty}`;
}

// -- Explicit kb_query callers are unchanged ---------------------------------
//
// The ids kb_query returns WITHOUT relevant_only, for every query of the
// recall eval real set, recorded from the code before the cutoff existed
// (tests/fixtures/kb-push-eval/explicit-kb-query-ids.json). Two argument
// shapes per query: the tool default (limit 20) and the engine's own shape
// (limit 8, CONFIRMED, exclude_disputed, expand_related) without the cutoff.

export const EXPLICIT_SNAPSHOT_PATH = path.join(PUSH_EVAL_DIR, 'explicit-kb-query-ids.json');

export type KbQueryCall = (args: Record<string, unknown>) => Promise<{ l1_results: Array<{ id: string }>; related_claims?: Array<{ id: string }> }>;

export interface ExplicitIds { default: string[]; engine: string[]; related: string[] }

/** kb_query ids for each query, in a fixed call order (use_count feeds the trust prior). */
export async function explicitQueryIds(
  queries: Array<{ id: string; query: string; error_text?: string }>, call: KbQueryCall,
): Promise<Record<string, ExplicitIds>> {
  const out: Record<string, ExplicitIds> = {};
  for (const q of queries) {
    const base = { query: q.query, ...(q.error_text ? { error_text: q.error_text } : {}) };
    const def = await call(base);
    const eng = await call({ ...base, limit: 8, confidence: ['CONFIRMED'], exclude_disputed: true, expand_related: true });
    out[q.id] = {
      default: def.l1_results.map(e => e.id),
      engine: eng.l1_results.map(e => e.id),
      related: (eng.related_claims ?? []).map(e => e.id),
    };
  }
  return out;
}
