# apra-fleet watch -- live member activity viewer

Watch fleet members work in real time. `apra-fleet watch` streams what members
are doing -- both the shell commands Fleet dispatches (any member, local or
remote) and, for local members, the LLM session's reasoning and edits -- to your
terminal, multiplexed and grouped. It is the `docker compose logs -f` model for
your fleet.

## Motivation

A dispatched member is a black box: `execute_prompt` returns a single final blob;
`execute_command` + `monitor_task` is pollable but shell-only and opt-in. Neither
lets a human simply watch members work -- or watch several in parallel, which is
the whole point of a fleet.

## The model: watch what Fleet does, plus the local LLM session

In apra-fleet, only the **local** machine runs the LLM (Claude). Remote members
are driven purely by shell commands over the ssh2 client; they never run Claude,
so they have no provider transcript. The observation that makes `watch` work for
*every* member is that **Fleet already records every dispatch locally**: the
server writes a structured JSONL activity log at
`FLEET_DIR/logs/fleet-<pid>.log`, tagged with the member, for `execute_command`,
`execute_prompt`, `send_files`, etc. -- local and remote alike, at dispatch time,
with no ssh2 round-trip.

So `watch` merges two sources:

| Source | Captures | Location | Members |
|--------|----------|----------|---------|
| Fleet activity log | every dispatch: shell commands (+ their output) with exit status, prompt invocations, file transfers | local (`FLEET_DIR/logs/fleet-*.log`) | **all** (local + remote) |
| Provider transcript (`~/.claude/projects/*.jsonl`) | the LLM session's reasoning, edits, tool output | local disk only | **local** members running an LLM |

The fleet log is the **universal spine**; the transcript is **local-only
enrichment** layered in when a local member ran a prompt. Remote members stream
their command activity entirely from the local fleet log -- no remote tailing.

## Command surface

```
apra-fleet watch                     Follow members (scope inferred from cwd)
apra-fleet watch <name> [<name>...]  Follow specific members by name
apra-fleet watch --project <dir>     Follow members working on the repo at <dir>
apra-fleet watch --feature <name>    Follow members on one feature (branch match)
apra-fleet watch --branch <ref>      Follow members on an exact branch
apra-fleet watch --list              Print the overview and exit (no follow)
apra-fleet watch --tail <n>          Backfill the last n events per member
apra-fleet watch --verbose | -v      Show edit diffs, file contents, commands + output, thinking
```

## Three zoom levels

Repo -> feature -> member, no "track" jargon:

- **Project = git origin, not path** -- a repo's worktrees and clones (even on
  other machines) group together instead of splitting.
- **Feature = branch** -- how you isolate one piece of parallel work.
- Bare `watch` prints a grouped overview (project -> feature -> member) that
  doubles as the discovery menu; run outside a repo it widens to the whole fleet.

## Follow model

Attaches to every member in scope and streams present + future activity -- idle
members stream the moment they produce output, no activity gate (the
`docker compose logs -f` model). Activity (working/idle in the overview) is
derived from the fleet log, so it is universal (works for remote members too).

## Display

Marker-forward, ASCII + color (source is ASCII-only per repo convention):

- `>` (cyan) -- read-only tools / prompt dispatch / file transfer
- `*` (yellow) -- edits/writes
- `$` (green) -- shell commands, with the command itself as the body
- no marker -- assistant prose (plain, no "assistant:" label)
- dim `-> exit=0 elapsed=...` -- command lifecycle; error exits render red
- verbose detail (diffs, content, output, thinking) indents beneath its action,
  colored by kind (green added, red removed, dim output)

Single followed member: full-width, no name prefix. Multiple: interleaved, each
line tagged with the member's colored icon + name.

## Architecture

```
fleet log (all members) --tail--\
                                  +-- format -> merge, tag by member, color -> stdout
local transcripts (per member) --/
```

- **Standalone.** A CLI subcommand (like `secret`/`auth`/`update`) that reads
  `registry.json` and tails local files. No MCP server connection required.
- **Fleet-log tailer** (`services/watch/fleet-log.ts`): one poll over the newest
  `fleet-<pid>.log`; each line is attributed to a member by `mid`/`mem` and
  dispatched to that follower. Noise tags (stall ticks, startup) are dropped.
- **Transcript tailer** (`services/watch/transcript-formatter.ts`): per local
  member; rolls over to the newest session file as sessions change.

## Scope

**Covered:** all members (local + remote) for command/dispatch activity via the
fleet log; local Claude members additionally for LLM-session detail; overview,
project/feature/member selection, compact + verbose rendering, marker styling,
shell-completion helper.

**Deferred:**
- Gemini/other-provider transcript parsing (fleet-log activity still works for
  them; only the rich LLM detail is Claude-only).
- Push-based SSE/WebSocket sink and a multi-pane web/TUI.
- PM `status.md` feature-name labeling (branch names shown in the interim).

## Known gotchas

- Output volume: a broad scope with many active members interleaves a lot;
  narrow by feature/member. Thinking is verbose-only.
- The fleet log rolls over on server restart (new pid); `watch` re-resolves the
  newest log each poll and follows the rollover.
