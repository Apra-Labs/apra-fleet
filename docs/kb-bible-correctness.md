# Knowledge bible correctness

How the committed bible (`.fleet/kb-canonical.json`) is kept correct end to end:
what is read, what is written, and which gates stop an out-of-date writer.

## The bible is read and built from the committed blob

- `kb_bible_commit` builds the new bible from the bible committed at HEAD
  (read through the commit-base reader), never from the work-tree file. A
  differing work-tree file is ignored with a WARN and overwritten.
- A trusted-blob record is written only when a commit actually happened and
  HEAD's blob equals the id of the bytes just written.
- A grant `kb_import` without `ref` records trust only when the file equals the
  committed HEAD blob.
- The cold-seed in `kb_session_prime` reads only the HEAD blob, hash-verified.
  With no committed copy, or a failed verification, it seeds nothing and warns.

Rationale: a work-tree bible can drift from what git (and every other clone)
sees; trust and seeding must follow the reviewed, committed bytes.

## Maintainer build gate

`kb_capabilities` reports `fleet_build {version, bible_rules}`. The sprint
engine's commit round refuses a maintainer whose `bible_rules` is below the
required revision, or whose build is missing or unreadable, and keeps the
queued work. The warning names the member, the build seen, the required build
and the upgrade fix. A test pins the engine's required value to the server's
`BIBLE_RULES_REVISION`, so the two cannot drift apart. Bump both together
whenever the bible's write rules change.

Limit: a gate ships with the build that contains it, so it cannot protect the
sprint that builds it. A bible written by an older build can re-add
`provenance.commit` / `provenance.entry_count` and omit the verified-against
trailer.

## Basis mismatch: re-verify, don't silently lose

A `basis_mismatch` skip in `kb_bible_commit` carries `changed_files`. The
engine offers the entry to the next reviewer as a re-verification row. On
CONFIRM, `kb_promote` re-stamps the basis at HEAD and the entry merges. If the
reviewer refuses or retries run out, the entry is dropped from the bible only:
a WARN names the files with a `kb_query` retrieval hint, the local entry is not
deleted or demoted, and the sprint report lists it under "Dropped from the
bible". Promotion stamps only files that are clean at HEAD.

## Final-head recheck and stats

The sprint re-sends its merged ids at the final head before the final-review
candidate read, catching hashes made stale by later commits in the same sprint.
`kb_stats` reports `hash_drifted` (cited files changed since stamping) and
`not_exportable`. Drift counts only entries that pass the export basis
predicate; non-qualifying entries are reported separately, and `fleet_status`
does not advise a bible commit when nothing qualifies.

## Post-harvest recheck

Invariant: every bible entry a branch owns (absent from the base bible, or
different there) carries `source_file_hashes` equal to its cited files'
content at the head that merges.

The final-head recheck runs before the harvest phase, and the harvester's docs
commits come after it. So the harvest phase re-checks the sprint's merged ids
once more, after its own bible commit (`recheckSprintBible('post-harvest
head', { noReviewLeft: true })` in `phases/harvest.mjs`). This is the last KB
step before Publish PR, and nothing that changes the tree runs after it. No
review is left at that point, so a drifted entry cannot be re-verified. It is
dropped from the branch bible (a withdrawal, committed in the same call) with a
WARN that names the id and its changed files. An id the base bible does not
carry (this branch alone added it) is then removed with no tombstone (a
follow-up restore), so a later sprint can capture it again; an id the base
carries keeps its withdrawal. The KB entry itself is neither deleted nor demoted. A drifted hash is never kept, and an entry is re-stamped
only on a re-verification. If the recheck cannot reach `kb_bible_commit` (no
maintainer, a busy maintainer, a failed pull or push), a WARN names the
unchecked ids and says they need re-checking before the branch merges (the
drift check below, and the CI step, cover them). Like every bible commit,
the recheck is a no-op after a FAIL verdict.

## Base merges: the local drift check

Merging the base branch into a KB branch can change a cited file of an entry
the branch owns. The engine is not involved in that merge, so check it locally:

    npm run check:kb-bible-drift -- --base origin/main

The check reads the bible committed at HEAD and the one committed at the
merge-base of HEAD and `--base` (so a base that moved on after your last merge
does not make you own its entries). It takes the entries the branch owns and hashes their cited files at HEAD the
same way `kb_bible_commit` does (the git blob id of `HEAD:<path>`). It exits 1
and names each drifted entry and file (`changed`, `absent` or `no_basis`).
Entries that are identical to the base bible are never reported or touched.
The failure message prints the exact `--restamp` command for the drifted ids.

CI runs the same check on every pull request (`ci.yml`, ubuntu job,
`--base origin/<base branch>`) against the PR merge checkout. It fails only on
entries the PR itself adds or changes, never on entries inherited from the base.

To re-stamp after a base merge, first re-verify each named entry's claim
against the files at HEAD. Then use one of these:

1. Preferred: on the machine whose KB holds the entry, run `kb_promote` on it
   (this re-stamps its basis at HEAD), then `kb_bible_commit {ids: [<id>]}`.
2. Run `npm run check:kb-bible-drift -- --base origin/main --restamp <id>[,<id>]`
   for exactly the ids you re-verified. It rewrites only their
   `source_file_hashes` in the work-tree bible. Review the diff and commit it.

Withdraw an entry whose claim no longer holds; do not re-stamp it. Re-run the
check: it exits 0 once every owned entry matches HEAD.

## Merge driver resilience

The bible merge driver is invoked through a POSIX `sh` guard. If the recorded
path is missing or `sh` exits 126/127, it falls back to `git merge-file` with
conflict markers and a message naming `kb_setup`, then exits 1. `kb_setup`
re-registers a driver whose registration differs and reports `repairedFrom`.

## Tool-list parsing

The engine's tools-list reader accepts a bare array, `{tools}`, a JSON-RPC
envelope, an MCP content wrapper, pretty-printed JSON, and log lines around the
JSON. It retries once, then warns with the member name and the first 200
characters of the raw answer.

## Known gap

The reverification expiry runs after the apply step. If the reviewer's promote
is still queued (pull failed or maintainer busy), the id is reported
dropped/withdrawn although the later commit merges it. The bible ends correct;
only the report wording is wrong.

## Final-review knowledge block excludes demotion candidates

The final reviewer is offered a list of CONFIRMED entries to re-verify for
possible demotion. The same entries must not also appear in that reviewer's
KNOWLEDGE BANK block, or the reviewer is shown each claim twice (once as
trusted context, once as a claim under test).

`kbKnowledgeBlock` accepts an optional `excludeIds` (a Set or an array), and
`blockFor` in the injection layer passes it through. Entries are removed by id
from the raw entry list before the CONFIRMED filter and the
`KB_MAX_KNOWLEDGE_ENTRIES` cap, so a removed entry frees its slot for another
entry. Matching is on raw entries, never rendered text, because a rendered row
carries its id only when its summary was cut.

Only the final-review phase passes it, built from its demotion candidates, on
both the injection path and the legacy priming path. Every other role keeps the
default behaviour. If all entries are removed, the injection path renders the
"No relevant CONFIRMED knowledge-bank entries" variant and the legacy path
renders no block; an empty JSON list is never emitted.
