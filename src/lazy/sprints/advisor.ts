/**
 * The design advisor: which sprint design fits an ask, and designs that
 * improve themselves as sprints finish.
 *
 * Everything here is explainable on purpose. A recommendation says why (the
 * kind and size of the ask, and how past sprints of that kind went), and an
 * "Auto" design lists the evidence behind every setting it changed. The rules
 * are simple heuristics, seeded from the design benchmarks in
 * docs/lazy-sprint-designs.md, and then corrected by your own history.
 */
import { buildBoard, findRun } from './board.js';
import { BUILT_IN_DESIGNS, getDesign, listDesigns, saveDesignRaw, type Design } from './designs.js';
import { loadRegistry, type SprintRecord } from './launcher.js';

export type AskKind = 'feature' | 'bugfix' | 'tests' | 'docs';
export type AskSize = 'small' | 'medium' | 'large';

export interface AskProfile {
  kind: AskKind;
  size: AskSize;
  /** How many separate pieces of work the ask names. */
  parts: number;
  words: number;
}

/** Read an ask the way a person skimming it would: what kind of work, and how much. */
export function profileAsk(ask: string): AskProfile {
  const t = String(ask || '');
  const lower = t.toLowerCase();
  const words = (t.match(/\S+/g) || []).length;
  const builds = /\b(build|add|implement|create|introduce|support|make)\b/.test(lower);
  let kind: AskKind = 'feature';
  if (/\b(end[- ]to[- ]end|e2e)\b/.test(lower) || (/\b(write|add|improve|increase)\b[^.]{0,30}\btests?\b/.test(lower) && !/\b(function|module|feature|endpoint|page|command)s?\b/.test(lower))) kind = 'tests';
  else if (/\b(fix|bug|broken|crash|crashes|regression|error|fails?|failing)\b/.test(lower) && !/\b(add|build|implement)\b[^.]{0,20}\b(feature|function|module)/.test(lower)) kind = 'bugfix';
  else if (/\b(readme|docs?|documentation|typo|changelog)\b/.test(lower) && !builds) kind = 'docs';
  // Pieces of work: function-like names, list items, and "X, Y and Z" runs of nouns.
  const calls = new Set((t.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || []).map(s => s.replace(/\s*\($/, '')));
  const bullets = (t.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  const sentences = (t.match(/[.!?](\s|$)/g) || []).length;
  const parts = Math.max(1, calls.size, bullets, Math.min(sentences, 6) > 3 ? Math.ceil(sentences / 2) : 1);
  const size: AskSize = parts <= 2 && words < 80 ? 'small' : parts >= 6 || words > 180 ? 'large' : 'medium';
  return { kind, size, parts, words };
}

// ---------------------------------------------------------------------------
// History: how finished sprints went
// ---------------------------------------------------------------------------

export interface Outcome {
  runId: string;
  designId: string;
  kind: AskKind;
  size: AskSize;
  passed: boolean;
  minutes: number;
  cost: number;
  cycles: number;
  tasks: number;
  endedAt: string;
}

/** Every finished sprint that followed a design, newest first. */
export function outcomes(records: SprintRecord[] = loadRegistry()): Outcome[] {
  const out: Outcome[] = [];
  for (const rec of records) {
    if (!rec.designId) continue;
    const run = findRun(rec.runId);
    if (!run || run.live) continue;
    const b = buildBoard(run);
    if (!b.startedAt || !b.endedAt) continue;
    const verdict = b.result && typeof b.result === 'object' ? (b.result as { verdict?: string }).verdict : undefined;
    const p = profileAsk(rec.ask);
    out.push({
      runId: rec.runId,
      designId: rec.designId,
      kind: p.kind,
      size: p.size,
      passed: verdict === 'PASS',
      minutes: (Date.parse(b.endedAt) - Date.parse(b.startedAt)) / 60000,
      cost: b.cost,
      cycles: Math.max(1, b.cycle || 1),
      tasks: b.progress.total,
      endedAt: b.endedAt,
    });
  }
  return out.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

export interface DesignStats {
  designId: string;
  runs: number;
  passRate: number;
  minutes: number;
  cost: number;
  cycles: number;
}

export function statsFor(list: Outcome[]): DesignStats[] {
  const by = new Map<string, Outcome[]>();
  for (const o of list) by.set(o.designId, [...(by.get(o.designId) ?? []), o]);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return [...by.entries()].map(([designId, os]) => ({
    designId,
    runs: os.length,
    passRate: os.filter(o => o.passed).length / os.length,
    minutes: avg(os.map(o => o.minutes)),
    cost: avg(os.map(o => o.cost)),
    cycles: avg(os.map(o => o.cycles)),
  }));
}

/** Higher is better: passing matters most, then time, then usage. */
export function score(s: DesignStats): number {
  return s.passRate * 100 - s.minutes * 1.5 - s.cost * 4 - (s.cycles - 1) * 10;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/** Starting points from the design benchmarks, before you have history of your own. */
function seed(p: AskProfile): { id: string; why: string } {
  if (p.kind === 'tests') return { id: 'e2e-only', why: 'it asks for tests, and this design writes and runs them without changing product code' };
  if (p.kind === 'docs') return { id: 'solo', why: 'documentation work is one focused change, which one helper does fastest' };
  if (p.kind === 'bugfix') return p.size === 'large'
    ? { id: 'classic', why: 'a broad fix benefits from a review after every round' }
    : { id: 'solo', why: 'a focused fix is fastest with one helper, and a final review still checks it' };
  if (p.size === 'small') return { id: 'classic', why: 'on small features Classic finished fast with the strongest tests in the benchmarks' };
  return { id: 'fast-pipeline', why: `with ${p.parts} parts, building them at once paid off: about twice as fast as Classic on the larger benchmark task` };
}

export interface Recommendation {
  designId: string;
  designName: string;
  profile: AskProfile;
  reasons: string[];
  /** Other designs you have history for on this kind of work. */
  alternatives: Array<{ designId: string; designName: string; summary: string }>;
}

const MIN_HISTORY = 2;

function describe(s: DesignStats): string {
  return `${s.runs} sprint${s.runs === 1 ? '' : 's'}, ${Math.round(s.passRate * 100)}% passed, about ${Math.round(s.minutes)} min and $${s.cost.toFixed(2)} each`;
}

export function recommend(ask: string, repo?: string, history: Outcome[] = outcomes()): Recommendation {
  const profile = profileAsk(ask);
  const designs = listDesigns(repo);
  const name = (id: string) => designs.find(d => d.id === id)?.name ?? id;
  const exists = (id: string) => designs.some(d => d.id === id);
  const reasons = [`Reads as ${profile.size === 'small' ? 'a small' : profile.size === 'large' ? 'a large' : 'a medium'} ${profile.kind === 'bugfix' ? 'bug fix' : profile.kind === 'tests' ? 'testing job' : profile.kind === 'docs' ? 'docs change' : 'feature'}${profile.parts > 1 ? ` with about ${profile.parts} parts` : ''}.`];
  const similar = history.filter(o => o.kind === profile.kind && o.size === profile.size && exists(o.designId));
  const stats = statsFor(similar).sort((a, b) => score(b) - score(a));
  const auto = autoDesignId(profile.kind, profile.size);
  let chosen: string;
  const proven = stats.filter(s => s.runs >= MIN_HISTORY);
  if (proven.length) {
    chosen = proven[0].designId;
    reasons.push(`Your history: ${name(chosen)} did best on this kind of work (${describe(proven[0])}).`);
  } else if (exists(auto)) {
    chosen = auto;
    reasons.push(`${name(auto)} was tuned from your earlier sprints of this kind.`);
  } else {
    const s = seed(profile);
    chosen = exists(s.id) ? s.id : 'fast-pipeline';
    reasons.push(`Suggested because ${s.why}.`);
    if (!similar.length) reasons.push('No sprints of this kind yet; this gets sharper as you run more.');
  }
  return {
    designId: chosen,
    designName: name(chosen),
    profile,
    reasons,
    alternatives: stats.filter(s => s.designId !== chosen).slice(0, 3).map(s => ({ designId: s.designId, designName: name(s.designId), summary: describe(s) })),
  };
}

// ---------------------------------------------------------------------------
// Evolution: designs that learn from your sprints
// ---------------------------------------------------------------------------

export const EVOLVE_MIN_RUNS = 3;

export function autoDesignId(kind: AskKind, size: AskSize): string {
  return `auto-${kind}-${size}`;
}

const TIERS = ['cheap', 'standard', 'premium'] as const;

export interface EvolveResult {
  created: Design[];
  updated: Design[];
  skipped: Array<{ bucket: string; reason: string }>;
}

/**
 * For every kind and size of work with enough finished sprints, write (or
 * refresh) an "Auto" design: the best design so far, adjusted for what went
 * wrong in those sprints. Each adjustment is recorded with its evidence.
 */
export function evolveDesigns(history: Outcome[] = outcomes(), now = new Date()): EvolveResult {
  const result: EvolveResult = { created: [], updated: [], skipped: [] };
  const designs = listDesigns();
  const buckets = new Map<string, Outcome[]>();
  for (const o of history) {
    const k = `${o.kind}/${o.size}`;
    buckets.set(k, [...(buckets.get(k) ?? []), o]);
  }
  for (const [bucket, runs] of buckets) {
    const [kind, size] = bucket.split('/') as [AskKind, AskSize];
    const id = autoDesignId(kind, size);
    // Learn from sprints of other designs; the Auto design's own runs count once it has them.
    if (runs.length < EVOLVE_MIN_RUNS) {
      result.skipped.push({ bucket, reason: `${runs.length} of ${EVOLVE_MIN_RUNS} finished sprints needed` });
      continue;
    }
    const ranked = statsFor(runs).sort((a, b) => score(b) - score(a));
    const best = ranked[0];
    const base = designs.find(d => d.id === best.designId) ?? BUILT_IN_DESIGNS.find(d => d.id === 'fast-pipeline')!;
    const d: Design = JSON.parse(JSON.stringify({ ...base, source: undefined }));
    const evidence: string[] = [`Started from ${base.name}: best of ${ranked.length} design${ranked.length === 1 ? '' : 's'} on ${runs.length} ${kind} sprints (${describe(best)}).`];
    const bestRuns = runs.filter(o => o.designId === best.designId);
    const secondCycle = bestRuns.filter(o => o.cycles > 1).length;
    const failed = bestRuns.filter(o => !o.passed).length;
    if (secondCycle / bestRuns.length >= 0.34 && (d.build?.mode ?? 'pipeline') !== 'off') {
      const cur = d.build?.minModel ?? 'cheap';
      const next = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(cur) + 1)];
      if (next !== cur) {
        d.build = { ...(d.build ?? {}), minModel: next };
        evidence.push(`Builders at least ${next}: ${secondCycle} of ${bestRuns.length} sprints needed a second cycle to fix what review found.`);
      }
    }
    if (failed / bestRuns.length >= 0.34) {
      if (d.finish?.finalReview === false) { d.finish = { ...(d.finish ?? {}), finalReview: true }; evidence.push(`Final review on: ${failed} of ${bestRuns.length} sprints did not pass.`); }
      if (d.review?.run === 'off') { d.review = { ...(d.review ?? {}), run: 'on' }; evidence.push(`Review on: ${failed} of ${bestRuns.length} sprints did not pass without it.`); }
      if (d.plan?.review === false) { d.plan = { ...(d.plan ?? {}), review: true }; evidence.push('Plan review on, for the same reason.'); }
    }
    if (failed === 0 && secondCycle === 0 && (d.build?.mode ?? 'pipeline') === 'pipeline' && (d.review?.split ?? 'always') === 'always') {
      d.review = { ...(d.review ?? {}), split: 'auto', splitMinFiles: d.review?.splitMinFiles ?? 20 };
      evidence.push('One reviewer unless the change is big: every sprint passed in one cycle, so the split review was not earning its cost.');
    }
    if (failed === 0 && best.minutes > 0 && d.finish?.harvest !== false && best.cost > 1) {
      d.finish = { ...(d.finish ?? {}), harvest: false };
      evidence.push('No docs pass: it adds about two minutes per sprint and these sprints passed without it.');
    }
    d.id = id;
    d.name = `Auto: ${kind === 'bugfix' ? 'bug fixes' : kind === 'tests' ? 'testing' : kind === 'docs' ? 'docs' : 'features'} (${size})`;
    d.description = `Learned from your ${runs.length} finished ${kind === 'bugfix' ? 'bug-fix' : kind} sprints of this size. ${evidence.slice(1).length ? `${evidence.length - 1} change${evidence.length - 1 === 1 ? '' : 's'} from ${base.name}.` : `Same settings as ${base.name}, which did best.`}`;
    d.auto = { basedOn: base.id, evidence, runs: runs.length, updatedAt: now.toISOString() };
    const had = designs.find(x => x.id === id);
    const same = had && JSON.stringify({ ...had, auto: undefined, source: undefined, steps: undefined }) === JSON.stringify({ ...d, auto: undefined });
    if (had?.auto?.locked) { result.skipped.push({ bucket, reason: 'you locked this design' }); continue; }
    if (same && had?.auto?.runs === runs.length) { result.skipped.push({ bucket, reason: 'nothing new to learn' }); continue; }
    saveDesignRaw(d);
    (had ? result.updated : result.created).push(d);
  }
  return result;
}

export { getDesign };
