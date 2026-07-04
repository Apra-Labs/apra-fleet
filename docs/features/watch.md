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
apra-fleet watch --all               Include idle members (default: active only)
apra-fleet watch --list              Print the overview and exit (no follow)
apra-fleet watch --tail <n>          Backfill the last n transcript events (default: 0)
```

The bare command opens with an **overview** (see below), which doubles as the
discovery menu, then follows the in-scope members.

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

- Each line is prefixed with the member's icon and name and colored per member,
  so interleaved parallel streams stay legible (the `docker compose logs -f` model).
- Layout adapts: a single followed member prints full-width without prefixes;
  multiple members interleave with prefixes.
- A normalizer collapses verbose transcript events into one-line summaries:
  `> Read requirements.md`, `> Bash: run tests`, `assistant: Done, committed ...`.
  Thinking blocks and tool results are suppressed by default to keep the stream
  readable.

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
- Output volume: a chatty member can flood; narrow by feature/member and rely on
  the default active-only, thinking-suppressed stream.
- Startup race: a transcript file may not exist for the first moments of a
  dispatch; the poller tolerates a missing file and picks it up when it appears.
- Remote members are listed in the overview but their live stream is not tailed
  in v1 (documented, not silently skipped).
