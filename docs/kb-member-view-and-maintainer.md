# KB member bible view, maintainer routing, and round bible commits

How a member session reads the KB, who is allowed to write it during a sprint,
and how a review round's confirmations reach the canonical bible.

## Member bible view (reads)

A MEMBER session does not read the central or local database. Its
`kb_query`, `kb_session_prime`, `kb_list`, `kb_context` and `kb_stats` read an
in-memory view built from the bible (`.fleet/kb-canonical.json`) in the
member's own checkout.

- The view is cached per bible path. Each read does one `stat`; the view is
  rebuilt only when mtime or size changed. Different branches therefore see
  different views, and a server restart rebuilds from disk.
- The bible is loaded verbatim: entry ids and confidence are preserved, and no
  AUDN dedupe runs against sibling entries.
- A malformed bible is never cached; the read reports the failure.
- A remote member's bible is fetched over the member transport. A transport
  failure surfaces as `E-MEMBER-VIEW-REMOTE`.
- FULL (non-member) sessions are unchanged.

### Own-scope writes

A MEMBER capture is tagged `member:<uuid>`. INFERRED reads, `kb_promote` and
`kb_invalidate` in a MEMBER session only see entries carrying that member's
own tag, so a member cannot promote or discard another member's entries.
`kb_invalidate {ids}` discards entries by setting `superseded_at`.
`kb_feedback` is rejected in a member session with
`E-MEMBER-VIEW-READ-ONLY`, since the view is a read-only projection.

## One kb_maintainer per repository (writes)

Every sprint KB write for a repository is routed to a single member, the
kb_maintainer, chosen once at sprint setup and logged one line per repository.
A member belongs to a repository when its work folder's normalized `origin`
matches. Selection order: (a) an explicit `roleMap.kb_maintainer` member;
(b) a role-less member (named in no dispatched role); (c) any role-mapped
member whose checkout is that repository. The first candidate whose
availability probe (a read-only `kb_stats` as that member) succeeds wins;
skipped candidates are logged as replacements. A member whose work folder is
not a repository can never be a maintainer, and its captures are dropped with
a warning. `kb_maintainer` is not a dispatched role.

Writes run through a per-repository queue. Before each batch the maintainer is
fast-forwarded to the sprint branch (fetch, then `merge --ff-only`). The queue
is held while the maintainer is mid-dispatch, while a pull is in flight, or
while the maintainer is unreachable. Review candidates are read from the
maintainer by member tag within the sprint window; `kb_promotions` confirm and
`kb_discards` invalidate there.

### Invariant: the maintainer must be on the sprint branch

The fast-forward pull, the bible commit and the push all assume the
maintainer's checkout is on the sprint branch. The engine only ensures the
sprint branch for members drawn from the dispatched role pools. A maintainer
outside every pool (a role-less member, or an explicit maintainer with no
other role) is not ensured, so writes would pull into, commit on and fail to
push from whatever branch it has checked out. This is a known open defect; any
change to branch ensuring or maintainer selection must keep the maintainer
on the sprint branch before the first write batch.

## Round bible commit (kb_bible_commit)

`kb_bible_commit {ids, baseBranch, baseCommit}` replaces the engine's own
bible export. It merges at entry level, not by regenerating the bible:

- Every entry already in the file is kept; only the given ids are added or
  replaced. An entry present in the file but absent from the DB is never
  dropped. Each id must be a live CONFIRMED entry; others are reported in
  `skipped`.
- An unreadable existing bible is never overwritten.
- Provenance records the sprint's target base branch and base commit given by
  the caller, never the working folder's HEAD (usually a feature branch).
- The commit is local, scoped to the bible file, with the `pm-kb` identity. It
  never pushes. `kb_export` gained the same `baseBranch`/`baseCommit` inputs.

The engine's round commit is: pull, `kb_bible_commit`, push, with one retry.
If the push is rejected, it resets to the new remote head (which may hold
another clone's entries) and repeats the same ids; because the merge is
entry-level, the result holds both sets. A second failure leaves the round
queued. Nothing is committed after a FAIL verdict or abort except the final
seal. Caveat: the retry's hard reset discards unpushed commits and
uncommitted changes on the maintainer, so the maintainer's checkout must be
dedicated to KB commits.

`kb_bible_commit` is declared in `memory-contract/v1` and the
`apra-fleet-client` package.
