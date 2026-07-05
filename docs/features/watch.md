# apra-fleet watch -- live member log viewer

Watch fleet members work in real time. `apra-fleet watch` tails the session
transcripts that members produce while running `execute_prompt` (i.e. `claude -p`
and equivalents) and streams them to your terminal, multiplexed and grouped so
you can follow one member, one feature, or the whole fleet at a glance.

## Motivation

A member running `claude -p` is a black box today. The only ways to observe work
are agent-facing and awkward for a human:

- `execute_prompt` blocks and returns a single final blob -- no visibility while it runs.
- `execute_command(long_running=true)` + `monitor_task` gives pollable output, but
  only for shell commands, only when explicitly opted in, and only on demand.

Neither lets a person simply watch a member think.

The enabling insight: the live data already exists on disk. Every Claude/Gemini
session writes a transcript JSONL incrementally as it runs, at a path the server
already computes (`resolveSessionLogPath`) and already tails for stall detection.
`watch` surfaces what is already there. It never touches the dispatch path, needs
no running MCP server, and sends nothing through the LLM conversation -- the
stream is for the human, in a separate terminal.

## Command surface

```
apra-fleet watch                     Follow members. Scope is inferred from context:
                                       - inside a git repo -> members on that repo
                                       - elsewhere         -> the whole fleet
apra-fleet watch <name> [<name>...]  Follow specific members by name
apra-fleet watch --project <dir>     Follow members working on the repo at <dir>
apra-fleet watch --feature <name>    Follow members on one feature (branch)
apra-fleet watch --branch <ref>      Alias of --feature by exact branch name
apra-fleet watch --list              Print the overview and exit (no follow)
apra-fleet watch --tail <n>          Backfill the last n transcript events (default: 0)
apra-fleet watch --verbose | -v      Show full detail (edit diffs, file contents,
                                     commands + output, thinking)
```

## Compact vs verbose

By default the stream is a compact action log -- one line per assistant message
or tool call (`> Edit cart.js`, `assistant: ...`), with thinking and tool
results suppressed for readability. `--verbose` (`-v`) expands each event the way
Claude's own UI does:

- **Edit / NotebookEdit** -> a `-`/`+` diff of old vs new (red/removed, green/added).
- **Write** -> the file content as `+` lines.
- **Bash** -> the full command (`$ ...`) followed by its output.
- **tool results** -> the actual output (file reads, command stdout); errors are
  marked with `!`.
- **thinking** -> the model's reasoning, dimmed.

Detail blocks are capped (20 lines each) with a `... (N more lines)` note so a
single large edit or file dump cannot flood the stream.

The bare command opens with an **overview** (see below), which doubles as the
discovery menu, then follows the in-scope members.

## Follow model: everything in scope, present and future

Like `docker compose logs -f`, `watch` attaches to **every supported member in
scope** and streams whatever each one produces -- now and later. There is no
"active" gate: an idle member is followed silently (its transcript simply does
not grow) and its output appears the moment a dispatch starts. This means a
member that is idle when you launch `watch` is still picked up when it later
begins working -- no flag required. Activity ("working" vs "idle") is computed
only to label the overview, never to decide what gets streamed.

## Three zoom levels

Users never see the word "track". The vocabulary is repo / feature / member:

| Level    | Means to the user                | How it is keyed                     |
|----------|----------------------------------|-------------------------------------|
| Project  | everything on this codebase      | git origin of the member's folder   |
| Feature  | members building one feature     | the member's current git branch     |
| Member   | one agent                        | member name                         |

### Project = git origin, not path

The same repo can live in multiple folders -- a worktree sibling, or a clone on
another machine -- each with a different path. Grouping by folder path would split
one project into several. So membership in a project is decided by **git origin**
(the address a folder was cloned from): folders sharing an origin are the same
project, regardless of their paths or host. Local-only repos with no remote fall
back to path-prefix grouping (`<dir>` and `<dir>-wt/*`).

### Feature = branch

Parallel work in a sprint lives on separate branches (the PM skill calls these
"tracks" internally; the user does not). The branch is what distinguishes one
feature from another within the same repo, so `--feature` filters by branch. When
a PM project is present its `status.md` maps friendly feature names to branches;
without it, branch names are shown directly (usually descriptive enough, e.g.
`feat/checkout-flow`).

## The overview (discovery)

Bare `watch` (and `watch --list`) prints a live, grouped roster so users never
need to know feature or member names in advance:

```
demo-project -- 2 features active

  feat/subtract    (o) doer-1 working: editing add.js     [] reviewer-1 idle
  feat/multiply    (o) doer-2 working: running tests       [] reviewer-2 idle

Follow all, or narrow: apra-fleet watch --feature subtract
```

Run from outside any repo, it widens to the whole fleet, grouped by project then
feature -- the top-level menu. The overview is essentially `fleet_status`
re-grouped by feature, reusing the same member list, icons, and status.

## Following the member, not a file

Across a sprint a member goes through many dispatches; `resume=false` mints a new
session id and therefore a new transcript file. `watch` follows the *member*: it
watches the member's transcript directory and rolls over to the newest session
file as sessions change, so it never gets stuck tailing a finished session while
the member is busy in a new one.

## Display

- **Marker-forward lines.** Each event carries a colored ASCII action marker
  (source is ASCII-only per repo convention, so no box-drawing glyphs):
  - `>` (cyan) -- read-only tools (Read, Grep, Glob, ...)
  - `*` (yellow) -- edits/writes (Edit, Write, NotebookEdit)
  - `$` (green) -- Bash, with the command itself as the body
  - no marker -- assistant prose (shown plain, no "assistant:" label)
  Diff/output detail lines are indented under their action and colored by kind
  (green added, red removed, dim for output/thinking).
- Layout adapts: a single followed member prints full-width without a name
  prefix; multiple members interleave, each line tagged with the member's colored
  icon + name so parallel streams stay attributable (the `docker compose logs -f`
  model).
- A dim `HH:MM:SS` timestamp leads each event line; detail lines align beneath
  without a timestamp.

## Architecture

```
per-member source          normalizer              multiplexer + sink
-----------------          ----------              ------------------
member A transcript --poll--\
member B transcript --poll---+-- event -> one line -- merge, tag, color -- stdout
member C transcript --poll--/     (per provider)
```

- **Standalone.** `watch` is a CLI subcommand in the same family as `secret` /
  `auth` / `update`. It reads `registry.json` directly and tails transcript files
  from disk. No MCP server required.
- **Source.** For each in-scope member, resolve its transcript directory via
  `resolveSessionLogDir(provider, workFolder)`, pick the newest `*.jsonl`, and poll
  it for appended bytes. Re-scan the directory to detect new sessions.
- **Normalizer.** Provider-specific. Claude is implemented (verified against real
  transcripts); other providers fall back to raw passthrough.
- **Sink.** Interleaved, color-prefixed stdout.

## Scope

**v1 (this change)**
- Claude transcript formatting (verified against real session data).
- Local members (transcript files on the same machine), polled from disk.
- Overview, project/feature/member selection, member-following, multiplexed output.
- `__complete` helper for shell completion of member names.

**Deferred**
- Gemini/other providers: Gemini has a resolvable transcript path but its format
  is not yet parsed (raw passthrough); Codex/Copilot/agy have no transcript path
  (`resolveSessionLogPath` throws) and would need `--output-format stream-json`
  stdout capture.
- Remote members: tailing a transcript on a remote host over SSH (`tail -f`).
- Push-based SSE/WebSocket sink and a multi-pane web/TUI.
- PM `status.md` feature-name labeling (branch names shown in the interim).

## Known gotchas

- Provider coverage is Claude-only for rich formatting in v1.
- Output volume: since every member in scope is followed, a broad scope with many
  simultaneously-active members can produce a lot of interleaved output; narrow by
  feature/member. Thinking blocks are suppressed to reduce noise.
- Startup race: a transcript file may not exist for the first moments of a
  dispatch; the poller tolerates a missing file and picks it up when it appears.
- Remote members are listed in the overview but their live stream is not tailed
  in v1 (documented, not silently skipped).
