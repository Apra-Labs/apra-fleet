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
caller's own `ownerTag` applied server-side. The final review's
demotion-candidate read (below) uses it for the maintainer's own CONFIRMED rows
that are not in the bible yet, alongside a plain (file-filtered) read of the
bible view for every other CONFIRMED entry.
`own_scope` only changes which store answers a CONFIRMED read in a MEMBER
session; it does not add a new write capability.

## Reviewer demotions (merge-carried withdrawals, final review only)

The engine, not the reviewer, records a demotion -- the reviewer only names
which offered id to demote (or hold) and why, exactly like
`kb_promotions`/`kb_discards`. No `kb_demote` is ever issued by a sprint: a
demotion is a withdrawn tombstone in the sprint branch's bible, so it takes
effect for any clone only once that branch merges and the merged base bible
is imported (`kb_import`).

1. **Offer (final review only).** A round review is offered no demotion
   candidates. Before the FINAL review dispatch, `demotionCandidates(member)`
   first checks the maintainer's own session (a local member too: it is
   served by the separately running local apra-fleet server, which can be
   an older build): its tools/list must name `kb_capabilities` (it ships
   with `kb_bible_commit`'s `withdrawals`/`restore_ids`), and that tool's
   `routes` must include `withdraw` (always true for a SQLite KB; for an
   http KB, only when the server serves the route). If either check fails,
   nothing is offered and a WARN names the maintainer and what is missing --
   never a fallback to `kb_demote`. Otherwise it reads every
   CONFIRMED entry citing a file changed on the sprint branch -- not only the
   maintainer's own: the checkout bible view filtered by `files`, merged with
   the maintainer's own CONFIRMED rows (`own_scope: true`) that are not in the
   bible yet. Both reads are wide (`include_stale: true`,
   `exclude_disputed: false`, up to 500 rows); eligibility (not superseded,
   not a user-directive) and relevance (the entry's `source_files` overlap the
   sprint's changed files) are filtered BEFORE the survivors are capped to the
   prompt-sized offer limit. The offered id set is recorded per repository and
   reset at the start of every call, so a failed read never leaves a stale
   offer.
2. **Judge (final verdict).** An offered entry is demoted if and only if its
   claim is false at the sprint branch HEAD -- including when the sprint
   itself made it false. Every offered id belongs in exactly one of
   `kb_demotions: [{id, reason, evidence_files}]` and `kb_holds: [id]`; an id
   in both, or in neither, is recorded as no-verdict and left as it is (the
   engine never stalls or re-dispatches for it). An id is accepted only if it
   was in the final review's own demotion offer, never the promotion offer.
   An id named in more than one of `kb_promotions`, `kb_discards` and
   `kb_demotions` is refused in every list it appears in. `kb_demotions` from
   a round review (which is offered nothing) are logged and dropped.
3. **Record and publish atomically.** An accepted demotion is queued as a
   `kb_bible_commit` withdrawal `{id, note, evidence_files}` (the note is the
   reviewer's reason) and a hold as a `restore_ids` entry; both are sent in
   the SAME pull/commit/push cycle as that round's confirmed `ids` -- never a
   separate pass. The maintainer's local row is not changed. A push failure
   resets and retries with the same load, exactly like a promotion-only
   round. A withdrawal or restore leaves the queue after a successful call,
   skipped ones included (`not_withdrawable` cannot change by retrying).
   Only the tool's own answer counts: a withdrawal is reported as withdrawn
   only when the answer's `withdrawn` list names it, and a restore only when
   its `restored` list does. An answer with no `withdrawn` list (an older
   apra-fleet that drops the unknown key) admitted nothing: a WARN names the
   maintainer, and the PR body lists those ids as "Demotion not recorded"
   (still CONFIRMED after merge).
4. **Relaunch: a hold can restore an earlier withdrawal.** The checkout bible
   view no longer holds an entry this branch withdrew, so the final review is
   also offered every withdrawn tombstone the sprint branch's committed bible
   carries and the base branch's does not (read with `git show` on the
   maintainer), first and marked `withdrawn_on_this_branch`. Holding it sends
   it as `restore_ids`, which lifts that branch-added tombstone and re-adds the
   base entry.
5. **Off switch.** The loop is ON by default. A sprint launched with
   `kb_demotion_loop: "off"` (CLI: `--kb-demotion-loop off`; supervisor launch
   API: `"kbDemotionLoop": "off"` in the `POST /api/sprints` body) offers the
   final reviewer no demotion candidates and drops any `kb_demotions` or
   `kb_holds` returned, so no withdrawal is recorded. The engine logs that the
   loop is disabled and by which setting. Any value other than `on` or `off`
   is rejected at launch with an error naming the value (a 400 from the
   supervisor API); it never falls back silently.
6. **FAIL and abort.** A FAIL verdict seals CONFIRMATIONS only: they are not
   committed, but the final review's withdrawals and restores still are,
   because they are merge-gated (a FAIL branch that never merges carries them
   nowhere). An aborted sprint seals everything. Pending items that never
   reach a pushed bible commit are listed in a WARN at the end of the sprint.
   An abort AFTER the final review (a failed harvest or PR creation) can leave
   withdrawals already pushed on the branch; the [ABORTED] PR body carries
   the same "KB changes on merge" section as a PASS/FAIL body.
   **What the section reports.** At publish and at abort the engine reads, on
   each repository's maintainer, the withdrawn tombstones the sprint branch's
   bible adds over the base's (the same `git show` read as item 4), whatever
   this run offered. Every such tombstone this run did not restore is listed
   under "Merging withdraws"; one with no verdict this run is labelled
   "carried from an earlier run, not re-checked" (never "still CONFIRMED"), so
   the section appears even when this run offered nothing (loop off, a
   support gap, an abort before the final review, more tombstones than the
   offer cap). A branch bible that could not be read (or a maintainer not on
   the sprint branch) is a "Branch tombstones could not be read" line, never
   silence. No-verdict ids are never dropped: past 40 ids, or when the body
   budget is short, the rest is "+K more (run log)".
7. **Knowledge blocks.** An id the final review withdrew is excluded from
   every later dispatch's knowledge block in the same sprint (the harvest
   included), whether or not the bible commit has been pushed yet.
8. **Guard robustness.** Every site that cannot compute a diff or read a
   bible (a failing command, an unreadable file) logs the member and the
   command and degrades to offering less, never to a failed review. The
   candidate read runs inside the same busy/in-flight bracket as other
   maintainer operations, so a dispatch cannot start mid-read.
9. **Over an http KB provider.** `kb_bible_commit` skips the entry merge
   (`bible_skipped`) and the engine drops its confirmation queue for the
   repository, but the tool still writes and commits the withdrawn tombstones
   and restores, which the engine pushes like any bible commit. After the
   branch merges, `kb_import` replays the withdrawals to the KB server
   through its withdraw route.

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

### Older member installs: the `--kb-maintainer` capability gate

A remote member's installed `apra-fleet` may predate the `call --kb-maintainer`
flag. Before the first maintainer call to a remote member, the engine probes
`apra-fleet call --help` on that member and caches the answer per member; the
probe keys on the flag appearing in the usage text. Local members are never
probed (they open the grant in-process).

If the install is too old, the call fails with the typed error
`E-MEMBER-FLEET-TOO-OLD` before any exclude, file transfer or call runs, so no
args file is delivered to the member. If the probe is inconclusive and the call
is then rejected, the same error results and the args-file cleanup still runs.

The failure is not fatal to the sprint: the promote batch and the bible-commit
ids stay queued, and one `[kb-maintainer]` WARNING names the fix (update the
member with `update_member`). Member init also reports a non-gating
`member-fleet-outdated` warning (the `install` step never blocks a sprint) when
the member's version is older than the server version the orchestrator sees, or
when a remote kb_maintainer lacks the flag.
