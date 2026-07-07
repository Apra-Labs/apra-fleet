# apra-fleet watch -- live member activity viewer

Watch fleet members work in real time. `apra-fleet watch` streams what members
are doing -- both the shell commands Fleet dispatches (any member, local or
remote) and the LLM session's reasoning, tool calls, and output -- to your
terminal, multiplexed and grouped. It is the `docker compose logs -f` model for
your fleet.

## Motivation

A dispatched member is a black box: `execute_prompt` returns a single final blob;
`execute_command` + `monitor_task` is pollable but shell-only and opt-in. Neither
lets a human simply watch members work -- or watch several in parallel, which is
the whole point of a fleet.

## The model: watch what Fleet does, plus the LLM session

Each member runs its **own** agent CLI (Claude) locally on its machine -- the
fleet server is the orchestrator that drives it over ssh2. So a member's LLM
session transcript is written on the **member's own disk**, at
`~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl`, whether the member is
local or remote.

Fleet also records **every dispatch** in a structured JSONL activity log at
`FLEET_DIR/logs/fleet-<pid>.log`, tagged with the member, for `execute_command`,
`execute_prompt`, `send_files`, etc. -- local and remote alike, written locally
at dispatch time with no ssh2 round-trip.

So `watch` merges two kinds of source: the universal activity spine (the fleet
log) plus the rich provider transcript, read from wherever it lives:

| Source | Captures | How `watch` reads it | Members |
|--------|----------|----------------------|---------|
| Fleet activity log | every dispatch: shell commands (+ their output) with exit status, prompt invocations, file transfers | local file tail (`FLEET_DIR/logs/fleet-*.log`) | **all** (local + remote) |
| Provider transcript (local) | the LLM session's reasoning, tool calls, output, edits | local FS, byte-offset tail | **local** Claude members |
| Provider transcript (remote) | same rich session detail | persistent `tail -F` over a dedicated SSH channel | **remote** Claude members |

The fleet log is the **universal spine**; the transcript is **rich enrichment**
layered in whenever a member runs a prompt. Local transcripts are tailed from the
local filesystem; remote transcripts are streamed over a long-lived SSH channel
(push, not poll -- see Architecture).

## Command surface

```
apra-fleet watch                     Follow members (scope inferred from cwd)
apra-fleet watch <name> [<name>...]  Follow specific members by name
apra-fleet watch --project <dir>     Follow members working on the repo at <dir>
apra-fleet watch --feature <name>    Follow members on one feature (branch match)
apra-fleet watch --branch <ref>      Follow members on an exact branch
apra-fleet watch --list              Print the overview and exit (no follow)
apra-fleet watch --tail <n>          Backfill the last n events per member
apra-fleet watch --verbose | -v      Also show the model's thinking/reasoning
                                     (diffs, file contents + output show by default)
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
- `*` (yellow) -- edits/writes; the header carries a size summary,
  e.g. `Edit cart.js (+3 -1)`, `Write notes.md (40 lines)`
- `$` (green) -- shell commands, with the command itself as the body
- no marker -- assistant prose (plain, no "assistant:" label)
- dim `-> exit=0 elapsed=...` -- command lifecycle; error exits render red
- detail lines (edit diffs, written content, command/tool output) indent beneath
  their action, colored by kind (green added, red removed, dim output)

**Default view shows the logs.** Tool/command output, edit diffs, written
content, and multi-line command bodies all render by default. The model's
**thinking/reasoning is the only content reserved for `-v`**.

Single followed member: full-width, no name prefix. Multiple: interleaved, each
line tagged with the member's colored icon + name.

## Architecture

```
fleet log (all members) --------tail--\
local transcripts (local members) -----+-- format -> merge, tag by member, color -> stdout
remote transcripts (remote, ssh) ------/
```

- **Standalone.** A CLI subcommand (like `secret`/`auth`/`update`) that reads
  `registry.json` and tails logs. No MCP server connection required.
- **Fleet-log tailer** (`services/watch/fleet-log.ts`): one poll over the newest
  `fleet-<pid>.log`; each line is attributed to a member by `mid`/`mem` and
  dispatched to that follower. Noise tags (stall ticks, startup) are dropped.
- **Local transcript tailer** (`cli/watch.ts` + `services/watch/transcript-formatter.ts`):
  per local member; byte-offset tail that rolls over to the newest session file
  as sessions change.
- **Remote transcript tailer** (`cli/watch.ts` `ensureRemoteTail` +
  `services/ssh.ts` `execStream`): per remote Claude member, a dedicated
  long-lived SSH `tail -F` channel streams the session `.jsonl` as it is written
  -- no per-tick round-trips. A cheap periodic `ls` (every few poll ticks) only
  reopens a channel that died or follows a session rotation; the first attach
  primes to EOF (`-n0`, no history dump), a rotation reads the new session from
  the top (`-n +1`). The session directory is resolved with
  `encodeClaudeProjectDir` (Claude's real `[^a-zA-Z0-9] -> '-'` path-encoding
  rule), shared with the stall detector.
- Both transcript sources feed the **same** `formatTranscriptLine` renderer, so
  local and remote render identically.

## Scope

**Covered:** all members (local + remote) for command/dispatch activity via the
fleet log; local **and remote** Claude members for the rich LLM-session detail;
overview, project/feature/member selection, default + verbose rendering, marker
styling, shell-completion helper.

**Deferred:**
- Gemini/other-provider transcript parsing, and remote transcript tailing for
  non-Claude providers (fleet-log activity still works for them; only the rich
  LLM detail is Claude-only).
- Push-based SSE/WebSocket sink and a multi-pane web/TUI.
- PM `status.md` feature-name labeling (branch names shown in the interim).

## Known gotchas

- Output volume: a broad scope with many active members interleaves a lot;
  narrow by feature/member. Thinking is verbose-only.
- The fleet log rolls over on server restart (new pid); `watch` re-resolves the
  newest log each poll and follows the rollover.
- Rich LLM detail is Claude-only. A remote member on another provider still shows
  its command/dispatch activity from the fleet log, just not the session detail.
- Backfill (`--tail`) applies to the fleet log and local transcripts; a remote
  transcript starts streaming from the moment `watch` attaches (primes to EOF),
  so it has no history backfill.
- Remote tailing opens one dedicated SSH connection per remote Claude member for
  the lifetime of the `watch`; it is closed cleanly on Ctrl-C. If a member is
  asleep/unreachable the channel simply fails soft and is retried on the next
  check.
