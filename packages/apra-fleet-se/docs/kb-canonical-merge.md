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
goes to stderr. Exit codes: `0` merged cleanly, `1` genuine conflicts (nothing
written -- resolve by hand), `2` usage/IO error.

Programmatic use: `import { mergeKbCanonical } from '.../merge-kb-canonical.mjs'`
and pass three parsed documents. The function is pure -- no filesystem, no git,
no `process.exit` -- so it can be wired into an automated conflict-resolution
flow later.

## The identity key is `title`, not `id` -- do not "fix" this

Entries carry an `id`, which looks like the obvious key. It is not one: `id` is
re-minted per export, not per finding. Measured on two real consecutive exports
of this repo's own canonical file (200 base entries -> 207 later entries):

| identity candidate | survived into the later export |
| --- | --- |
| trimmed `title` | 198/200 (99.0%) |
| `id` | 153/200 (76.5%) |

Of the 198 title-matched entries, **45 had byte-identical content
(summary/symbols/source_files/confidence) yet a different `id`**. An id-keyed
merge would read those 45 as a deletion plus an unrelated addition, duplicating
entries and losing real edits. Before changing the key, re-run that measurement
-- the numbers decide it, not intuition about what an `id` field should mean.

`updated_at` is likewise excluded from the content comparison: it changes on
every re-export, so including it would make every entry look changed by both
sides, i.e. an all-conflicts merge.

## Merge rules

| situation | result |
| --- | --- |
| present in base, missing from **either** side | deleted; never resurrected from the side that still has it |
| present in all three, unchanged | kept |
| changed by exactly one side | that side's version |
| changed by both sides to the same content | taken, not a conflict |
| changed by both sides differently | **genuine conflict** -- reported, exit 1, nothing written |
| added by one side | kept |
| added by both sides under the same title | de-duplicated, one kept |

Merged output preserves base order first, then ours-only additions, then
theirs-only additions, and rewrites `provenance.entry_count`.

Tests: `test/merge-kb-canonical.test.mjs`.
