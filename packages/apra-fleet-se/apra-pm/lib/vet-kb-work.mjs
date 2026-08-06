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
    if (!KB_CAPTURE_TYPES.includes(c.type)) {
      rejected.push(`${role}: capture "${c.title}" has unsupported type ${String(c.type)}`);
      continue;
    }
    // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)).
    // Omitting it meant every kb_capture failed zod validation at the MCP
    // boundary and persisted nothing.
    if (typeof c.content !== 'string' || c.content.trim().length === 0) {
      rejected.push(`${role}: capture "${c.title}" has no content`);
      continue;
    }
    captures.push({
      type: c.type,
      title: c.title,
      summary: c.summary,
      content: c.content,
      source_files: c.source_files,
      symbols: Array.isArray(c.symbols) ? c.symbols : [],
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

  return { captures, promotions, rejected };
}
