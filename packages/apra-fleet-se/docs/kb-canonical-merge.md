# Merging `.fleet/kb-canonical.json`

`scripts/merge-kb-canonical.mjs` three-way merges the knowledge-bank canonical
export. Use it whenever a rebase/merge conflicts on that file.

Git cannot merge this file usefully: a harvest rewrites the whole export, so a
branch that harvested and a base branch that also harvested differ in thousands
of lines. Git's only offer is a blind whole-file `--ours` / `--theirs`, which
silently discards every entry the losing side captured.

## Use

```bash
# from three git refs (the usual rebase/merge case)
node packages/apra-fleet-se/scripts/merge-kb-canonical.mjs \
  <base-ref> <ours-ref> <theirs-ref> --refs --out .fleet/kb-canonical.json

# or from three files
node packages/apra-fleet-se/scripts/merge-kb-canonical.mjs base.json ours.json theirs.json
```

The merged document goes to `--out` (or stdout); the plain-text summary always
goes to stderr. Exit codes: `0` merged cleanly, `1` genuine conflicts or
duplicate ids (nothing written -- resolve by hand), `2` usage/IO error or an
input entry without an id (nothing written).

Programmatic use: `import { mergeKbCanonical } from '.../merge-kb-canonical.mjs'`
and pass three parsed documents. The function is pure -- no filesystem, no git,
no `process.exit` -- so it can be wired into an automated conflict-resolution
flow later.

## The identity key is `id`, and only `id`

Entries are matched across base/ours/theirs by their `id` (a non-empty string).
There is no title key and no title fallback: two entries with the same title
and different ids are two entries, and a title edit on the same id is an
ordinary content change of that entry.

An earlier version keyed on the trimmed title, because re-exports then re-minted
ids (76.5% id survival vs 99.0% title survival across two consecutive exports).
That no longer holds: kb_import preserves bible ids (`preferredId` in
`src/services/knowledge/bible-import.ts`) and the v3 bible carries them, so an
id survives export, import and re-export. Title matching was itself a defect: a
same-id title edit merged as delete+add, leaving a stale and a corrected copy
under duplicate ids.

Content compared per entry: `type`, `title`, `summary`, `symbols`,
`source_files`, `source_file_hashes` (v3 basis; key order ignored) and
`confidence`. A change to `source_file_hashes` alone is a change, so a
re-verified basis is never silently dropped; the merged entry is the whole entry
of the side whose content was taken, hashes included. `updated_at` is excluded:
it changes on every re-export, so including it would make every entry look
changed by both sides, i.e. an all-conflicts merge.

An input entry without a usable id is malformed input (exit 2, naming the side
and entry index). Two entries sharing an id -- in any input, or in the merged
result -- are reported as a genuine conflict (exit 1); such a document is never
written.

## Merge rules

| situation | result |
| --- | --- |
| present in base, missing from both sides | deleted |
| present in base, missing from one side, unchanged on the other | deleted; never resurrected from the side that still has it |
| present in base, missing from one side, changed by the other | **genuine conflict**, unless the merged tombstones hold the id (then the tombstone wins, see below) |
| present in all three, unchanged | kept |
| changed by exactly one side | that side's version |
| changed by both sides to the same content | taken, not a conflict |
| changed by both sides differently | **genuine conflict** -- reported, exit 1, nothing written |
| added by one side | kept |
| added by both sides under the same id | de-duplicated, one kept |

## Tombstones (`demotions`)

Tombstones are merged by id too. A tombstone's content is the whole object
(`at`, `reason`, `note`, `evidence_files`), carried verbatim.

| situation | result |
| --- | --- |
| in base, removed by both sides | removed |
| in base, removed by one side, unchanged on the other (a re-promotion or a restore cleared it) | removed |
| in base, removed by one side, changed by the other | **genuine conflict** |
| in base, unchanged / changed by exactly one side | base / that side's version |
| changed by both sides to the same content | taken |
| changed by both sides differently | **genuine conflict** |
| added by one side | kept |
| added by both sides, same content | one kept |
| added by both sides, different content | **genuine conflict** |
| a tombstone id also present as an entry after the merge | **the tombstone wins**: the entry is dropped |

So no id ever ends in both `entries` and `demotions`. A tombstone without an
id, or a `demotions` value that is not an array, is malformed input (exit 2);
a tombstone id listed twice in one input is a genuine conflict (exit 1).

## Output form

Merged output is in writer form: entries and tombstones sorted by id (the order
every writer uses), `demotions` omitted when empty, serialized like the exporter
(2-space JSON, non-ASCII escaped, one trailing newline). It drops the legacy `provenance.commit` and
`provenance.entry_count` (current writers no longer emit either; the entry
count is `entries.length`), and keeps the highest input `version` (a v3 input
yields a v3 output).

Tests: `test/merge-kb-canonical.test.mjs`; the tombstone rules are checked
against both implementations (this script and the merge driver below) by
`tests/knowledge/bible-merge-parity.test.ts` at the repository root.

## The local git merge driver

`kb_setup` registers the same merge (implemented in
`src/services/knowledge/bible-merge.ts`, run as `apra-fleet kb merge-driver`)
as a git merge driver in the clone it is run in:

- `git config --local merge.apra-fleet-kb-bible.driver` is set to the absolute
  path of the installed apra-fleet CLI (resolved when kb_setup runs, never via
  shell expansion) followed by `kb merge-driver %O %A %B %P`;
- `.fleet/kb-canonical.json merge=apra-fleet-kb-bible` is added to the clone's
  `info/attributes` (untracked; nothing is added to the repository).

A local `git merge`, `git rebase` or `git cherry-pick` of two bible-changing
branches then resolves the bible by id. On a genuine conflict the driver prints
the conflicting ids, leaves git's own line merge with conflict markers in the
file and exits 1, so git reports the conflict as usual. Re-run kb_setup after
moving or reinstalling apra-fleet: the driver records an absolute path. A clone
where the driver is not registered falls back to git's line merge.

**Hosted merges cannot run it.** A pull request merged on the git server uses
the server's own merge, which never runs a local driver. When the server
reports a conflict on `.fleet/kb-canonical.json`, merge the base branch into the
branch locally in a clone set up by kb_setup (the driver resolves it), or run
this script with `--refs` on the three commits and commit its output, then
check the result with `node scripts/check-kb-canonical.mjs`.

## Validating a merged bible

`node scripts/check-kb-canonical.mjs [path]` (repository root; default
`.fleet/kb-canonical.json`, also `npm run check:kb-canonical`) rejects a bible
no writer would produce: unexpected or missing envelope keys, a wrong format
version, duplicate
or unsorted entry or tombstone ids, an id that is both an entry and a
tombstone, a tombstone whose reason is unknown or whose keys do not fit that
reason, and a file not in the exporter's serialization (2-space JSON,
non-ASCII escaped, one trailing newline). Each problem is printed on its own
line naming the id; the exit code is 1. It runs in `npm test` and as its own
CI step, so a bad merge to the base branch fails loudly.
