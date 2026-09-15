# vcs-stderr-corpus.json -- captured REAL git/dolt failure output

`vcs-stderr-corpus.json` is a recorded corpus of verbatim `git` and `bd dolt`
failure output, one or more samples per classification bucket of
`classifyGitFailure` (`fleet-sprint/git-topology.mjs`) and
`classifyDoltFailure` (`fleet-sprint/dolt-sync.mjs`). It is produced by
`record-vcs-stderr.mjs` in this directory and consumed by
`test/helpers/vcs-stderr-corpus.mjs`.

## Why it exists

The whole VCS failure taxonomy is regexes over stderr, and before this corpus
every fixture that exercised it was typed from memory. The tell-tale was
`fatal: unable to access ... Could not resolve host: github.com` -- the `...`
is a human's elision; git has never printed it. Hand-typed fixtures cannot
catch the failure mode that actually costs a sprint: a git or dolt message
**reword** that silently moves a real failure into a different bucket.

The two directions that matter, and what each costs:

- **diverged read as unknown** -- fail-fast is disabled. A genuine
  out-of-turn write stops raising `GitDivergedError`/`DoltDivergedError` and
  instead falls into the bounded self-heal-and-retry path, so a divergence is
  papered over instead of surfaced.
- **diverged read as transient** -- worse: the runner *retries* a divergence,
  turning a hard stop into a retry loop against a remote that will refuse it
  every time.

Both are asserted by direction, not just by equality, in
`git-sync-brackets.test.mjs` and `dolt-sync-brackets.test.mjs`.

## What is recorded

Each sample carries the exact provoking `command`, the `toolVersion` (and
`bdVersion` for dolt samples) it came from, the process `exitCode`, and the
verbatim combined stdout+stderr as `stderr`. Version and date live at the top
of the file under `tools` / `recordedAt`, so a future reword is attributable
to a specific tool release.

Recorded scratch paths (`/var/folders/...`, `/tmp/...`) appear inside sample
text because they are part of the real output. Nothing asserts on them.

Dolt samples are provoked through `bd dolt`, NOT the raw `dolt` CLI: dolt-sync
only ever sees dolt output after bd has wrapped it (`Error 1105: ...` surfaced
from `dolt_pull()`/`dolt_push()`), and the raw CLI wording differs. Recording
the raw CLI would be recording the wrong surface.

## Re-recording

```bash
node packages/apra-fleet-se/test/fixtures/vcs-stderr/record-vcs-stderr.mjs
node packages/apra-fleet-se/test/fixtures/vcs-stderr/record-vcs-stderr.mjs --only=git
node packages/apra-fleet-se/test/fixtures/vcs-stderr/record-vcs-stderr.mjs --print   # dry run
```

Requirements: `git` always; `dolt` and `bd` for the dolt half; network plus
**no ambient git credential helper** for the two `auth` samples (the recorder
neutralizes `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, but a helper injected some
other way will make GitHub answer "Repository not found" instead of asking for
credentials). A sample the recorder could not provoke is reported on stderr,
left out of the file, and the recorder exits 2 -- it never invents text.

The recorder works entirely inside an `os.tmpdir()` scratch directory with its
own bd prefix and `--database`, and removes it afterwards. It does not touch
the clone it is run from.

## Rules

- **Never hand-edit a `stderr` value.** A hand-edited sample is precisely the
  defect this corpus was created to remove. Re-record instead.
- When a re-record changes a sample's verdict, do not "fix" it by editing
  `expect`. A changed verdict means the tool reworded a message the classifier
  depends on: fix the rule table in `fleet-sprint/vcs-providers/` first, then
  re-record.
- Adding a bucket to either classifier means adding a recipe here that
  provokes it for real. The completeness test in `git-sync-brackets.test.mjs`
  / `dolt-sync-brackets.test.mjs` fails if a bucket has no recorded sample.
