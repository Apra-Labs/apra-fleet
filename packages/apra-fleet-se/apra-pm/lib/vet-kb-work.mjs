// Validates the KB work a role returned in its structured output, before any KB
// tool call is attempted. Kept in a separate module so it can be unit-tested
// without the workflow runtime.
//
// NOTE: this is intentionally duplicated from the vetKbWork block in
// .claude/workflows/auto-sprint.js (workflow scripts cannot import arbitrary
// files -- the Workflow tool runs them with no filesystem access). Keep both in
// sync when modifying this logic, exactly as lib/parse-sprint-args.mjs does.
//
// Judgment stays with the role agent; EXECUTION belongs to the engine. Anything
// that would be refused downstream is dropped HERE with a reason, so a bad
// payload never becomes a tool call.

// Promotion is the only path that mints CONFIRMED. Widening capture to four
// roles deliberately does NOT widen promotion.
export const KB_PROMOTER_ROLES = new Set(['reviewer']);

// Mirrors MIN_PROMOTE_REASON_LENGTH in SqliteProvider.promote().
export const KB_MIN_PROMOTE_REASON = 20;

export const KB_CAPTURE_TYPES = ['knowledge', 'learning', 'runbook'];

// What kind of event produced a captured lesson. Mirrors CAPTURE_TRIGGERS in
// the server's knowledge types: the server accepts a trigger-less capture for
// backward compatibility, so refusing one is the engine's job.
export const KB_CAPTURE_TRIGGERS = ['failed-attempt', 'review-finding', 'test-failure', 'env-quirk', 'hidden-invariant', 'design-rationale'];

// Capture lint length bounds (characters): title 8-160, summary 20-500, content
// 40-2000. Measured on real entries: at these caps 2 of 609 titles and 1 of 609
// summaries are over. The role schemas state the same numbers in description text.
export const KB_MIN_CAPTURE_TITLE = 8;
export const KB_MAX_CAPTURE_TITLE = 160;
export const KB_MIN_CAPTURE_SUMMARY = 20;
export const KB_MAX_CAPTURE_SUMMARY = 500;
export const KB_MIN_CAPTURE_CONTENT = 40;
export const KB_MAX_CAPTURE_CONTENT = 2000;
// Content must add at least this many normalised characters beyond the
// summary, or it only repeats the summary.
export const KB_MIN_CONTENT_EXTRA = 40;
// Near-duplicate content: at least this share of its distinct words is in the
// summary AND it brings fewer than this many new words. Real entries with added
// content stay under 0.4 overlap, so the gap is wide.
export const KB_REPEAT_MIN_OVERLAP = 0.7;
export const KB_REPEAT_MAX_NEW_WORDS = 12;

// A double-brace placeholder token ({{<word>.<KEY>}}), built generically so no
// particular placeholder prefix is spelled out here.
const KB_PLACEHOLDER_RE = new RegExp('(?<!\\$)\\{\\{\\s*[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z0-9_]+\\s*\\}\\}');
// A raw credential: a provider token shape, a JWT, a PEM private-key header, or a
// random-looking (digit or mixed case) Bearer/Basic value. Mirrors
// BIBLE_SECRET_SHAPES in the server's bible export.
const KB_SECRET_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})|\b[Bb]earer\s+(?=[A-Za-z0-9._~+\/=-]*(?:[0-9]|[A-Z][A-Za-z0-9._~+\/=-]*[a-z]|[a-z][A-Za-z0-9._~+\/=-]*[A-Z]))[A-Za-z0-9._~+\/=-]{20,}|\bBasic\s+(?=[A-Za-z0-9+\/]*(?:[0-9]|[A-Z][A-Za-z0-9+\/]*[a-z]|[a-z][A-Za-z0-9+\/]*[A-Z]))[A-Za-z0-9+\/]{20,}={0,2}(?![A-Za-z0-9._~+\/=-])|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
// First-person narrative words as whole words, lowercase or Title case only: an
// all-caps US, ME or WE is a name. A path, flag or dotted name (us-east-1, my.cnf,
// C:\Users\me) is not a word here, and neither is a unit after a number (50 us).
const KB_FIRST_PERSON_RE = /(?<![\w/\\.-])(?<!\d\s)(?:[Mm]e|[Mm]y|[Ww]e|[Oo]ur|[Uu]s)(?![\w/\\-]|\.\w)/;
// The pronoun I, except as a numeral after a noun that takes one (Phase I).
const KB_FIRST_PERSON_I_RE = /(?<![\w/\\.-])(?<!\b(?:Phase|Type|Tier|Part|Stage|Class|Level|Step|Section|Chapter|Volume|Gen|Rev|Series|Group|Category|Mark)\s)I(?![\w/\\-]|\.\w)/;
// A line-number reference: a path:digits token or the phrase "line N". A
// path:digits token names a source-like extension, with a separator (src/a.ts:42,
// C:\src\a.cs:7) or as a bare file name (kb.mjs:130, a.test.ts:12). A hostname:port
// (registry.npmjs.org:443) or a URL authority (https://host.dev:8080) is not one.
// Extensions that are also country TLDs (.pl, .sh, .md ...) count only as
// name.ext, so api.example.pl:443 is a host, and never on a well-known port.
const KB_LINE_REF_RE = /(?<![\w.\/\\:-])(?:[A-Za-z]:)?(?:[\w.-]*[\/\\])+[\w.-]*\.(?:[cmt]?[jt]sx?|rb|go|java|kts?|scala|c|h|cpp|cxx|hpp|hh|cs|fs|swift|m|php|lua|bash|zsh|ps1|psm1|bat|cmd|sql|vue|svelte|html?|s?css|less|jsonc?|ya?ml|toml|ini|xml|txt|gradle|cmake|proto|graphql|dart|exs?|erl|hs|clj|r|jl|zig|cc|md|mk|ml|mm|pl|py|rs|sh|tf):\d+|(?<![\w.\/\\:-])[\w-]+(?:\.[\w-]+)*\.(?:[cmt]?[jt]sx?|rb|go|java|kts?|scala|c|h|cpp|cxx|hpp|hh|cs|fs|swift|m|php|lua|bash|zsh|ps1|psm1|bat|cmd|sql|vue|svelte|html?|s?css|less|jsonc?|ya?ml|toml|ini|xml|txt|gradle|cmake|proto|graphql|dart|exs?|erl|hs|clj|r|jl|zig):\d+|(?<![\w.\/\\:-])[\w-]+\.(?:cc|md|mk|ml|mm|pl|py|rs|sh|tf):(?!(?:22|80|443|8080|8443)\b)\d+|\bline\s+\d+\b/i;
// The labelled sections a failed-attempt capture's content must carry. CRLF is
// normalised before these run.
const KB_CAUSE_SECTION_RE = /(?:^|\n)[ \t>*#-]*(?:Root[ \t]+)?Cause[ \t*]*(?::|\n|$)/i;
const KB_RULE_FIX_SECTION_RE = /(?:^|\n)[ \t>*#-]*(?:Rule\/Fix|Rule|Fix)[ \t*]*(?::|\n|$)/i;

function kbNormText(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Text with double-quoted and backticked spans removed: a quoted error message
// is not the writer's own voice. Single quotes are left alone (apostrophes).
function kbWithoutQuoted(s) {
  return String(s).replace(/```[\s\S]*?```/g, ' ').replace(/"[^"\n]*"/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// True when content only repeats the summary: equal, the summary plus a few
// characters, or nearly the same words (edited, reordered, or a prefix).
function kbRepeatsSummary(summary, content) {
  const ns = kbNormText(summary);
  const nc = kbNormText(content);
  if (nc === ns || (nc.includes(ns) && nc.length - ns.length < KB_MIN_CONTENT_EXTRA)) return true;
  const summaryWords = new Set(ns.split(' '));
  const contentWords = new Set(nc.split(' '));
  const newWords = [...contentWords].filter((w) => !summaryWords.has(w)).length;
  return newWords < KB_REPEAT_MAX_NEW_WORDS && (contentWords.size - newWords) / contentWords.size >= KB_REPEAT_MIN_OVERLAP;
}

// Lint one capture. Returns null when it passes, or "rule <name>: <detail>"
// naming the first rule it fails. `content` is the trimmed content ('' when
// absent).
function lintKbCapture(c, content) {
  const cues = Array.isArray(c.recall_cues) ? c.recall_cues : [];
  const sigs = Array.isArray(c.error_signatures) ? c.error_signatures : [];
  const all = [c.title, c.summary, content, ...cues, ...sigs];
  if (all.some((s) => /[^\x00-\x7F]/.test(s))) return 'rule ascii-only: non-ASCII character';
  if (c.title.length < KB_MIN_CAPTURE_TITLE) return `rule length: title under ${KB_MIN_CAPTURE_TITLE} chars`;
  if (c.title.length > KB_MAX_CAPTURE_TITLE) return `rule length: title over ${KB_MAX_CAPTURE_TITLE} chars`;
  if (c.summary.length < KB_MIN_CAPTURE_SUMMARY) return `rule length: summary under ${KB_MIN_CAPTURE_SUMMARY} chars`;
  if (c.summary.length > KB_MAX_CAPTURE_SUMMARY) return `rule length: summary over ${KB_MAX_CAPTURE_SUMMARY} chars`;
  if (content.length > 0 && content.length < KB_MIN_CAPTURE_CONTENT) return `rule length: content under ${KB_MIN_CAPTURE_CONTENT} chars`;
  if (content.length > KB_MAX_CAPTURE_CONTENT) return `rule length: content over ${KB_MAX_CAPTURE_CONTENT} chars`;
  if (all.some((s) => KB_PLACEHOLDER_RE.test(s))) return 'rule placeholder: double-brace placeholder token';
  if (all.some((s) => KB_SECRET_RE.test(s))) return 'rule secret: token-shaped credential';
  const prose = [c.title, c.summary, content, ...cues].map(kbWithoutQuoted);
  if (prose.some((s) => KB_FIRST_PERSON_RE.test(s) || KB_FIRST_PERSON_I_RE.test(s))) return 'rule first-person: narrative first-person word';
  const named = Array.isArray(c.symbols) && c.symbols.some((s) => typeof s === 'string' && s.trim().length > 0);
  if (!named && [c.title, c.summary, content].some((s) => KB_LINE_REF_RE.test(s))) return 'rule line-number-only: line reference with no symbol named';
  if (content.length > 0 && kbRepeatsSummary(c.summary, content)) return 'rule content-repeats-summary: content repeats the summary';
  const sections = content.replace(/\r\n?/g, '\n');
  if (c.trigger === 'failed-attempt' && !(KB_CAUSE_SECTION_RE.test(sections) && KB_RULE_FIX_SECTION_RE.test(sections))) {
    return 'rule failed-attempt-sections: content needs a Cause and a Rule/Fix section';
  }
  return null;
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

export function vetKbWork(role, result) {
  const captures = [];
  const promotions = [];
  const rejected = [];

  const rawCaptures = (result && Array.isArray(result.kb_captures)) ? result.kb_captures : [];
  for (const c of rawCaptures) {
    if (!c || typeof c.title !== 'string' || typeof c.summary !== 'string') {
      rejected.push(`${role}: capture missing title/summary`);
      continue;
    }
    // Mirrors the Phase 1 provider invariant: an entry with no basis can never
    // be staled by the freshness sweep, so nothing could ever falsify it.
    if (!Array.isArray(c.source_files) || c.source_files.length === 0) {
      rejected.push(`${role}: capture "${c.title}" cites no source files`);
      continue;
    }
    if (!isStringArray(c.source_files)) {
      rejected.push(`${role}: capture "${c.title}" refused -- rule source-files: source_files must be an array of strings`);
      continue;
    }
    if (c.symbols !== undefined && c.symbols !== null && !isStringArray(c.symbols)) {
      rejected.push(`${role}: capture "${c.title}" refused -- rule symbols: symbols must be an array of strings`);
      continue;
    }
    if (!KB_CAPTURE_TYPES.includes(c.type)) {
      rejected.push(`${role}: capture "${c.title}" has unsupported type ${String(c.type)}`);
      continue;
    }
    if (!KB_CAPTURE_TRIGGERS.includes(c.trigger)) {
      rejected.push(`${role}: capture "${c.title}" refused -- rule trigger: missing or unknown trigger ${String(c.trigger)}`);
      continue;
    }
    // content is optional: absent or empty forwards no content key and the
    // server stores the summary as the content.
    if (c.content !== undefined && c.content !== null && typeof c.content !== 'string') {
      rejected.push(`${role}: capture "${c.title}" refused -- rule content: content is not a string`);
      continue;
    }
    if ((c.recall_cues !== undefined && !isStringArray(c.recall_cues))
      || (c.error_signatures !== undefined && !isStringArray(c.error_signatures))) {
      rejected.push(`${role}: capture "${c.title}" refused -- rule cues: recall_cues/error_signatures must be arrays of strings`);
      continue;
    }
    const content = typeof c.content === 'string' ? c.content.trim() : '';
    const lint = lintKbCapture(c, content);
    if (lint) {
      rejected.push(`${role}: capture "${c.title}" refused -- ${lint}`);
      continue;
    }
    captures.push({
      type: c.type,
      title: c.title,
      summary: c.summary,
      ...(content.length > 0 ? { content: c.content } : {}),
      trigger: c.trigger,
      source_files: c.source_files,
      symbols: Array.isArray(c.symbols) ? c.symbols : [],
      ...(Array.isArray(c.recall_cues) && c.recall_cues.length > 0 ? { recall_cues: c.recall_cues } : {}),
      ...(Array.isArray(c.error_signatures) && c.error_signatures.length > 0 ? { error_signatures: c.error_signatures } : {}),
    });
  }

  const rawPromotions = (result && Array.isArray(result.kb_promotions)) ? result.kb_promotions : [];
  if (rawPromotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
    rejected.push(`${role}: kb_promotions refused -- promotion is reviewer-only`);
  } else {
    for (const p of rawPromotions) {
      if (!p || typeof p.id !== 'string' || p.id.length === 0) {
        rejected.push(`${role}: promotion missing id`);
        continue;
      }
      if (typeof p.reason !== 'string' || p.reason.trim().length < KB_MIN_PROMOTE_REASON) {
        rejected.push(`${role}: promotion ${p.id} has no recorded evidence`);
        continue;
      }
      promotions.push({ id: p.id, reason: p.reason.trim() });
    }
  }

  // kb_rejects: the reviewer's REJECT judgement (true but fails the capture
  // rubric). Vetted exactly like the fleet-sprint engine so the copies agree;
  // an id also promoted in the same output is refused on both sides.
  const rejects = [];
  const rawRejects = (result && Array.isArray(result.kb_rejects)) ? result.kb_rejects : [];
  if (rawRejects.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
    rejected.push(`${role}: kb_rejects refused -- reject is reviewer-only`);
  } else {
    for (const r of rawRejects) {
      if (!r || typeof r.id !== 'string' || r.id.length === 0) {
        rejected.push(`${role}: reject missing id`);
        continue;
      }
      if (typeof r.reason !== 'string' || r.reason.trim().length < KB_MIN_PROMOTE_REASON) {
        rejected.push(`${role}: reject ${r.id} has no recorded evidence`);
        continue;
      }
      rejects.push({ id: r.id, reason: r.reason.trim() });
    }
  }
  const rejectIds = new Set(rejects.map((r) => r.id));
  const conflicted = new Set(promotions.filter((p) => rejectIds.has(p.id)).map((p) => p.id));
  for (const p of promotions) {
    if (conflicted.has(p.id)) rejected.push(`${role}: promotion ${p.id} refused -- the same output also rejects it (promote reason: ${p.reason})`);
  }
  for (const r of rejects) {
    if (conflicted.has(r.id)) rejected.push(`${role}: reject ${r.id} refused -- the same output also promotes it (reject reason: ${r.reason})`);
  }

  // kb_discards is applied only by the fleet-sprint engine (maintainer-routed
  // kb_invalidate). This legacy workflow has no discard path, so refuse and log
  // rather than silently dropping a reviewer's DISCARD.
  if (result && Array.isArray(result.kb_discards) && result.kb_discards.length > 0) {
    rejected.push(`${role}: kb_discards refused -- not supported by this workflow (${result.kb_discards.length} dropped)`);
  }

  return {
    captures,
    promotions: promotions.filter((p) => !conflicted.has(p.id)),
    rejects: rejects.filter((r) => !conflicted.has(r.id)),
    rejected,
  };
}
