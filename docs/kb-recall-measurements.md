# KB recall measurements

Measured numbers behind KB keyword-ranking choices, so a change can cite
them and a later run can reproduce them. All MRR figures are MRR@5: a hit
beyond rank 5 scores 0. They come from the recall eval:

- test: `tests/knowledge/kb-recall-eval.test.ts`
- helper: `tests/helpers/kb-recall-eval.ts`

The query sets:

- **real**: 42 recorded agent `kb_query` calls, copied verbatim, with
  hand-judged labels (`scripts/kb-recall-queries-real.mjs`).
- **authored**: 139 situation queries, one per CONFIRMED bible entry
  (`scripts/kb-recall-queries-authored.mjs`). Each stays under the leakage
  cap (`scripts/kb-recall-leakage.mjs`).
- **owner-notes**: 1 owner-reported case.

All of them are in `tests/fixtures/kb-recall-eval/queries.json`.

## Data set: the bare bible

`tests/fixtures/kb-recall-eval/bible-bare-live.json` is a pinned copy of
`.fleet/kb-canonical.json` as committed on 2026-11-10. It has 178 entries
with title, summary, symbols and source_files, but no content. The one extra
labelled entry in `extra-entries.json` is added to it. A fresh clone's
keyword search ranks exactly this kind of data. Re-pin it only together
with this document and the floors in the eval test.

## Keyword read: 0.4.5 vs normalized and reweighted

| keyword read | real recall@5 | real MRR@5 | authored recall@5 | authored MRR@5 |
|---|---|---|---|---|
| 0.4.4 / 0.4.5 (raw tokens OR-joined, unweighted bm25 over title, summary, content, tags) | 0.9048 | 0.8103 | 0.8058 | 0.7085 |
| this build (normalized index, bounded query terms, weights below) | 1.0000 | **0.8345** | 0.9281 | **0.8295** |

The original 0.4.4 measurement was 0.7984 real / 0.7097 authored. It was
taken on a slightly different eval KB. The eval measures the old read on
the same kb.sqlite through the legacy `entries_fts` index, which this build
keeps in step. The 0.8345 real MRR matches the reference measurement of
these weights.

## What changed

- **Normalization** (`src/services/knowledge/kb-normalize.ts`): identifiers
  are split on camelCase, PascalCase, acronym runs, `_`, `-` and path
  separators. Every part is Porter-stemmed, and the compact original
  identifier is kept as one more token. The same pipeline runs on the index
  side and on the query side. So `getMemberSplitRead`, "member split read"
  and `kb-self.ts` all match the entry that names them.
- **Index** (`src/services/knowledge/kb-keyword-index.ts`): a new FTS5
  table, `entries_kw`, holds the normalized title, summary, content, tags,
  symbols and source_files.
- **Weights**: title 2, summary 1, content 1, tags 1, symbols 2,
  source_files 1 (`KW_WEIGHTS`). Earlier weights put source_files at 4 and
  title at 5. That cost real MRR on the bare bible (0.7294), because a
  normalized path splits into generic parts (`src`, `servic`, `knowledg`,
  `kb`, `provid`). Most queries contain those parts, so the heavy weight
  lifted entries that merely touch a file above the entry the query was
  about. Lowering source_files to 1 alone recovered the 0.4.4 value. The
  chosen point comes from a grid over the title, summary, symbols and
  source_files weights: it is the highest real MRR whose authored MRR did
  not fall. Weights are bm25 arguments applied at query time, so changing
  one needs no index rebuild.
- **Bounded query terms**: free text keeps the first 32 distinct normalized
  terms (`MAX_QUERY_KEYWORD_TERMS`). Without the bound, a pasted bead
  description ORs 100+ terms into one MATCH. Discrete `fts_terms` (the
  kb_session_prime path) are never bounded.

## Upgrade and rollback

- **Version check on open**: `kb_index_meta.kw_version` carries the index
  version. It is built from the entries_kw layout version and
  `KB_NORMALIZER_VERSION`.
- **Upgrade**: a kb.sqlite from 0.4.5 or older has no version. A KB indexed
  by an older normalizer has a different one. In both cases the index is
  rebuilt from entries on the first open, inside one `BEGIN IMMEDIATE`
  transaction that re-checks the version, so two processes never both
  rebuild. No manual step is needed.
- **Keeping the index current**: plain-SQL triggers on entries queue a
  changed rowid. A use_count bump does not count, because the triggers fire
  only on the indexed columns. Every keyword read drains the queue first,
  so every write path is re-indexed, including writes made by an older
  build on the same file.
- **Rollback**: the legacy `entries_fts` and its triggers are kept and
  stay consistent, so an older build reopening the file keeps answering.
  AUDN candidate lookup still reads `entries_fts`.
- **Test**: `tests/knowledge/kb-keyword-index-upgrade.test.ts` covers all of
  this. It opens a database built from the 0.4.5 schema
  (`tests/fixtures/kb-v045-schema.sql`).

## Member kb_query default: row cap and result size

A MEMBER `kb_query` that omits `limit` returns at most 6 summary rows and no
`l2_expanded` content (`src/tools/kb-query.ts`). An explicit `limit` keeps
the previous full shape.

**Choosing the cap.** The cap was chosen from recall at 6 and at 8 with the
keyword ranking above, on the bare bible. Both cut-offs give the same
recall, so 8 rows would add size with no recall gain:

| query set | recall@5 | recall@6 | recall@8 |
|---|---|---|---|
| real | 1.0000 | 1.0000 | 1.0000 |
| authored | 0.9281 | 0.9281 | 0.9281 |

**Result size.** Size is the length in chars of the `kb_query` JSON
result, for a member session reading the bare bible as its checkout bible,
over the 42 real queries:

- "before" is the previous default read. An explicit `limit: 20` returns
  exactly that shape: 20 full rows plus the L2 content of the top 5.
- "after" is the new default.

| read | median chars | p90 chars |
|---|---|---|
| before (previous default, `limit: 20`) | 27749 | 28484 |
| after (member default) | 4241 | 4451 |

The median drops by 85%.
`tests/knowledge/kb-member-query-defaults.test.ts` measures this. It prints
the numbers and fails when either the median or the p90 is not at least 3x
smaller.

## How to reproduce

`npm test` runs the eval and prints these lines:

```
[kb-recall-eval] keyword real: queries=42 recall@5=... MRR@5=...
[kb-recall-eval] 0.4.5 keyword read real: queries=42 recall@5=... MRR@5=...
```

The test fails when real MRR@5 drops below 0.83, authored MRR@5 drops below
0.82, or either falls to the old read's value.
