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
