# Code Intelligence Embeddings (T1.2 spike)

Classification: LOCAL (bundled `--embeddings` flag; local ONNX CPU model, offline
after a one-time ~87 MB model download; no API key required).

Source of truth for T2.3 (embeddings outcome implementation). Investigated
against the installed `gitnexus@1.6.7` on this platform (win32/x64).

## Bottom line

- What works: `npx gitnexus analyze --embeddings` populates embeddings using a
  local ONNX model. No API key, no config file needed for the default path.
  Verified end-to-end: a throwaway repo went from `embeddings: 0` to
  `embeddings: 3` in one run.
- What it needs: a ONE-TIME network download of the embedding model (~87 MB)
  from HuggingFace on first use; cached at `~/.cache/huggingface` and reused
  offline thereafter. CPU-only, runs via the bundled `onnxruntime-node` (ONNX
  1.26.0, already loaded per `gitnexus doctor`).
- Cost: no per-run API cost, no key. First-run cost = one ~87 MB download +
  model load; indexing time is modestly higher than a non-embeddings analyze.
  On this repo scale (~380 files) that is minutes, not hours.
- Platform caveat (not a blocker): on this platform the LadybugDB VECTOR index
  is unavailable, so semantic search runs via exact-scan fallback (capped at
  10000 chunks, `GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT`). Semantic `query` still
  works once embeddings exist; it is just brute-force scan rather than an ANN
  vector index. Wiring `--embeddings` is what T2.3 needs; VECTOR index install
  is a separate, optional offline-extension concern.

## Evidence

### 1. The flag exists on the installed version

`npx gitnexus analyze --help` (gitnexus 1.6.7):

```
--embeddings [limit]   Enable embedding generation for semantic search (off by
                       default). Optional [limit] overrides the 50,000-node
                       safety cap; pass 0 to disable the cap entirely.
--drop-embeddings      Drop existing embeddings on rebuild. By default, an
                       `analyze` without `--embeddings` preserves any embeddings
                       already present in the index.
--embedding-threads <n>          Limit local ONNX embedding CPU threads
--embedding-batch-size <n>       Number of nodes per embedding batch
--embedding-sub-batch-size <n>   Number of chunks per embedding model call
--embedding-device <device>      Embedding device: auto, cpu, dml, cuda, or wasm
```

Embeddings are OFF by default and PRESERVED across a plain `analyze` (only
dropped with `--drop-embeddings`). So wiring the flag is additive and does not
churn embeddings on every re-index.

### 2. `gitnexus doctor` confirms local support on this machine

```
ONNX:     1.26.0
Capabilities
  VECTOR index:     unavailable
  Semantic mode:    exact-scan
  Exact scan limit: 10000 chunks
  Note: LadybugDB VECTOR is disabled on this platform; semantic search uses
        exact scan when embeddings exist.
Embeddings
  Backend:  local
  Device:   auto
  Threads:  4
  Batch:    16 nodes
  Sub-batch:8 chunks
  Support:  local embeddings supported
```

### 3. The model (from installed source)

`dist/mcp/core/embedder.js` (gitnexus 1.6.7):

- `const MODEL_ID = 'Snowflake/snowflake-arctic-embed-xs';` -- a small
  (extra-small) sentence-embedding model, 384 dimensions, `dtype: 'fp32'`.
- Loaded via `@huggingface/transformers` `pipeline('feature-extraction',
  MODEL_ID)`, wrapped in `withHfDownloadRetry(...)`. The model is NOT bundled in
  the package; it is fetched from HuggingFace on first use (per-attempt download
  timeout 5 min, with retries and a circuit breaker -- see
  `dist/core/embeddings/hf-env.js`).
- `getEmbeddingDims()` defaults to 384.

Verified after the test run: the model landed at
`~/.cache/huggingface/Snowflake/snowflake-arctic-embed-xs`, total 87 MB
(`onnx/model.onnx` 90,387,631 bytes + tokenizer files). It was NOT present
before the run, confirming a one-time first-use download.

### 4. End-to-end verification (throwaway repo, not this repo's live index)

A 4-line JS repo indexed with `npx gitnexus analyze --embeddings --index-only`:

- Completed in ~9.5 s (`real 0m11.5s`) including model load.
- `.gitnexus/meta.json` after: `"embeddings": 3` (was 0), and the vectorSearch
  capability flipped from `status: "unavailable"` to `provider: "exact-scan",
  status: "exact-scan"`.
- Output: "Semantic embeddings were generated without a VECTOR index; queries
  will use exact-scan fallback within the configured limit."

`--index-only` was used so no `AGENTS.md` / `CLAUDE.md` markers were injected;
this repo's files were untouched (`git status` clean on those files).

## Remote / EXTERNAL alternative (optional, NOT the classification)

The installed README documents an OPT-IN remote path via env vars (an
OpenAI-compatible `/v1/embeddings` endpoint -- Infinity, vLLM, TEI, llama.cpp,
Ollama, LM Studio, or OpenAI):

```
GITNEXUS_EMBEDDING_URL=http://your-server:8080/v1
GITNEXUS_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
GITNEXUS_EMBEDDING_DIMS=1024        # optional, default 384
GITNEXUS_EMBEDDING_API_KEY=your-key # optional, default "unused"
npx gitnexus analyze . --embeddings
```

When these are unset, local embeddings are used unchanged. This is the EXTERNAL
option if a bigger model is ever wanted; it is not the default and not required.

## Recommendation for T2.3 (LOCAL branch, design D2)

Wire `--embeddings` into the analyze command line: the `/pm index` step
(skills/pm/index.md) and the VERIFY re-index step pass `--embeddings`; document
the flag in skills/pm/index.md; note the one-time model download and the
exact-scan platform caveat here. No API key, no config field, no external
dependency is required for the default local path. (The env-var remote path
above can be a documented opt-in but is out of scope for the LOCAL wiring.)

## T2.3 wiring done

- `skills/pm/index.md` step 3 now runs `npx gitnexus analyze --embeddings`
  (was `npx gitnexus analyze`), and a new "The `--embeddings` flag" section
  documents the local-ONNX classification, the one-time ~87 MB HuggingFace
  download, the OFF-by-default/preserved-unless-`--drop-embeddings` behavior,
  and the win32 exact-scan caveat from this doc.
- `skills/pm/doer-reviewer-loop.md`'s `doer` dispatch template VERIFY step
  (which every PM-dispatched doer agent's checkpoint literally runs) now
  invokes `npx gitnexus analyze --embeddings` instead of the bare command, so
  embeddings get populated/refreshed at every VERIFY re-index, not just at
  initial `/pm init`.
- No `src/` code path builds the `gitnexus analyze` command line -- it is only
  ever invoked by PM-dispatched agents via `execute_command` per the skill
  docs above (the fleet's own gitnexus MCP child process is spawned separately
  as `npx -y gitnexus mcp`, unaffected by this flag). Per the T2.3 decision
  rule (LOCAL branch), no config field, no code change, and no API key were
  needed -- this task was docs + flag plumbing only, as anticipated.

## Cost summary

| Item | Cost |
|------|------|
| API key / per-call fee | None (local model) |
| First-run model download | ~87 MB from HuggingFace, one time, cached |
| Recurring compute | Local CPU (ONNX), a few extra seconds/minutes per analyze |
| Semantic query at read time | Exact-scan (brute force) on this platform; works, capped at 10000 chunks |
