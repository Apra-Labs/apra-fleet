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

## The kb_maintainer grant protects CONFIRMED entries from member sessions

A member session (one without the kb_maintainer grant) can neither mint nor
retire CONFIRMED entries:

- `kb_reconcile_prefilter` is a maintainer-only tool (it sits in the maintainer
  tool set of the member tool allowlist), and the reconciler tag profile grants
  no write tools.
- `kb_import` with an explicit `path` other than the session's own bible is
  refused with `E-KB-MAINTAINER-REQUIRED` unless the session holds the grant.
- `kb_invalidate` (by `ids` or by `files`) keeps CONFIRMED entries live and
  reports them in `refused`; the underlying provider `discard` and `invalidate`
  take a keep-CONFIRMED flag, so the guarantee holds below the tool layer.
- `kb_capture` with `supersedes` never retires a CONFIRMED target (whoever
  owns it): the capture links to it (`refines`, both live) and lists it in
  `refused`. A non-CONFIRMED target is still retired. Over a remote KB
  provider the grant cannot be conveyed, so `supersedes` is dropped entirely.
- `kb_import` with no path, or with the own path, reads the bible as committed
  at `HEAD`, never the member-writable work-tree file; when a work-tree bible
  has no committed copy it imports nothing (`E-KB-MAINTAINER-REQUIRED`).
- Committed alone is not trusted: the member controls its own `.git`, so it
  could commit a hand-made bible locally, import it, and `git reset` the commit
  away with nothing ever pushed for review to see. The no-path import is
  therefore gated on a trust anchor outside the checkout. The hub-side
  per-repo KB database (table `trusted_bible_blobs`) records the git blob id
  of every bible the maintainer side writes or imports: `kb_bible_commit`, and
  `kb_import` from a FULL session or the kb_maintainer session. A member
  session without the grant only reads that record. When the blob id of the
  committed bible is not recorded, the import fails with
  `E-KB-MAINTAINER-REQUIRED` naming the unrecorded blob, and nothing is
  imported. It refuses rather than clamping CONFIRMED entries to a lower tier,
  because a clamped row would occupy its id and the import's id-exists skip
  would then keep the genuine CONFIRMED entry out later.
- The object store is member-writable too: a replace ref
  (`git replace <trusted> <forged>`), an overwritten loose object, an
  alternates entry or a crafted pack can make git return other bytes for a
  trusted id. So the blob is read with `--no-replace-objects` and its bytes
  are hashed in-process (`blob <len>\0<bytes>`, sha1 or sha256 by id length)
  and refused unless they equal the id checked. Ids recorded as trusted are
  likewise computed in-process from the exact bytes written or parsed, never
  by `git hash-object` on a path (which would re-read the file and run the
  checkout's member-configured clean filters).

### Bootstrap

- A clone (including a fresh one) whose bible was published by the
  kb_maintainer's `kb_bible_commit` on this hub carries a recorded blob id and
  imports normally.
- A bible this hub has never seen (a fresh hub, or a bible merged in from
  another hub) is seeded by the engine's sprint-start priming: it imports the
  bible through the repository's kb_maintainer session, which holds the grant,
  so the import records the blob id. That import passes
  `ref: "refs/remotes/origin/<base branch>"`, so it reads the bible committed
  on the base branch (hash-verified), never the maintainer's work tree or
  `HEAD`. Priming runs before anything cleans the maintainer's checkout:
  launch alignment runs only for multi-member legacy launches (not for a
  single-member or `--sync` sprint), branch-ensure's WIP autostash runs after
  priming, and a reused local sprint branch keeps local-only commits. With no
  base branch the engine makes no grant import at all.

### Remaining exposure

- The base branch's remote-tracking ref is only as fresh as the member's last
  fetch, and like every ref it lives in the member-writable `.git`; a process
  that rewrites it deliberately is outside this model (next point).
- For a remote member, kb tools run through `apra-fleet call` on the member's
  own host, so the "hub-side" KB database holding `trusted_bible_blobs` is a
  file on the member's own machine, writable by the member's OS user (and so
  by an agent running there). The `--kb-maintainer` flag of `apra-fleet call`
  is not authenticated either: an agent on the member host can open the
  grant session itself. Both are known limits: the grant is a routing guard
  that keeps agent sessions off the CONFIRMED-minting paths, not a security
  boundary against a process running as the member's user.
- A grant import or `kb_bible_commit` without `ref` (for example an explicit
  `path` import by the reconciler) trusts the file it reads, exactly as every
  other kb_maintainer write already is. A member session without the grant
  can no longer get a bible imported at CONFIRMED that the maintainer side did
  not write or import. A local process with access to the hub (which can open
  a FULL session or write the database file) is outside this model, as for
  the grant itself.
