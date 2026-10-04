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
  const demotions = [];
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

  // D6/C4: kb_demotions is gated exactly like kb_promotions -- same
  // reviewer-only role check, same KB_MIN_PROMOTE_REASON evidence floor.
  // Lowering trust is exactly as auditable an act as raising it.
  const rawDemotions = (result && Array.isArray(result.kb_demotions)) ? result.kb_demotions : [];
  if (rawDemotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
    rejected.push(`${role}: kb_demotions refused -- demotion is reviewer-only`);
  } else {
    for (const d of rawDemotions) {
      if (!d || typeof d.id !== 'string' || d.id.length === 0) {
        rejected.push(`${role}: demotion missing id`);
        continue;
      }
      if (typeof d.reason !== 'string' || d.reason.trim().length < KB_MIN_PROMOTE_REASON) {
        rejected.push(`${role}: demotion ${d.id} has no recorded evidence`);
        continue;
      }
      const evidenceFiles = Array.isArray(d.evidence_files)
        ? d.evidence_files.filter((f) => typeof f === 'string' && f.length > 0)
        : [];
      demotions.push({ id: d.id, reason: d.reason.trim(), evidence_files: evidenceFiles });
    }
  }

  // my-beads-db-qy8.13: ONE id cannot be promoted and demoted in the same
  // round. A single INFERRED entry citing a file the round touched reaches
  // the reviewer in BOTH the promotion and the demotion candidate block, and
  // the two loops above validate independently -- so both halves pass and the
  // executor would run kb_promote then kb_demote on that id: no net
  // confidence change, two notes appended, demoted_at stamped for nothing.
  //
  // Refused BOTH ways rather than picking a winner: the pair is
  // self-contradictory evidence about the same claim, and honouring either
  // half would record a trust decision the reviewer did not actually make.
  // Must stay byte-identical to the copies in fleet-sprint/kb.mjs and
  // .claude/workflows/auto-sprint.js, refusal string included.
  const collidingIds = new Set(
    demotions.filter((d) => promotions.some((p) => p.id === d.id)).map((d) => d.id),
  );
  for (const id of collidingIds) {
    rejected.push(`${role}: ${id} appears in both kb_promotions and kb_demotions -- refused both ways`);
  }

  return {
    captures,
    promotions: promotions.filter((p) => !collidingIds.has(p.id)),
    demotions: demotions.filter((d) => !collidingIds.has(d.id)),
    rejected,
  };
}
