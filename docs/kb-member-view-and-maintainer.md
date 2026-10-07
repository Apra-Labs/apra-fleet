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

### `own_scope`: the opt-in escape hatch from the bible view

A plain CONFIRMED read in a MEMBER session is answered from the checkout
bible view above, and every row of that view is stamped `tags: []` on import
-- so a read filtered by `tag: member:<uuid>` can never match anything there,
no matter how it is phrased. `own_scope: true` on `kb_query` is the fix: it
routes the read to the PER-REPO DATABASE instead of the bible view, with the
caller's own `ownerTag` applied server-side, which is the only row set
`kb_demote`'s ownership check can act on. This is why a demotion-candidate
read (below) must pass `own_scope: true` explicitly -- without it, the read
is silently answered from a view that can never contain a demotable row.
`own_scope` only changes which store answers a CONFIRMED read in a MEMBER
session; it does not add a new write capability.

## Reviewer demotions (the fleet-sprint engine's write-back for `kb_demote`)

The engine, not the reviewer, holds the authority to call `kb_demote` and to
commit the resulting tombstone -- the reviewer only names which offered id to
demote and why, exactly like `kb_promotions`/`kb_discards`.

1. **Offer.** Before a review dispatch, `demotionCandidates(member, {scope})`
   reads the maintainer's own CONFIRMED rows tagged to that maintainer
   (`own_scope: true`, `confidence: ['CONFIRMED']`, `include_stale: true`,
   `exclude_disputed: false` -- a stale or contradiction-flagged row is
   explicitly demotable, not excluded), reading wide (up to 500 rows) BEFORE
   filtering eligibility (not superseded, not a user-directive) and relevance
   (the entry's `source_files` overlap this review scope's changed files),
   and only THEN caps the survivors to the prompt-sized offer limit. Filtering
   after capping would let an arbitrary slice of a maintainer's rows crowd out
   the ones actually relevant to this round. The offered id set is recorded
   per repository and reset at the start of every call, so a failed read
   never leaves a stale offer and the FINAL (sprint-scope) review never
   inherits a round's leftover offer.
2. **Judge.** The reviewer returns `kb_demotions: [{id, reason,
   evidence_files?}]`, structurally identical to `kb_promotions`/`kb_discards`.
   An id is accepted only if it was in THIS dispatch's own offered set --
   checked against the demotion offer specifically, never against the
   promotion offer, since being offered for one is not being offered for the
   other. An id named in more than one of `kb_promotions`, `kb_discards` and
   `kb_demotions` is refused in every list it appears in.
3. **Apply and publish atomically.** Accepted demotions are applied via
   `kb_demote` on the maintainer (a member-scoped `memberCall`, never a
   direct DB write), and the resulting ids are passed as `kb_bible_commit`'s
   `demoted_ids` in the SAME pull/commit/push cycle as that round's
   `kb_promotions` ids -- never a separate write-back pass. A push failure
   resets and retries with the same `ids` and `demoted_ids` together, exactly
   like a promotion-only round (see "Round bible commit" above).
4. **In-sprint ping-pong guard.** A row demoted earlier in the same sprint is
   excluded from being re-offered unless its cited basis has visibly changed
   since the demotion: the guard compares `demoted_basis_hashes` (the
   on-disk hash of every cited file AT DEMOTE TIME) against a fresh re-hash,
   and only lets the entry back onto the offer list if at least one cited
   file's hash differs. An entry with no recorded basis, a re-hash that could
   not be computed, or a cited file that vanished from disk is NEVER treated
   as "unchanged" by this guard -- it stays offered rather than being
   silently ping-ponged out forever on a basis the guard cannot actually
   verify.

## One kb_maintainer per repository (writes)

Every sprint KB write for a repository is routed to a single member, the
kb_maintainer, chosen once at sprint setup and logged one line per repository.
A member belongs to a repository when its work folder's normalized `origin`
matches. Selection order: (a) an explicit `roleMap.kb_maintainer` member;
(b) a role-less member (named in no dispatched role); (c) any role-mapped
member whose checkout is that repository. A member mapped to
`roleMap.orchestrator` is never a maintainer under any rule (an explicit
`roleMap.kb_maintainer` naming it is ignored with a WARNING), and is never
added to the sprint-branch ensure set through the maintainer path; if it is the
only member with a checkout of a repository, that repository gets no maintainer
and a `[kb-maintainer]` WARNING says so. The first candidate whose
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
  dropped. Each id must be a live CONFIRMED entry that also passes the same
  basis rule as `kb_export` (every cited file's current hash equals the
  recorded basis); others are reported in `skipped` with reason
  `not_confirmed_or_unknown` or `basis_mismatch`, and a skipped id leaves any
  existing bible entry unchanged.
- Admission is one predicate, not two copies: both `kb_bible_commit` and
  `kb_export` call `filterProjectBibleCandidates` (bible-basis-filter) with the
  project's source-file bases. Any change to what the bible admits must be made
  there, so the two tools can never disagree on a mixed set of ids. The engine
  logs each skip with its reason and drops the id from its queue.
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

## Bible git safety invariants

The maintainer's bible sync (pull, commit, push, reset) is an automated writer
on a repository that other work shares, so it is conservative by construction:

- Every bible git step first checks that the checkout is on the sprint branch;
  on any other branch it refuses rather than touching history.
- A bible push is blocked when it would also publish commits other than the
  bible commit (the "unpushed-only-bible" check), so a maintainer can never
  push someone else's unreviewed work as a side effect.
- `kb_context` defaults to CONFIRMED + INFERRED; for a member that is the
  committed bible merged with the member's own captures.
