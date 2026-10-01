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
maintainer's checkout is on the sprint branch. The engine guarantees it two ways:

- Branch ensuring covers every selected maintainer, not only members of the
  dispatched role pools. A role-less maintainer (or an explicit maintainer with
  no other role) gets the first sprint-branch ensure and every later re-ensure,
  but is never dispatched. Selection runs before the ensure list is built.
- Before the first bible attempt, before the retry reset and before the cleanup
  reset, the engine reads the maintainer's current branch (built in JS, no shell
  expansion). If it differs from the sprint branch, or cannot be read, nothing
  is pulled, committed, pushed or reset; a warning names both branches and the
  ids stay queued.

Any change to branch ensuring or maintainer selection must preserve both.

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
seal.

Reset guard: before either bible-commit reset path, the engine requires a
clean tracked tree and that every local-only commit (remote tip..HEAD) touches
only `.fleet/kb-canonical.json`. Otherwise nothing is reset, a warning is
logged and the ids stay queued, so unrelated unpushed work on the maintainer is
preserved. The doer-retry reset to the remote tip is a separate path and is
unchanged. The guard compares against `origin/<branch>`; it assumes the default
remote.

A `committed:false` answer (entry set unchanged) does not by itself mean the
round is published: when the reset guard refused a reset, an earlier round's
bible commit can still sit unpushed on the maintainer. After `committed:false`
the engine checks the checkout against `origin/<branch>`: if a local-only
commit touches the bible it is pushed (same retry and reset guards as a new
commit); if origin already holds the bible the ids leave the queue with
"already in the bible -- nothing to push"; otherwise (an uncommitted bible
change, a git failure, no check wired) the ids stay queued with a warning.
Confirmations still unpublished when the analysis document is written are
listed in its "KB bible" section, per repository with a count.

`kb_bible_commit` is declared in `memory-contract/v1` and the
`apra-fleet-client` package.
