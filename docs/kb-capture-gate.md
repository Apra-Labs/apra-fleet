# KB capture gate, reviewer rejects, and the rich bible

How a sprint decides what enters the knowledge bank, how a reviewer retires a
bad entry, and what the committed bible carries per entry.

## Capture gate (engine side)

Roles return `kb_captures`; the engine, not the role, calls `kb_capture`. Before
it does, `vetKbWork` (fleet-sprint `kb.mjs`, mirrored for the auto-sprint
workflow in `apra-pm/lib/vet-kb-work.mjs`) refuses a capture when:

- it has no `trigger`, or the trigger is not one of `failed-attempt`,
  `review-finding`, `test-failure`, `env-quirk`, `hidden-invariant`,
  `design-rationale`. There is deliberately no "describes the change" trigger.
- `lintKbCapture` finds a defect: non-ASCII text, a field outside its length
  bounds (title 8-160, summary 20-500, content 40-2000), placeholder tokens,
  token-shaped credentials, first-person wording, a line-number-only reference,
  `content` that repeats the `summary` (also near-duplicates: edited, reordered
  or a prefix), or a `failed-attempt` whose content has no Cause (or Root cause)
  or Rule/Fix section.

Every refusal is logged with the name of the rule that fired. The shared
rubric all roles read is `apra-pm/agents/_shared/KB-CAPTURE-RUBRIC.md`.

**A bad capture never costs the report.** The role output schemas document these
rules in `description` text and enforce none of them for `kb_captures` items, so
a capture that breaks one fails `vetKbWork` alone: that capture is refused and
logged, and the verdict and the other captures stand. Do not add `required`,
`enum`, `minLength` or `maxLength` to a capture item: ajv would then fail the
whole report, and a degraded reviewer round loses its verdict.

The `kb_capture` tool itself stays permissive: `trigger` is optional and stored
for audit in its own column, and `content` is optional (the server stores
`content = summary` when absent). Strictness lives in the engine so other
callers of the tool are not broken.

The lint exists three times (fleet-sprint `kb.mjs`, apra-pm
`lib/vet-kb-work.mjs`, the inlined workflow `auto-sprint.js`); a drift test pins
every constant and function across them. Change all three together.

Known lint limits: a multi-dot file name with an extension that is also a
country TLD (`a.test.py:12`) is read as a host, and so is `name.py:443` on a
well-known port (22, 80, 443, 8080, 8443). The phrase `line N` is refused even
inside a quoted error when no symbol is named.

## Reviewer kb_rejects

The reviewer may return `kb_rejects`: entries to retire, each with a reason of
at least 20 characters. Only the reviewer may reject; an id judged in more than
one way (rejected and promoted, say) is refused on every side. The engine
executes a reject through `kb_invalidate {ids, reason}`. The reason is stored in
`retired_note`, a column separate from `retired_reason` (the internal
superseded/invalidated marker that `kb_bible_commit` reports), so retirement
notes never disturb bible-commit reporting. `reason` is accepted only with
`ids`; `files` plus `reason` is an error before any write. A retire the maintainer
session refuses (a lost grant) is logged as a WARN and counted as neither
rejected nor discarded. The final review may return `kb_rejects` too.

## Rich bible entries

An entry in the committed bible may carry `content`, `recall_cues` and
`error_signatures` in addition to its summary. These are optional additive
fields, so the bible keeps its version and an old bible imports exactly as
before.

- Writer: `content` is written only when, after cutting the KB's own audit
  notes (promotion, demotion, confidence-clamp, feedback and reconcile notes),
  it is non-empty and differs from the summary. It is capped at 2000
  characters (longer is truncated with a visible marker). Cues and signatures
  are written only when non-empty, so an entry without them serializes
  byte-identically to the older writer.
- Reader: a valid field is stored; a malformed one is dropped at field level
  and the entry still imports (it is not counted as skipped). Absent or
  invalid content falls back to the summary.
- `merge-kb-canonical` treats all three as content fields.
- Re-promotion: `kb_bible_commit` keeps the fields the bible already holds for a
  merged id and fills only what is missing from the row, so a clone with an older
  row cannot overwrite a rewritten entry.
- Backfill: `kb_bible_commit {enrich: [{id, content?, recall_cues?,
  error_signatures?}]}` is the one way to change these fields on an existing
  CONFIRMED entry. It sets them in the bible and in this KB's row and commits;
  the claim, basis, confidence and `updated_at` stay, and no basis re-admission
  runs. kb_maintainer or FULL session only. Other clones get the fields when they
  read the bible or import a new id; an existing row elsewhere keeps its older
  content for FULL-session reads, because import skips an id it already holds.
- Secrets: a merge or an export writes `[REDACTED]` over token-shaped strings and
  placeholders in every free-text field and logs a warning naming the entry. This
  is the second gate after the capture lint, for direct `kb_capture` callers.

The normative wording lives in `memory-contract/v1/spec.md` (sections on the
bible format and capture retrieval aids); schemas, the v3 rich-content example
and the `apra-fleet-client` typedefs move in the same change as the tools.
