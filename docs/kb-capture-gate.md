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
- `lintKbCapture` finds a defect: non-ASCII text, over-length fields,
  placeholder tokens, first-person wording, a line-number-only reference,
  `content` that repeats the `summary`, or a `failed-attempt` whose content has
  no Cause or Rule/Fix section.

Every refusal is logged with the name of the rule that fired. The shared
rubric all roles read is `apra-pm/agents/_shared/KB-CAPTURE-RUBRIC.md`.

The `kb_capture` tool itself stays permissive: `trigger` is optional and stored
for audit in its own column, and `content` is optional (the server stores
`content = summary` when absent). Strictness lives in the engine so other
callers of the tool are not broken.

The lint exists twice (fleet-sprint and apra-pm); a drift test keeps the copies
in step. Change both together.

Known lint gaps: the first-person check is case-insensitive, so the country
name "US" is refused; a `host:port` whose last label looks like a source
extension (for example a `.pl` or `.sh` host) is read as a line reference.

## Reviewer kb_rejects

The reviewer may return `kb_rejects`: entries to retire, each with a reason of
at least 20 characters. Only the reviewer may reject; an id judged in more than
one way (rejected and promoted, say) is refused on every side. The engine
executes a reject through `kb_invalidate {ids, reason}`. The reason is stored in
`retired_note`, a column separate from `retired_reason` (the internal
superseded/invalidated marker that `kb_bible_commit` reports), so retirement
notes never disturb bible-commit reporting. `reason` is accepted only with
`ids`; `files` plus `reason` is an error before any write.

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

The normative wording lives in `memory-contract/v1/spec.md` (sections on the
bible format and capture retrieval aids); schemas, the v3 rich-content example
and the `apra-fleet-client` typedefs move in the same change as the tools.
