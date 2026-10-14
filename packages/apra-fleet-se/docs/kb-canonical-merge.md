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
| present in base, missing from **either** side | deleted; never resurrected from the side that still has it |
| present in all three, unchanged | kept |
| changed by exactly one side | that side's version |
| changed by both sides to the same content | taken, not a conflict |
| changed by both sides differently | **genuine conflict** -- reported, exit 1, nothing written |
| added by one side | kept |
| added by both sides under the same id | de-duplicated, one kept |

Merged output preserves base order first, then ours-only additions, then
theirs-only additions, rewrites `provenance.entry_count`, and keeps the highest
input `version` (a v3 input yields a v3 output).

Tests: `test/merge-kb-canonical.test.mjs`.
