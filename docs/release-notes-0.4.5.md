# Release notes - 0.4.5 (draft section: semantic search on by default)

## Semantic search is on by default

- The knowledge base now uses semantic search out of the box. On first use the
  server downloads a ~23 MB embedding model in the background. Keyword and
  anchor search serve until the model is ready, and keep serving if the
  download fails.
- First-run cost on upgrade: a ~23 MB download, then about 220 s of one core
  per 630 entries to embed existing entries, and about +143 MB of memory.

## Turning it off, or changing the model

- Ask your assistant to turn it off, or call `kb_setup` with
  `embedding_model` set to `none`, or run `apra-fleet kb embedding none`.
- Switch model: `kb_setup` with `embedding_model` set to a built-in model
  name, or `apra-fleet kb embedding <model name>`. Run `apra-fleet kb embedding`
  with no argument to see the current setting.

## Offline and restricted machines

- `apra-fleet kb model import <folder|archive>` installs the model from a
  local folder or archive (sha256-verified), for machines with no internet.
- When Hugging Face is unreachable the model is fetched from the apra-fleet
  GitHub release instead.
- HTTPS_PROXY, HTTP_PROXY and NO_PROXY are honoured for the download.

## What fleet_status shows

One line, with the state, the reason and the fix, appears when the model is:

- downloading: in progress, keyword and anchor search serve meanwhile;
- failed: the reason, plus `apra-fleet kb model import <folder>` or
  `apra-fleet kb embedding none`;
- off: says it is off and how to change the setting (kb_session_prime adds
  no warning for a deliberate off).

`kbHealth.embedding` in the JSON form carries the same state, reason and fix.
When the model is healthy nothing extra is shown.
