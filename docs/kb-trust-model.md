# KB Trust Model

The Knowledge Bank assigns every entry a confidence level. The ladder is
mostly one-way -- moving UP it is the normal, frequent path -- but it is not
purely one-way any more: exactly one rung can also be walked back DOWN, through
its own dedicated tool, under rules just as strict as the ones that grant
trust.

## The trust ladder (two-way)

```
UNVERIFIED  ->  INFERRED  ->  CONFIRMED
                INFERRED  <-  CONFIRMED   (kb_demote)
```

- UNVERIFIED -- extracted but not checked (e.g. auto-harvested from a transcript,
  or a raw session insight). Lowest trust.
- INFERRED -- verified by reading source, or captured deliberately by an agent.
  This is the default and the ceiling for kb_capture.
- CONFIRMED -- the reviewer approved the code the entry describes. Highest trust.

## kb_capture caps at INFERRED

kb_capture clamps any incoming confidence to a maximum of INFERRED. UNVERIFIED and
INFERRED pass through unchanged; a CONFIRMED passed to kb_capture is downgraded to
INFERRED. The clamp is enforced at two layers so no caller can bypass it: the
kb_capture tool handler (which surfaces the user-facing flag) AND
SqliteProvider.capture(), the choke point the HTTP route also passes through.
The downgrade is never silent: the result carries `confidence_clamped: true`
and a short note is appended to the entry content
("[confidence clamped: CONFIRMED requires kb_promote]"). The flag is derived
from stored-vs-requested confidence, so a user-directive -- stored UNVERIFIED
as a pending proposal -- also reports `confidence_clamped: true` (without the
note, since kb_promote is not its remedy).

## kb_promote is the sole path to CONFIRMED

kb_promote is the only way an entry reaches CONFIRMED. It requires an entry id and
a reason (appended to the content as an evidence trail) and steps the entry up one
rung: UNVERIFIED -> INFERRED, or INFERRED -> CONFIRMED. The workflow is therefore:
capture at INFERRED, then promote to CONFIRMED after the reviewer approves.

## kb_demote is the only way back down, and only one rung

kb_demote reverses exactly one step of the ladder: CONFIRMED -> INFERRED, and
nothing else. It is not a ladder in its own direction -- it is not possible to
walk an entry down through INFERRED to UNVERIFIED, and calling it on an entry
that is not CONFIRMED is REFUSED outright (`E-DEMOTE-NOT-CONFIRMED`), never
silently accepted as a no-op. Like kb_promote it requires a reason (recorded as
an audit note on the entry), and it never touches `promoted_at` or `source` --
the record of when and how the entry originally earned CONFIRMED survives its
own reversal.

**The one case kb_demote is for:** the cited basis is unchanged, but a
deliberate re-check shows the claim does not hold as broadly as the CONFIRMED
grade implies -- the entry is still broadly right, just less certain than it
claims. A basis that has DRIFTED or been REMOVED entirely is a *different*
case, already handled by other mechanisms, and is NOT what kb_demote is for:
the freshness sweep stales an entry whose cited files no longer match their
recorded hash, and the project-bible basis predicate (kb_export/
kb_bible_commit) excludes an entry whose basis no longer resolves. Reach for
kb_demote only when re-reading the SAME basis changed your mind, not when the
basis itself moved out from under the entry.

**Who can demote what.** A member session is served `kb_demote` only with the
engine's kb_maintainer grant, exactly like `kb_promote` (memory-contract spec
section 2.5a); role agents never call it. The same own-scope rule kb_promote and kb_invalidate
already follow applies: in a MEMBER session, `kb_capture` tags every stored
entry `member:<caller uuid>`, and `kb_demote` (like `kb_promote` and
`kb_invalidate`) acts only on entries carrying the caller's own tag -- any
other id is reported not found, exactly like an unknown id, so an entry's mere
existence is never disclosed to a session that does not own it. The
consequence worth stating explicitly: a row that reached this clone through
`kb_import` (the project bible) carries NO member tag at all, because the
bible is not scoped to any one contributor. So inside a MEMBER session, only
the entries that member itself captured and later promoted to CONFIRMED are
demotable -- a CONFIRMED entry the clone holds only because it was imported
from the bible cannot be demoted from that session. A FULL session carries no
ownerTag restriction and may demote any CONFIRMED row, bible-imported or not.

## Bible tombstones: demotions cross clones by explicit record, never by absence

Promoting an entry and exporting it to the committed project bible
(`.fleet/kb-canonical.json`) is how trust reaches every other clone. Demoting
it has to reach every other clone too, but a demotion cannot be represented
the same way a promotion is (simply "present in the bible, at this tier"),
because **a clone legitimately holds CONFIRMED entries that were never
exported** -- a local-only promotion nobody has run `kb_export`/
`kb_bible_commit` on yet, or an entry that failed the bible's basis-match
admission check. If a demotion were inferred merely from an entry's absence
from the bible, every one of those legitimate, never-exported CONFIRMED rows
would look demoted to anyone who imported that bible -- which is exactly
backwards.

So a demotion is carried by an EXPLICIT tombstone instead: `kb_bible_commit`'s
optional `demoted_ids` input removes a demoted id from the bible's `entries`
list and records it in a separate, optional top-level `demotions` array as
`{id, demoted_at}`. **Absence from the bible is never, by itself, evidence of
a demotion** -- only an explicit tombstone entry is. When another clone
imports that bible (`kb_import`), it applies each tombstone to its own local
row, lowering it from CONFIRMED to INFERRED only when that row's own
`promoted_at` is strictly BEFORE the tombstone's `demoted_at` -- so a row that
was independently re-promoted on newer evidence, after the tombstone's time,
is left alone rather than being silently re-demoted.

## Forward-only enforcement (no migration)

The gate is forward-looking. The KB may contain historical entries that were written
directly at CONFIRMED before the gate existed; these are NOT rewritten or migrated.
Enforcement applies only to captures made from the gate onward.

## Exceptions and low-trust paths

- user-directive: a standing instruction the user gives during a
  sprint ("always do X", "never do Y", "we decided Z"). This is the single entry
  type captured at CONFIRMED directly -- the sole exemption from the clamp.
- Auto-harvest: entries produced by the kb_harvest autowire are regex-extracted
  from session transcripts, unreviewed, and always captured at UNVERIFIED. Harvest
  can never mint CONFIRMED -- the same gate covers it.

## Routing guidance: which tool for which situation

The KB's confidence-lowering surface is short and each tool has exactly one
job; do not reach for the wrong one:

- **The entry is still broadly right, just less certain than CONFIRMED
  claims** (basis unchanged, a re-check turned up a narrower case) ->
  `kb_demote`. Lowers CONFIRMED to INFERRED, nothing else, with a reason.
- **The entry is actively wrong** -> `kb_feedback` (flags it and marks it
  stale for human review, but never touches confidence) or, when it forms a
  genuine contradiction with another entry and you know which one wins,
  `kb_resolve_contradiction` (retires the loser outright; still a validity
  transition, not a confidence change).
- **You are discarding an unconfirmed (UNVERIFIED/INFERRED) capture that was
  never worth promoting** -> `kb_discards` (the reviewer's structured-output
  judgement) or directly `kb_invalidate` (`{ids}` -- sets `superseded_at`,
  never deletes).

`kb_demote` is the only one of these that can ever lower a CONFIRMED entry's
stored confidence, and it can only ever lower it to INFERRED.
