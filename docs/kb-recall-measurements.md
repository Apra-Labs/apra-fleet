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

## Keyword top-5 guard window at the member default limit

### The finding

The keyword top-5 guard (`guardKeywordTop`, `src/services/knowledge/hybrid-rank.ts`)
promised every id in the keyword list's top 5 a place in the first 8 of the
hybrid order, whatever the read's limit. A member's kb_query defaults to
limit 6, so a guarded id moved to position 7 or 8 was cut off before the
caller saw it.

### Measurement

Setup:

- the default model (snowflake-arctic-embed-xs), real document and query
  vectors;
- every option measured through `SqliteProvider.query` (internal
  `keyword_guard` override);
- use_count reset between options.

Column meanings:

- MRR@5 counts a hit beyond rank 5 as 0.
- "R@limit" is recall within the rows the read returned.
- "lose a keyword top-5 hit" counts queries where an id from the
  keyword-only top 5 is missing from the returned rows.

Enriched eval KB:

| limit | guard | real MRR@5 | real R@limit | authored MRR@5 | authored R@limit | lose a keyword top-5 hit |
|---|---|---|---|---|---|---|
| 6 | off | 0.9246 | 0.9762 | 0.8276 | 0.9353 | 112/182 |
| 6 | keep 5 within 8 (old) | 0.9246 | 0.9762 | 0.8326 | 0.9496 | 112/182 |
| 6 | **keep 5 within min(8, limit) (chosen)** | 0.9246 | 0.9762 | 0.8414 | 0.9424 | 0/182 |
| 6 | keep 4 within min(8, limit) | 0.9246 | 0.9762 | 0.8482 | 0.9424 | 84/182 |
| 6 | keep 3 within min(8, limit) | 0.9246 | 0.9762 | 0.8394 | 0.9496 | 103/182 |
| 8 | keep 5 within 8 (old = chosen) | 0.9246 | 0.9762 | 0.8362 | 0.9640 | 0/182 |
| 20 | keep 5 within 8 (old = chosen) | 0.9127 | 1.0000 | 0.8430 | 0.9856 | 0/182 |

Bare bible:

| limit | guard | real MRR@5 | real R@limit | authored MRR@5 | authored R@limit | lose a keyword top-5 hit |
|---|---|---|---|---|---|---|
| 6 | off | 0.8472 | 0.9524 | 0.8347 | 0.9353 | 108/182 |
| 6 | keep 5 within 8 (old) | 0.8520 | 0.9762 | 0.8325 | 0.9424 | 107/182 |
| 6 | **keep 5 within min(8, limit) (chosen)** | 0.8611 | 1.0000 | 0.8276 | 0.9281 | 0/182 |
| 6 | keep 4 within min(8, limit) | 0.8532 | 0.9762 | 0.8306 | 0.9281 | 84/182 |
| 6 | keep 3 within min(8, limit) | 0.8520 | 0.9762 | 0.8311 | 0.9353 | 98/182 |
| 8 | keep 5 within 8 (old = chosen) | 0.8520 | 1.0000 | 0.8325 | 0.9496 | 0/182 |

### Choice

**keep 5 within min(8, limit)** (`keywordGuardFor`).

What it gains:

- The guard keeps its promise inside what the caller receives: 0 queries
  lose a keyword top-5 hit at limit 6, against 107-112 before.
- On the bare bible, real MRR@5 rises from 0.8520 to 0.8611 and real R@6
  from 0.9762 to 1.0000.
- On the enriched set, authored MRR@5 rises from 0.8326 to 0.8414.

What it costs: authored R@6 falls from 0.9424 to 0.9281 on the bare bible
(2 of 139 queries) and from 0.9496 to 0.9424 on the enriched set (1 query).
The authored set measures situations, not recorded traffic, and the guard
is the additive rule that a model never makes keyword results worse. So the
real-traffic gain and the restored guarantee win.

At limit 8 and above nothing changes.

### Multi-situation push blocks

The engine push path (`knowledgeFor`, fleet-sprint `kb.mjs`) asks one
kb_query per situation at limit 8 and merges the lists round-robin to 8
rows (`mergeRankedLists`). The guard does not reach across lists.

This was measured on the description-signal set below (dispatches of n
consecutive situations; default model):

- round-robin as today;
- a keyword-first merge, where each list's keyword top-5 rows go first,
  round-robin, then the rest;
- each situation's own top ceil(8/n).

| situations per dispatch | expected entry in block: round-robin | keyword-first | own top ceil(8/n) | keyword top-5 hits lost: round-robin | keyword-first |
|---|---|---|---|---|---|
| 1 | 0.9209 | 0.9209 | 0.9209 | 0/695 | 0/695 |
| 2 | 0.8551 | 0.8261 | 0.8551 | 364/690 | 121/690 |
| 3 | 0.8188 | 0.7971 | 0.8478 | 415/690 | 305/690 |
| 6 | 0.7391 | 0.7174 | 0.7899 | 489/690 | 461/690 |

**Decision: no guard on the merge.** A block of 8 cannot hold 5 keyword
hits for each of 2 or more situations. Protecting them (keyword-first)
keeps more keyword hits but puts the entry each situation is actually
about in the block less often, at every n. Round-robin already gives every
situation its own head ranks, and each list is guarded inside its own
query.

## Embedded text of engine situations

### The finding

fleet-sprint `roleHints` built a bead situation as
`about to change <symbols> in <paths>, which <title>. <description>. Done
when: <acceptance>`. The KB embeds only the leading `QUERY_EMBED_MAX_CHARS`
(200) characters of a query (`capEmbedText`), so the embedded text was
mostly the symbols/paths phrase plus the title. The description, where a
bead's signal usually is, did not reach the embedder.

### Fix

`roleHints` now builds `<title>. <description>. Done when: <acceptance>.
Changes <symbols> in <paths>`. The title and description lead and reach
the embedder. The symbols and paths go last: they still reach the keyword
search and still travel as the query's anchor files/symbols. File
situations (`about to change <symbols> in <file>`) are unchanged.

This is a query-side change. Stored entry vectors are built from entry
text by `embedding/chunker.ts` (title + summary, cues, content chunks), and
that is unchanged, so no stored vector goes stale and nothing needs
re-embedding.

### Measurement: situations whose signal is in the description

The set has 139 situations, one per authored eval query, built through the
real `roleHints('doer')`. Each bead has:

- a generic title ("Fix the reported failure", ...);
- the authored query as its description, followed by a sentence naming
  invented, unrelated symbols and paths (so the old phrase filled the cap
  the way a real bead's identifiers do);
- a generic acceptance line.

Each situation is queried like `knowledgeFor` does it (situation text plus
its anchor files/symbols), on the enriched eval KB. Result: MRR@5 / R@5.

| situation text | share whose whole description signal is embedded | keyword + anchor (no model) | hybrid arctic-embed-xs (default) | hybrid bge-small-en-v1.5 | hybrid arctic-embed-s |
|---|---|---|---|---|---|
| old: about to change ... which <title>. <description> | 0.0000 | 0.4512 / 0.6331 | 0.1138 / 0.2590 | 0.2675 / 0.5108 | 0.0981 / 0.2734 |
| **new: <title>. <description> ... Changes ...** | 1.0000 | 0.6667 / 0.8345 | **0.7477 / 0.8705** | 0.7116 / 0.8777 | 0.8132 / 0.8993 |

Hybrid MRR on this set is now 0.7477 with the default model (the judge
measured 0.612 on its own description-signal set before the fix; this set
is harsher: 0.1138 before).

### Keyword term bound

A situation longer than `MAX_QUERY_KEYWORD_TERMS` (32) distinct terms keeps
its earliest terms. With the boilerplate prefix gone and the
symbols/paths phrase moved last, "earliest" is now the title and
description. Two smarter-looking bounds were measured on the same set and
both scored lower, because they pull in the noisy tail (acceptance
boilerplate, unrelated identifiers):

| bound (new situation text) | keyword + anchor | hybrid arctic-embed-xs |
|---|---|---|
| **earliest 32 (kept)** | 0.6667 / 0.8345 | 0.7477 / 0.8705 |
| rarest 32 by index document frequency | 0.5980 / 0.7626 | 0.7433 / 0.8633 |
| drop terms no entry holds, then earliest 32 | 0.6096 / 0.7626 | 0.7418 / 0.8633 |

### Bench label

`scripts/kb-query-bench.mjs` reported the engine-situation burst time
divided by the burst size as "per query" milliseconds. That figure is
throughput (amortized cost per query while 6 run together), not a latency:
every query of a burst resolves at about the whole burst time. It is now
reported as `throughput` (ms/query and queries/s), next to the whole-burst
latency.

### How the guard and situation numbers were measured

The real models were downloaded once with the eval's
`APRA_KB_EVAL_ALLOW_DOWNLOAD=1` store into a local folder and read from
there with `APRA_KB_EVAL_MODELS_DIR`. The guard options use the internal
`keyword_guard` query option (not on the kb_query tool schema).
