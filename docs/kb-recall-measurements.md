# KB recall measurements

Measured numbers behind KB ranking choices, so a change can cite them and a
later run can reproduce them. All MRR figures are MRR@5 (a hit beyond rank 5
scores 0) from the recall eval (`tests/knowledge/kb-recall-eval.test.ts`,
helpers `tests/helpers/kb-recall-eval.ts` and
`tests/helpers/kb-keyword-ablation.ts`). "real" is the 42 recorded agent
queries (`scripts/kb-recall-queries-real.mjs`), "authored" the 139 situation
queries, one per CONFIRMED bible entry.

## Keyword MRR on the bare bible (0.4.5 vs 0.4.4)

### The finding

A judge measured keyword-only MRR on the real queries against a bare bible
at 0.731 on this branch versus 0.810 on 0.4.4, with the cause untraced.

### Data sets

- **bare bible**: `tests/fixtures/kb-recall-eval/bible-bare-live.json`, a
  pinned copy of `.fleet/kb-canonical.json` as committed on 2026-11-10 (178
  entries: title, summary, symbols, source_files; no content, recall_cues or
  error_signatures), plus the one extra labelled entry, imported with NO
  enrichment overlay. This is what a fresh clone's keyword search ranks.
- **enriched eval KB**: the default eval set (`bible-snapshot.json`, 139
  entries, plus `enrichment.json`: recall_cues, error_signatures and real
  captured content for 19 entries).

### Reproduction

| ranking | bare bible real MRR | bare bible authored MRR |
|---|---|---|
| this branch before the fix | 0.7294 | 0.8212 |
| 0.4.4 (real v0.4.4 SqliteProvider, built from the tag) | 0.7984 | 0.7097 |

This matches the judge's 0.731 vs 0.810. The small gap on the 0.4.4 side
comes from the bible having changed between the judge's run and the pin. The
0.4.4 numbers come from the real 0.4.4 code (`tests/helpers/v044-kb-build.ts`
bundles `src` at the `v0.4.4` tag and queries the same kb.sqlite in a child
process). The eval's "0.4.4 keyword read" port is checked against it: same
top 5 for all 182 queries.

On the enriched eval KB the regression did not show: there the pre-fix
ranking was already ahead of 0.4.4 (real 0.9083 vs 0.8849). Enrichment
(content, recall_cues) gives the body columns enough text to outweigh the
identifier columns. A bare bible does not.

### Ablation (one factor at a time)

Each row changes one factor of the pre-fix ranking. The ablation helper
re-implements the keyword read with every factor switchable, and the eval
asserts that its production variant reproduces the provider's keyword-only
order exactly for every query. So the table measures the real code path.

| variant | bare real | bare authored | enriched real | enriched authored |
|---|---|---|---|---|
| pre-fix weights (title 5, summary 3, content 1, tags 1, symbols 4, source_files 4, recall_cues 4, error_signatures 4) | 0.7294 | 0.8212 | 0.9083 | 0.8309 |
| pre-fix, source_files weight 1 | 0.7980 | 0.8236 | 0.9083 | 0.8324 |
| pre-fix, symbols weight 1 | 0.7722 | 0.8255 | 0.9083 | 0.8302 |
| equal weights (every column 1) | 0.8230 | 0.8152 | 0.9167 | 0.8180 |
| pre-fix, 0.4.4 columns only (drop symbols, source_files, recall_cues, error_signatures) | 0.8294 | 0.8267 | 0.9008 | 0.8456 |
| pre-fix, no stemming | 0.7286 | 0.7469 | 0.8690 | 0.7789 |
| pre-fix, no identifier split (camel/snake/kebab/path) | 0.7563 | 0.7969 | 0.9044 | 0.8144 |
| pre-fix, no compact identifier token | 0.7413 | 0.8191 | 0.9083 | 0.8273 |
| pre-fix, no trigram | 0.7294 | 0.8212 | 0.9083 | 0.8309 |
| 0.4.4 keyword read | 0.7984 | 0.7097 | 0.8849 | 0.7600 |
| **fix: title 2, summary 1, content 1, tags 1, symbols 2, source_files 1, recall_cues 1, error_signatures 4** | **0.8345** | **0.8283** | **0.9167** | **0.8348** |

### Cause

**The bm25 weights on the identifier columns.** source_files and symbols were
weighted 4, and title was weighted 5. The normalizer splits a path or
identifier into its parts. `src/services/knowledge/sqlite-provider.ts`
becomes `src servic knowledg sqliteprovid sqlite provid ts`, and those
generic parts appear in most real queries ("KB recall evaluation sqlite
provider query", "embedder model profile"). A weight-4 hit on such a part in
a short, dense column lifted entries that merely touch a file above the
entry the query was about.

The evidence:

- Reverting ONLY the source_files weight (4 -> 1) moves real MRR from 0.7294
  to 0.7980, which is 0.4.4's value.
- Dropping the identifier columns entirely (0.4.4's columns) gives 0.8294.
- Equal weights give 0.8230.

The other suspects are not the cause, because reverting them does not
recover MRR:

- stemming (0.7286)
- identifier splitting (0.7563)
- the compact identifier token (0.7413)
- trigram (0.7294; no effect at all, since trigram hits only fill in below
  every full-token hit)

Removing stemming or splitting costs authored MRR heavily (0.7469 and
0.7969). The shorter bible entries are not an engine factor: both builds rank
the same entries. They explain why the enriched set hid the problem.

### Fix and choice

Keep every column, the normalizer and trigram. Change the weights to title 2,
summary 1, content 1, tags 1, symbols 2, source_files 1, recall_cues 1 and
error_signatures 4 (`KW_WEIGHTS`, `src/services/knowledge/kb-index.ts`).
Weights are bm25 arguments applied at query time, so no index rebuild or
version bump is needed.

The weights were chosen from a grid (`runKeywordAblation` with one weights
variant per grid point) over title {1,2,3,5}, summary {1,2,3},
symbols {1,2,4}, source_files {1,2,4} and recall_cues {1,2,4}, scored on all
three sets (bare real, bare authored, and the enriched sets). The choice
takes the highest bare-real MRR whose authored MRR does not fall below the
pre-fix value on the bare set. It also keeps symbols and source_files
indexed, so a query naming a symbol or file still finds its entry, and the
title-to-symbols ratio of an fts_terms read (kb_session_prime) is unchanged
(1:1). Runner-up candidates:

| weights (title, summary, symbols, source_files, recall_cues) | bare real | bare authored | snapshot bare real | snapshot bare authored | enriched real | enriched authored |
|---|---|---|---|---|---|---|
| 2, 1, 2, 1, 1 (chosen) | 0.8345 | 0.8283 | 0.9107 | 0.8332 | 0.9167 | 0.8348 |
| 1, 1, 2, 1, 1 | 0.8389 | 0.8143 | 0.9087 | 0.8206 | 0.9167 | 0.8216 |
| 3, 1, 1, 1, 1 | 0.8190 | 0.8374 | 0.9107 | 0.8452 | 0.9206 | 0.8402 |
| 1, 1, 1, 1, 1 (equal) | 0.8230 | 0.8152 | 0.9127 | 0.8210 | 0.9167 | 0.8180 |
| pre-fix | 0.7294 | 0.8212 | 0.8798 | 0.8353 | 0.9083 | 0.8309 |

(Snapshot bare = `bible-snapshot.json` with no enrichment.)

### Per-query effect on the real set

Bare bible, pre-fix -> fix (rank of the expected entry, "-" = not in the top
5). Only the queries that moved are listed. **None got worse.**

| query | pre-fix | fix |
|---|---|---|
| kb_bible_commit | 2 | 1 |
| named secret 401 retry credential health lookupServerSecret secret --set | 2 | 1 |
| E-CODE-INDEX-NOT-READY retry polling code_status | 2 | 1 |
| test isolation APRA_FLEET_DATA_DIR temp git repos MCP client HTTP transport | 5 | 4 |
| FTS5 query sanitization orJoin tokenizer SEA build-sea native addon esbuild bundle dependency | 2 | 1 |
| FTS5 orJoinFtsTerms sanitization SqliteProvider query | - | 5 |
| SqliteProvider FTS entries_fts bm25 trigram index rebuild migration | 3 | 2 |
| embedder model profile failure state embedding | 2 | 1 |
| background rebuild claim owner heartbeat two processes kb.sqlite | 5 | 2 |
| embedding blocks event loop member bible view embedder | - | 5 |
| embed worker thread onnxruntime model download deadline | 2 | 1 |
| embedding worker thread model download | 2 | 1 |

On the enriched eval KB, three real queries move:

- "background rebuild claim owner heartbeat two processes kb.sqlite": 5 -> 4
- "embedding blocks event loop member bible view embedder": 2 -> 1
- "test isolation APRA_FLEET_DATA_DIR temp git repos MCP client HTTP
  transport": 5 -> 6, so it leaves the top 5. Its target is matched mostly
  through a path in source_files, which now weighs less. It is still at rank
  6, inside the keyword guard window of 8.

Net on the enriched set: real MRR 0.9083 -> 0.9167, recall@5 1.0000 ->
0.9762, authored MRR 0.8309 -> 0.8348.

### Result

Keyword-only MRR on the bare bible real set is **0.8345**, above 0.4.4's
0.7984 (and the judge's 0.810). Authored MRR on the same set is 0.8283 vs
0.4.4's 0.7097.

### How to reproduce

```
APRA_KB_EVAL_ABLATION=1 npx vitest run tests/knowledge/kb-recall-eval.test.ts
```

This prints the bare-bible keyword-only report, the 0.4.4 comparison and the
ablation table, and cross-checks the 0.4.4 port against the real v0.4.4 build
(skipped with the reason when the `v0.4.4` tag is not fetched). Without the
variable, `npm test` still prints the bare-bible and 0.4.4 MRR lines.
